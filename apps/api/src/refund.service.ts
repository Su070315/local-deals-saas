import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, IsNull, LessThan, Repository } from 'typeorm';
import { Order, OrderStatus, DealPackage, PaymentOutbox, PlatformAccessProfile, Refund, RefundPaymentStage, RefundStatus, SettlementLedgerEntry, SettlementLedgerReversal, Store, SupportTicket, User, Voucher, VoucherStatus } from './domain/entities';
import { calculateServiceFeeFen } from './domain/fee';
import { AuditWriterService } from './audit-writer.service';
import { MerchantAccessService } from './merchant-access.service';
import { PAYMENT_PROVIDER, PaymentProvider, RefundRequest } from './payments/payment-provider';
import { SupportTicketService } from './support-ticket.service';
import { NotificationAudienceService } from './notifications/notification-audience.service';
import type { CustomerIdentity, SupportTicketListItem } from './app-service.core-types';
import { DelayedSettlementService } from './delayed-settlement.service';
import { huifuDelayedSettlementEnabled } from './runtime-config';

const PROCESSING_STALE_MS = 5 * 60_000;
const RECOVERY_BATCH_SIZE = 20;
/** 退款补偿专用 advisory lock id（与 lifecycle 主锁区分，多实例部署时保证只有一个实例扫描退款补偿） */
const REFUND_RECOVERY_LOCK_ID = 7_310_921;
/** 渠道已受理但本地落库失败的最大尝试次数：超过后不再 markFailed（防资金已退却标记 FAILED 的双退风险），转人工核查 */
const MAX_REFUND_SETTLE_ATTEMPTS = 5;
/** 顾客自助退款冷却：同券最近退款记录在冷却窗口内拒绝重复发起，防刷渠道 */
const CUSTOMER_REFUND_COOLDOWN_MS = 30_000;

/**
 * 渠道已受理退款但本地落库失败（如券被并发核销）。
 * 与普通失败区分：资金可能已退，绝不能 markFailed（否则顾客看到失败会重复退款 → 双退）。
 * 抛此异常时退款保持 PROCESSING，交 recoverStale 查单先行确认真实结果。
 */
class RefundAcceptedButUnsettledError extends Error {
  constructor() { super('退款已受理，正在确认到账结果，请稍后查询'); this.name = 'RefundAcceptedButUnsettledError'; }
}

/**
 * 商家当日入账资金不足以覆盖退款：按"当日净流入（当日支付 − 当日已退）< 退款金额"预判，
 * 此时汇付/天阙账户大概率无可用余额，渠道退款会被"可用余额不足"拒绝。提前拦截转线下退款，
 * 避免顾客干等渠道失败、退款状态反复横跳。
 */
class MerchantFundsInsufficientError extends Error {
  constructor() { super('商家当日入账资金不足，退款已转线下处理'); this.name = 'MerchantFundsInsufficientError'; }
}

type RefundExecutionInput = {
  actorId: string;
  customerId?: string;
  reason: string;
  requireFailedRetry?: boolean;
  recoverStaleProcessing?: boolean;
  requireStoreClosed?: boolean;
  expectedStoreId?: string;
  operationId?: string;
  requiredReason?: string;
  /** 售后异常退款/停业补偿关联工单 ID（写入 Refund.ticketId，保证资金流可追溯审批来源） */
  ticketId?: string | null;
};

@Injectable()
export class RefundService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly auditWriter: AuditWriterService,
    private readonly merchantAccess: MerchantAccessService,
    private readonly supportTickets: SupportTicketService,
    private readonly notificationAudience: NotificationAudienceService,
    private readonly delayedSettlement: DelayedSettlementService,
    @Inject(PAYMENT_PROVIDER) private readonly paymentProvider: PaymentProvider,
    @InjectRepository(Voucher) private readonly vouchers: Repository<Voucher>,
    @InjectRepository(Refund) private readonly refunds: Repository<Refund>,
    @InjectRepository(PaymentOutbox) private readonly paymentOutbox: Repository<PaymentOutbox>,
    @InjectRepository(Order) private readonly orders: Repository<Order>,
  ) {}

  refundForCustomer(voucherId: string, customer: CustomerIdentity): Promise<Refund> {
    // #13：顾客自助退款防刷——同券在冷却窗口内已有退款记录则拒绝（失败重试也需等冷却），避免反复触发渠道
    return this.refunds.findOne({ where: { voucherId }, order: { createdAt: 'DESC' } }).then((recent) => {
      if (recent && Date.now() - recent.createdAt.getTime() < CUSTOMER_REFUND_COOLDOWN_MS) throw new BadRequestException('退款正在处理中，请稍后重试');
      return this.execute(voucherId, { actorId: `customer:${customer.id}`, customerId: customer.id, reason: 'CUSTOMER_SELF_SERVICE' });
    });
  }

  async retry(user: User, voucherId: string): Promise<Refund> {
    this.merchantAccess.requirePlatformAccess(user, '重新确认退款', [PlatformAccessProfile.FINANCE]);
    const voucher = await this.vouchers.findOneBy({ id: voucherId });
    if (!voucher) throw new NotFoundException('券不存在');
    const existing = await this.refunds.findOneBy({ voucherId });
    let exceptionTicket: SupportTicket | null = null;
    if (existing?.reason === 'PLATFORM_EXCEPTION_REFUND') exceptionTicket = await this.supportTickets.requireApprovedExceptionRefundForRetry(user, voucherId);
    const refund = await this.execute(voucherId, { actorId: user.id, reason: 'PLATFORM_REFUND_RETRY', requireFailedRetry: true });
    if (exceptionTicket && refund.status === RefundStatus.SUCCEEDED) await this.supportTickets.completeApprovedExceptionRefund(user, exceptionTicket.id, '已重新确认异常退款支付。');
    return refund;
  }

  refundForClosedStore(user: User, voucherId: string): Promise<Refund> {
    this.merchantAccess.requirePlatformAccess(user, '执行门店停业补偿退款', [PlatformAccessProfile.FINANCE]);
    return this.execute(voucherId, { actorId: user.id, reason: 'STORE_CLOSURE_COMPENSATION', requireStoreClosed: true });
  }

  executeStoreClosureCompensationFromBatch(actorId: string, voucherId: string, expectedStoreId: string, operationId: string): Promise<Refund> {
    return this.execute(voucherId, { actorId, reason: 'STORE_CLOSURE_BATCH_COMPENSATION', requiredReason: 'STORE_CLOSURE_BATCH_COMPENSATION', requireStoreClosed: true, expectedStoreId, operationId });
  }

  async executeApprovedException(user: User, ticketId: string, note: string): Promise<{ ticket: SupportTicketListItem; refund: Refund }> {
    const ticket = await this.supportTickets.prepareApprovedExceptionRefund(user, ticketId);
    if (!ticket.voucherId) throw new BadRequestException('该异常退款申请缺少关联券');
    const refund = await this.execute(ticket.voucherId, { actorId: user.id, reason: 'PLATFORM_EXCEPTION_REFUND', ticketId: ticket.id });
    if (refund.status !== RefundStatus.SUCCEEDED) throw new ConflictException('退款正在由另一笔请求确认，请稍后刷新结果');
    const resolved = await this.supportTickets.completeApprovedExceptionRefund(user, ticket.id, note);
    return { ticket: resolved, refund };
  }

  /**
   * 当日资金预检：商家当日净流入（当日已支付订单 − 当日已成功退款）是否不足覆盖本次退款。
   * 口径与经营报表一致（Asia/Shanghai 业务日）。仅作渠道余额的近似代理——
   * 历史留存充足但当日无新入账的商家会被误判（概率低且提示转线下退款，安全方向正确）。
   */
  private async merchantFundsInsufficient(merchantId: string, refundAmountFen: number): Promise<boolean> {
    try {
      const dayStart = new Date(`${this.day()}T00:00:00+08:00`);
      const paidStates = [OrderStatus.PAID, OrderStatus.REFUNDED];
      const [paidRow, refundedRow] = await Promise.all([
        this.orders.createQueryBuilder('order')
          .select('COALESCE(SUM(order.amountFen), 0)', 'total')
          .where('order.merchantId = :merchantId AND order.status IN (:...paidStates) AND order.createdAt >= :dayStart', { merchantId, paidStates, dayStart })
          .getRawOne<{ total: string }>(),
        this.refunds.createQueryBuilder('refund')
          .select('COALESCE(SUM(refund.amountFen), 0)', 'total')
          .where('refund.merchantId = :merchantId AND refund.status = :status AND refund.createdAt >= :dayStart', { merchantId, status: RefundStatus.SUCCEEDED, dayStart })
          .getRawOne<{ total: string }>(),
      ]);
      const paid = Number(paidRow?.total || 0);
      const refunded = Number(refundedRow?.total || 0);
      return paid - refunded < refundAmountFen;
    } catch {
      // 统计失败不阻塞退款：让渠道自行裁决（宁可走渠道也不误伤正常退款）
      return false;
    }
  }

  /**
   * 当日资金不足：退款标记失败（券回滚 UNUSED，可继续使用/核销），
   * 并通知顾客转线下退款、通知商家管理员充值、通知平台运营关注。
   * 顾客收到的消息即"退款失败请联系商家线下退款并核销"。
   */
  private async handleOfflineRefund(prepared: { refund: Refund; voucher: Voucher; order: Order }, input: RefundExecutionInput): Promise<Refund> {
    await this.dataSource.transaction(async (manager) => {
      const refund = await manager.findOne(Refund, { where: { id: prepared.refund.id }, lock: { mode: 'pessimistic_write' } });
      if (!refund || refund.status === RefundStatus.SUCCEEDED || refund.status === RefundStatus.FAILED) return;
      refund.status = RefundStatus.FAILED;
      await manager.save(Refund, refund);
      const voucher = await manager.findOne(Voucher, { where: { id: prepared.voucher.id }, lock: { mode: 'pessimistic_write' } });
      if (voucher?.status === VoucherStatus.REFUND_PENDING) {
        voucher.status = VoucherStatus.UNUSED;
        await manager.save(Voucher, voucher);
      }
      await this.auditWriter.write(input.actorId, refund.merchantId, 'VOUCHER_REFUND_FUNDS_INSUFFICIENT', 'Refund', refund.id,
        { status: RefundStatus.PROCESSING }, { status: RefundStatus.FAILED, note: '商家当日入账资金不足，退款转线下处理（顾客线下退款后核销券）' }, manager);
    });
    // 顾客：退款失败，请线下联系商家退款
    await this.notificationAudience.customerInbox(this.dataSource.manager, prepared.voucher.customerId, {
      eventType: 'REFUND_FAILED',
      templateKey: 'refund-failed-funds-insufficient',
      merchantId: prepared.order.merchantId,
      resourceType: 'Refund',
      resourceId: prepared.refund.id,
      payload: { refundId: prepared.refund.id, voucherId: prepared.voucher.id, status: RefundStatus.FAILED, amountFen: prepared.voucher.faceValueFen, offline: true },
      dedupeKey: `refund:${prepared.refund.id}:insufficient`,
    });
    // 商家管理员：请充值或线下处理
    await this.notificationAudience.merchantAdmins(this.dataSource.manager, prepared.order.merchantId, {
      eventType: 'REFUND_FUNDS_INSUFFICIENT',
      templateKey: 'refund-funds-insufficient-merchant',
      merchantId: prepared.order.merchantId,
      resourceType: 'Refund',
      resourceId: prepared.refund.id,
      payload: { refundId: prepared.refund.id, voucherId: prepared.voucher.id, amountFen: prepared.voucher.faceValueFen, orderNo: prepared.order.orderNo },
      dedupeKey: `refund:${prepared.refund.id}:insufficient:merchant`,
    });
    // 平台运营：关注该商家资金风险
    await this.notificationAudience.platformAdmins(this.dataSource.manager, [PlatformAccessProfile.OPERATIONS, PlatformAccessProfile.FINANCE], {
      eventType: 'REFUND_FUNDS_INSUFFICIENT',
      templateKey: 'refund-funds-insufficient-platform',
      merchantId: prepared.order.merchantId,
      resourceType: 'Refund',
      resourceId: prepared.refund.id,
      payload: { refundId: prepared.refund.id, voucherId: prepared.voucher.id, amountFen: prepared.voucher.faceValueFen, orderNo: prepared.order.orderNo },
      dedupeKey: `refund:${prepared.refund.id}:insufficient:platform`,
    });
    // 抛给前端：顾客看到明确提示（errorHandler 展示 message），券保持 UNUSED 可继续使用/由商家线下核销
    throw new ServiceUnavailableException('退款失败：商家当日入账资金不足，请联系商家线下退款并核销');
  }

  async recoverStale(): Promise<{ recovered: number; failed: number }> {
    // B2：advisory lock 防多实例并发扫描同一批退款（单实例时无副作用）
    const queryRunner = this.dataSource.createQueryRunner();
    try {
      await queryRunner.connect();
      const locked = await queryRunner.query('SELECT pg_try_advisory_lock($1) AS locked', [REFUND_RECOVERY_LOCK_ID]);
      const acquired = Array.isArray(locked) && locked[0] && (locked[0] as Record<string, unknown>).locked === true;
      if (!acquired) return { recovered: 0, failed: 0 };
    } catch {
      await queryRunner.release().catch(() => undefined);
      return { recovered: 0, failed: 0 };
    }
    try {
      const staleBefore = new Date(Date.now() - PROCESSING_STALE_MS);
      const candidates = await this.refunds.find({
        where: [{ status: RefundStatus.PROCESSING, lastAttemptAt: IsNull() }, { status: RefundStatus.PROCESSING, lastAttemptAt: LessThan(staleBefore) }],
        order: { lastAttemptAt: 'ASC', createdAt: 'ASC' },
        take: RECOVERY_BATCH_SIZE,
      });
      let recovered = 0;
      let failed = 0;
      for (const refund of candidates) {
        try {
          // 查单先行：渠道可能已受理（回调丢失），先主动查退款结果落终态，避免重复退款
          const queried = await this.reconcileStaleRefund(refund);
          if (queried === 'DONE' || queried === 'WAITING') { if (queried === 'DONE') recovered += 1; continue; }
          const result = await this.execute(refund.voucherId, { actorId: 'system', reason: 'SYSTEM_REFUND_RECOVERY', recoverStaleProcessing: true });
          if (result.status === RefundStatus.SUCCEEDED) {
            recovered += 1;
            // #1：异常退款工单结案——补偿路径退款成功后联动结案，防工单永卡 OPEN+APPROVED
            await this.closeExceptionTicketIfAny(result);
          }
        } catch { failed += 1; }
      }
      return { recovered, failed };
    } finally {
      await queryRunner.query('SELECT pg_advisory_unlock($1)', [REFUND_RECOVERY_LOCK_ID]).catch(() => undefined);
      await queryRunner.release().catch(() => undefined);
    }
  }

  /** 对 PROCESSING 超时退款先查单：明确成功/失败才收敛；处理中或查询失败保持等待，禁止立即重提。 */
  private async reconcileStaleRefund(refund: Refund): Promise<'DONE' | 'WAITING' | 'RETRY_SUBMIT'> {
    const order = await this.dataSource.getRepository(Order).findOneBy({ id: refund.orderId });
    if (!order) return 'WAITING';
    const route = await this.paymentOutbox.findOneBy({ orderId: order.id });
    if (!route) return 'WAITING';
    let request: RefundRequest = {
      voucherId: refund.voucherId, orderId: order.id, orderNo: order.orderNo, amountFen: refund.amountFen,
      idempotencyKey: refund.id, paymentProfileId: route.paymentProfileId || null, providerMerchantId: route.providerMerchantId || null, provider: route.provider || null,
      orderCreatedAt: order.createdAt,
    };
    const confirmedDelayed = huifuDelayedSettlementEnabled()
      && await this.delayedSettlement.confirmedForVoucher(refund.voucherId);
    const queryRefund = this.paymentProvider.queryRefund;
    if (confirmedDelayed && [RefundPaymentStage.CONFIRM_REFUND_PENDING, RefundPaymentStage.CONFIRM_REFUND_PROCESSING].includes(refund.paymentStage)) {
      const confirmationContext = await this.delayedSettlement.confirmationContextForVoucher(refund.voucherId);
      if (!confirmationContext) return 'WAITING';
      const confirmationRequest: RefundRequest = {
        ...request,
        delayedSettlementReference: confirmationContext.paymentReference,
        confirmationRequestSeq: refund.confirmationRequestSeq || confirmationContext.confirmationRequestSeq,
        confirmationRequestDate: refund.confirmationRequestDate || confirmationContext.confirmationRequestDate,
        acctSplitBunch: confirmationContext.acctSplitBunch,
        confirmRefundRequestSeq: refund.confirmRefundRequestSeq || `cr${refund.id.replace(/[^A-Za-z0-9]/g, '').slice(0, 28)}`,
        confirmRefundRequestDate: refund.confirmRefundRequestDate || refund.createdAt,
      };
      await this.persistRefundIdentifiers(refund.id, confirmationRequest);
      const confirmation = await this.paymentProvider.queryConfirmRefund(confirmationRequest);
      if (!confirmation || confirmation.status === RefundStatus.PROCESSING) return 'WAITING';
      if (confirmation.status === RefundStatus.FAILED) {
        await this.markFailed(refund.id, 'system');
        return 'DONE';
      }
      await this.markRefundStage(refund.id, RefundPaymentStage.CONFIRM_REFUND_SUCCEEDED, confirmation.providerPaymentReference || undefined);
      return 'RETRY_SUBMIT';
    }
    if (confirmedDelayed && refund.paymentStage === RefundPaymentStage.CONFIRM_REFUND_SUCCEEDED) return 'RETRY_SUBMIT';
    if (confirmedDelayed && [RefundPaymentStage.ORDINARY_REFUND_PENDING, RefundPaymentStage.ORDINARY_REFUND_PROCESSING].includes(refund.paymentStage)) {
      if (!queryRefund) return 'WAITING';
      const result = await queryRefund(request);
      if (!result || result.status === RefundStatus.PROCESSING) return 'WAITING';
      if (result.status === RefundStatus.FAILED) { await this.markFailed(refund.id, 'system'); return 'DONE'; }
      try {
        await this.finalize(refund.id, result.providerPaymentReference || refund.paymentReference || `refund-${refund.id.slice(0, 8)}`, 'system');
        await this.delayedSettlement.markRefundedForVoucher(refund.voucherId, result.providerPaymentReference || refund.paymentReference || `refund-${refund.id.slice(0, 8)}`);
        await this.closeExceptionTicketIfAny(refund);
        return 'DONE';
      } catch {
        return 'WAITING';
      }
    }
    if (!queryRefund) return 'WAITING';
    const result = await queryRefund(request);
    if (!result || result.status === RefundStatus.PROCESSING) return 'WAITING';
    if (result.status === RefundStatus.SUCCEEDED) {
      // 渠道已退成功：落终态（复用 finalize 逻辑，paymentReference 用查单返回值或原记录）
      const actorId = 'system';
      try {
        await this.finalize(refund.id, result.providerPaymentReference || refund.paymentReference || `refund-${refund.id.slice(0, 8)}`, actorId);
        if (huifuDelayedSettlementEnabled()) await this.delayedSettlement.markRefundedForVoucher(refund.voucherId, result.providerPaymentReference || refund.paymentReference || `refund-${refund.id.slice(0, 8)}`);
        // #1：异常退款工单结案——查单确认成功后联动结案
        await this.closeExceptionTicketIfAny(refund);
        return 'DONE';
      } catch {
        // B1：finalize 冲突（券状态被并发核销等）——渠道确认已退款但本地无法落终态，
        // 必须留审计痕迹供人工核查（勿静默吞掉），并保持 PROCESSING 交下一轮再尝试
        try {
          await this.auditWriter.write(actorId, refund.merchantId, 'VOUCHER_REFUND_RECONCILE_CONFLICT', 'Refund', refund.id, { status: refund.status }, { status: refund.status, note: '渠道确认退款成功但本地落库冲突，待人工核查' });
        } catch { /* 审计写入失败不阻塞补偿 */ }
        return 'WAITING';
      }
    }
    if (result.status === RefundStatus.FAILED) {
      await this.markFailed(refund.id, 'system');
      return 'DONE';
    }
    return 'WAITING'; // PROCESSING：渠道仍在处理，下轮再查
  }

  /** #1：异常退款工单结案联动——补偿/重试路径渠道确认退款成功后，把工单从 OPEN+APPROVED 落为 RESOLVED。 */
  private async closeExceptionTicketIfAny(refund: Refund): Promise<void> {
    if (refund.reason !== 'PLATFORM_EXCEPTION_REFUND' || !refund.ticketId) return;
    try {
      await this.supportTickets.completeApprovedExceptionRefundBySystem(refund.ticketId, '退款已由补偿任务确认成功。');
    } catch { /* 工单结案失败不阻塞退款主流程，下轮轮询再试 */ }
  }

  private async execute(voucherId: string, input: RefundExecutionInput): Promise<Refund> {
    const prepared = await this.prepare(voucherId, input);
    if (!prepared.paymentRequired) return prepared.refund;
    const route = await this.paymentOutbox.findOneBy({ orderId: prepared.order.id });
    // M5：无支付意图记录的订单拒绝自动退款并转人工，避免默认路由错误渠道
    if (!route) throw new ServiceUnavailableException('原支付订单缺少支付意图记录，请转人工处理退款');
    if (this.paymentProvider.requiresMerchantProfile && (!route.paymentProfileId || !route.providerMerchantId || route.provider !== this.paymentProvider.providerName)) {
      throw new ServiceUnavailableException('原支付订单缺少有效的商家支付路由');
    }
    // 汇付延迟交易在未核销/未确认前，资金仍在延迟户；普通退款应从延迟户原路退回，
    // 不要求商户基本户有当日入账。此时用"当日净流入"代理余额会把跨日退款误拦截。
    const delayedUnconfirmedRefund = huifuDelayedSettlementEnabled()
      && String(route.provider || '').toUpperCase() === 'HUIFU'
      && !prepared.voucher.verificationId
      && await this.delayedSettlement.hasTransactionForOrder(prepared.order.id);
    // 当日资金预检仅适用于普通渠道或已进入确认/分账流程的退款。
    if (!delayedUnconfirmedRefund && await this.merchantFundsInsufficient(prepared.order.merchantId, prepared.voucher.faceValueFen)) {
      return this.handleOfflineRefund(prepared, input);
    }
    try {
    const canUseDelayedTwoStage = huifuDelayedSettlementEnabled()
      && Boolean(prepared.voucher.verificationId)
      && await this.delayedSettlement.confirmedForVoucher(prepared.voucher.id);
    let paymentRequest: RefundRequest = { voucherId, orderId: prepared.order.id, orderNo: prepared.order.orderNo, amountFen: prepared.voucher.faceValueFen, idempotencyKey: prepared.refund.id, paymentProfileId: route.paymentProfileId || null, providerMerchantId: route.providerMerchantId || null, provider: route.provider || null, orderCreatedAt: prepared.order.createdAt };
    let payment: { paymentReference: string };
    let ordinaryRefundAllowed = !canUseDelayedTwoStage;
    if (canUseDelayedTwoStage) {
      const stage = prepared.refund.paymentStage;
      if (stage === RefundPaymentStage.DIRECT) {
        const confirmationContext = await this.delayedSettlement.confirmationContextForVoucher(prepared.voucher.id);
        if (!confirmationContext) throw new ServiceUnavailableException('已确认延迟交易缺少确认快照，请转人工核查');
        paymentRequest = {
          ...paymentRequest,
          delayedSettlementReference: confirmationContext.paymentReference,
          confirmationRequestSeq: confirmationContext.confirmationRequestSeq,
          confirmationRequestDate: confirmationContext.confirmationRequestDate,
          acctSplitBunch: confirmationContext.acctSplitBunch,
          confirmRefundRequestSeq: prepared.refund.confirmRefundRequestSeq || `cr${prepared.refund.id.replace(/[^A-Za-z0-9]/g, '').slice(0, 28)}`,
          confirmRefundRequestDate: prepared.refund.confirmRefundRequestDate || prepared.refund.createdAt,
        };
        await this.persistRefundIdentifiers(prepared.refund.id, paymentRequest);
        await this.markRefundStage(prepared.refund.id, RefundPaymentStage.CONFIRM_REFUND_PENDING);
        const confirmationRefund = await this.paymentProvider.confirmRefund(paymentRequest);
        if (confirmationRefund.status === 'PROCESSING') {
          await this.markRefundStage(prepared.refund.id, RefundPaymentStage.CONFIRM_REFUND_PROCESSING, confirmationRefund.paymentReference || undefined);
          throw new ServiceUnavailableException('确认退款正在处理中，请稍后查询');
        }
        if (confirmationRefund.status === 'FAILED' || !confirmationRefund.paymentReference) {
          await this.markFailed(prepared.refund.id, input.actorId);
          throw new ServiceUnavailableException('确认退款失败，请稍后重试');
        }
        await this.markRefundStage(prepared.refund.id, RefundPaymentStage.CONFIRM_REFUND_SUCCEEDED, confirmationRefund.paymentReference);
        ordinaryRefundAllowed = true;
      } else if ([RefundPaymentStage.CONFIRM_REFUND_PENDING, RefundPaymentStage.CONFIRM_REFUND_PROCESSING].includes(stage)) {
        throw new ServiceUnavailableException('确认后退款正在确认中，请稍后由补偿任务查询');
      } else if ([RefundPaymentStage.CONFIRM_REFUND_SUCCEEDED, RefundPaymentStage.ORDINARY_REFUND_PENDING].includes(stage)) {
        ordinaryRefundAllowed = true;
      } else if (stage === RefundPaymentStage.ORDINARY_REFUND_PROCESSING) {
        throw new ServiceUnavailableException('普通退款正在处理中，请稍后查询');
      }
    }
    if (!ordinaryRefundAllowed) throw new ServiceUnavailableException('退款阶段未完成，请稍后查询');
    if (canUseDelayedTwoStage) await this.markRefundStage(prepared.refund.id, RefundPaymentStage.ORDINARY_REFUND_PROCESSING);
    payment = await this.paymentProvider.refund(paymentRequest);
    const paymentReference = payment.paymentReference;
      try {
        const finalized = await this.finalize(prepared.refund.id, paymentReference, input.actorId, input.operationId);
        if (huifuDelayedSettlementEnabled() && prepared.voucher.verificationId) await this.delayedSettlement.markRefundedForVoucher(prepared.voucher.id, paymentReference);
        return finalized;
      } catch {
        // 渠道已受理但本地落库失败（如券被并发核销）：保持原状态（PROCESSING）交 recoverStale 查单，
        // 勿回退 FAILED，避免"资金已退、系统却 FAILED"的状态错乱（顾客重复退款 → 双退）
        throw new RefundAcceptedButUnsettledError();
      }
    } catch (error) {
      // 渠道已受理的资金风险异常：不 markFailed，保持 PROCESSING 由补偿查单确认真实结果
      if (error instanceof RefundAcceptedButUnsettledError) throw error;
      const currentRefund = await this.refunds.findOneBy({ id: prepared.refund.id });
      // 确认退款已成功但常规退款尚未完成时，绝不能把退款标记 FAILED；
      // 下轮补偿必须继续查询/重试普通退款，避免资金已回到延时账户而本地诱导重复操作。
      if (currentRefund?.paymentStage === RefundPaymentStage.CONFIRM_REFUND_PENDING
        || currentRefund?.paymentStage === RefundPaymentStage.CONFIRM_REFUND_PROCESSING) {
        throw new ServiceUnavailableException('确认退款结果尚未明确，请稍后由补偿任务查询');
      }
      if (currentRefund?.paymentStage === RefundPaymentStage.CONFIRM_REFUND_SUCCEEDED
        || currentRefund?.paymentStage === RefundPaymentStage.ORDINARY_REFUND_PENDING
        || currentRefund?.paymentStage === RefundPaymentStage.ORDINARY_REFUND_PROCESSING) {
        throw new ServiceUnavailableException('确认退款已完成，普通退款正在确认中，请稍后查询');
      }
      // #4：渠道受理但落库失败的尝试收敛——超过上限后不再 markFailed（资金可能已退，标记 FAILED 会诱导顾客重复退款=双退），
      // 转人工核查告警并保持 PROCESSING 由查单补偿继续确认真实渠道状态
      if ((prepared.refund.attemptCount || 0) >= MAX_REFUND_SETTLE_ATTEMPTS) {
        try {
          await this.auditWriter.write(input.actorId, prepared.refund.merchantId, 'VOUCHER_REFUND_NEEDS_MANUAL_REVIEW', 'Refund', prepared.refund.id, { status: prepared.refund.status, attemptCount: prepared.refund.attemptCount }, { status: prepared.refund.status, note: '渠道退款受理状态未确认且多次落库失败，请人工核查' });
        } catch { /* 审计失败不阻塞 */ }
        throw new ServiceUnavailableException('退款正在由平台核查，请稍后查询');
      }
      await this.markFailed(prepared.refund.id, input.actorId);
      throw new ServiceUnavailableException('退款支付暂未确认，请稍后重试');
    }
  }

  private async prepare(voucherId: string, input: RefundExecutionInput): Promise<{ refund: Refund; voucher: Voucher; order: Order; paymentRequired: boolean }> {
    return this.dataSource.transaction(async (manager) => {
      const voucher = await manager.findOne(Voucher, { where: { id: voucherId }, lock: { mode: 'pessimistic_write' } });
      if (!voucher || (input.customerId && voucher.customerId !== input.customerId)) throw new NotFoundException('券不存在');
      if (input.expectedStoreId && voucher.storeId !== input.expectedStoreId) throw new ConflictException('券的当前核销门店已变化，请刷新后重试');
      const existing = await manager.findOne(Refund, { where: { voucherId }, lock: { mode: 'pessimistic_write' } });
      const order = await manager.findOneByOrFail(Order, { id: voucher.orderId });
      if (existing && input.requiredReason && existing.reason !== input.requiredReason) throw new ConflictException('该券已由其他退款流程处理，不能并入当前批量补偿任务');
      if (input.requireStoreClosed) {
        const store = await manager.findOneBy(Store, { id: voucher.storeId, merchantId: voucher.merchantId });
        if (!store || store.openForVerification) throw new BadRequestException('该券当前门店仍可履约，不能按停业补偿退款');
      }
      if (input.requireFailedRetry && existing?.status !== RefundStatus.FAILED) throw new BadRequestException('当前退款不需要平台重新确认');
      if (existing?.status === RefundStatus.SUCCEEDED) return { refund: existing, voucher, order, paymentRequired: false };
      if (input.recoverStaleProcessing && existing && existing.status !== RefundStatus.PROCESSING) return { refund: existing, voucher, order, paymentRequired: false };
      const attemptedAt = new Date();
      if (!existing) {
        if (voucher.status !== VoucherStatus.UNUSED || this.day(voucher.validTo) < this.day()) throw new BadRequestException('当前券不支持退款');
        const refund = await manager.save(Refund, { voucherId, orderId: order.id, merchantId: voucher.merchantId, amountFen: voucher.faceValueFen, reason: input.reason, ticketId: input.ticketId ?? null, status: RefundStatus.PROCESSING, paymentReference: null, lastAttemptAt: attemptedAt, attemptCount: 1 });
        const before = { status: voucher.status };
        voucher.status = VoucherStatus.REFUND_PENDING;
        await manager.save(Voucher, voucher);
        await this.auditWriter.write(input.actorId, voucher.merchantId, 'VOUCHER_REFUND_PROCESSING', 'Voucher', voucher.id, before, { status: voucher.status, refundId: refund.id, reason: input.reason, operationId: input.operationId || null }, manager);
        return { refund, voucher, order, paymentRequired: true };
      }
      // 券状态一致性：正常处理中（PROCESSING）券必须冻结在 REFUND_PENDING；
      // 但退款失败（FAILED）后 markFailed 会把券回滚为 UNUSED——此时允许以 UNUSED 状态重试（下方 FAILED 分支会恢复冻结）
      if (voucher.status !== VoucherStatus.REFUND_PENDING && !(existing.status === RefundStatus.FAILED && voucher.status === VoucherStatus.UNUSED)) throw new ConflictException('退款记录与券状态不一致，请联系平台处理');
      if (existing.status === RefundStatus.PROCESSING) {
        const staleBefore = new Date(Date.now() - PROCESSING_STALE_MS);
        if (!input.recoverStaleProcessing || (existing.lastAttemptAt && existing.lastAttemptAt > staleBefore)) return { refund: existing, voucher, order, paymentRequired: false };
        const before = { status: existing.status, attemptCount: existing.attemptCount };
        existing.lastAttemptAt = attemptedAt;
        existing.attemptCount = Math.max(0, existing.attemptCount || 0) + 1;
        await manager.save(Refund, existing);
        await this.auditWriter.write(input.actorId, voucher.merchantId, 'VOUCHER_REFUND_STALE_RECOVERY_STARTED', 'Refund', existing.id, before, { status: existing.status, attemptCount: existing.attemptCount }, manager);
        return { refund: existing, voucher, order, paymentRequired: true };
      }
      if (existing.status === RefundStatus.FAILED) {
        // 退款失败后券已回滚 UNUSED（markFailed 语义）：重试前恢复 REFUND_PENDING 冻结态，防止重试期间被并发核销
        if (voucher.status === VoucherStatus.UNUSED) {
          const vBefore = { status: voucher.status };
          voucher.status = VoucherStatus.REFUND_PENDING;
          await manager.save(Voucher, voucher);
          await this.auditWriter.write(input.actorId, voucher.merchantId, 'VOUCHER_REFUND_RETRY_FREEZE', 'Voucher', voucher.id, vBefore, { status: voucher.status, refundId: existing.id }, manager);
        }
        const before = { status: existing.status };
        existing.status = RefundStatus.PROCESSING;
        existing.lastAttemptAt = attemptedAt;
        existing.attemptCount = Math.max(0, existing.attemptCount || 0) + 1;
        await manager.save(Refund, existing);
        await this.auditWriter.write(input.actorId, voucher.merchantId, 'VOUCHER_REFUND_RETRIED', 'Refund', existing.id, before, { status: existing.status, attemptCount: existing.attemptCount }, manager);
        return { refund: existing, voucher, order, paymentRequired: true };
      }
      throw new ConflictException('退款记录状态无效，请联系平台处理');
    });
  }

  private async markFailed(refundId: string, actorId: string): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const refund = await manager.findOne(Refund, { where: { id: refundId }, lock: { mode: 'pessimistic_write' } });
      if (!refund || refund.status === RefundStatus.SUCCEEDED || refund.status === RefundStatus.FAILED) return;
      refund.status = RefundStatus.FAILED;
      await manager.save(Refund, refund);
      await this.auditWriter.write(actorId, refund.merchantId, 'VOUCHER_REFUND_FAILED', 'Refund', refund.id, { status: RefundStatus.PROCESSING }, { status: refund.status }, manager);
      const voucher = await manager.findOneByOrFail(Voucher, { id: refund.voucherId });
      // 券回滚 UNUSED：退款失败不应把券冻结在 REFUND_PENDING（否则券不可核销也不可正常重退），
      // 仅当券仍处于退款待处理态时回滚；已被并发核销/其他终态的券不动
      if (voucher.status === VoucherStatus.REFUND_PENDING) {
        const voucherBefore = { status: voucher.status };
        voucher.status = VoucherStatus.UNUSED;
        await manager.save(Voucher, voucher);
        await this.auditWriter.write(actorId, refund.merchantId, 'VOUCHER_REFUND_FAILED_ROLLBACK', 'Voucher', voucher.id, voucherBefore, { status: voucher.status, refundId: refund.id }, manager);
      }
      await this.notificationAudience.customerInbox(manager, voucher.customerId, {
        eventType: 'REFUND_FAILED',
        templateKey: 'refund-failed',
        merchantId: refund.merchantId,
        resourceType: 'Refund',
        resourceId: refund.id,
        payload: { refundId: refund.id, voucherId: voucher.id, status: refund.status, amountFen: refund.amountFen, attemptCount: refund.attemptCount },
        // #9：dedupeKey 不含 attemptCount——同一次退款失败只通知一次，避免每次重试都重复打扰顾客
        dedupeKey: `refund:${refund.id}:failed`,
      });
    });
  }

  private async finalize(refundId: string, paymentReference: string, actorId: string, operationId?: string): Promise<Refund> {
    return this.dataSource.transaction(async (manager) => {
      const refund = await manager.findOne(Refund, { where: { id: refundId }, lock: { mode: 'pessimistic_write' } });
      if (!refund) throw new NotFoundException('退款记录不存在');
      if (refund.status === RefundStatus.SUCCEEDED) return refund;
      const voucher = await manager.findOne(Voucher, { where: { id: refund.voucherId }, lock: { mode: 'pessimistic_write' } });
      if (!voucher || voucher.status !== VoucherStatus.REFUND_PENDING) throw new ConflictException('退款券状态已变化，请联系平台处理');
      const order = await manager.findOneByOrFail(Order, { id: refund.orderId });
      const refundBefore = { status: refund.status, hasPaymentReference: Boolean(refund.paymentReference) };
      const voucherBefore = { status: voucher.status };
      refund.status = RefundStatus.SUCCEEDED;
      refund.paymentReference = paymentReference;
      voucher.status = VoucherStatus.REFUNDED;
      await manager.save(Refund, refund);
      await manager.save(Voucher, voucher);
      // 已核销券退款使用独立的正数冲销表，避免违反 settlement_ledger_entries 的正数 CHECK 约束。
      if (voucher.verificationId) {
        await manager.save(SettlementLedgerReversal, {
          merchantId: voucher.merchantId,
          voucherId: voucher.id,
          verificationId: voucher.verificationId,
          refundId: refund.id,
          reversalAmountFen: voucher.faceValueFen,
          reversalServiceFeeFen: calculateServiceFeeFen(voucher.faceValueFen, voucher.commissionRateSnapshot),
          rateSnapshot: voucher.commissionRateSnapshot,
          reason: 'REFUND',
        });
      }
      const [unused, used, pending, expired] = await Promise.all([
        manager.countBy(Voucher, { orderId: order.id, status: VoucherStatus.UNUSED }),
        manager.countBy(Voucher, { orderId: order.id, status: VoucherStatus.USED }),
        manager.countBy(Voucher, { orderId: order.id, status: VoucherStatus.REFUND_PENDING }),
        manager.countBy(Voucher, { orderId: order.id, status: VoucherStatus.EXPIRED }),
      ]);
      // #3：订单标记 REFUNDED 必须"全部券都已退款"——EXPIRED 券未退钱，存在 EXPIRED 券时订单保持 PAID，
      // 避免"部分退+部分过期"被误标全额已退款（顾客看到"已退款"而实际部分钱未退）
      if (unused === 0 && used === 0 && pending === 0 && expired === 0) {
        order.status = OrderStatus.REFUNDED; await manager.save(Order, order);
        // #12：订单全额退款后回滚销售计数（已退单不再占用套餐库存/限购额度），与关闭订单时的 decrement 对称
        await manager.decrement(DealPackage, { id: order.packageId }, 'soldCount', order.quantity);
      }
      await this.auditWriter.write(actorId, voucher.merchantId, 'VOUCHER_REFUNDED', 'Voucher', voucher.id, voucherBefore, { status: voucher.status, refundId: refund.id, operationId: operationId || null }, manager);
      await this.auditWriter.write(actorId, voucher.merchantId, 'REFUND_SUCCEEDED', 'Refund', refund.id, refundBefore, { status: refund.status, hasPaymentReference: true }, manager);
      await this.notificationAudience.customerInbox(manager, voucher.customerId, {
        eventType: 'REFUND_SUCCEEDED',
        templateKey: 'refund-succeeded',
        merchantId: voucher.merchantId,
        resourceType: 'Refund',
        resourceId: refund.id,
        payload: { refundId: refund.id, voucherId: voucher.id, status: refund.status, amountFen: refund.amountFen },
        dedupeKey: `refund:${refund.id}:succeeded`,
      });
      return refund;
    });
  }

  private async persistRefundIdentifiers(refundId: string, request: RefundRequest): Promise<void> {
    await this.refunds.update(refundId, {
      confirmationRequestSeq: request.confirmationRequestSeq || null,
      confirmationRequestDate: request.confirmationRequestDate || null,
      confirmRefundRequestSeq: request.confirmRefundRequestSeq || null,
      confirmRefundRequestDate: request.confirmRefundRequestDate || null,
    });
  }

  private async markRefundStage(refundId: string, stage: RefundPaymentStage, paymentReference?: string): Promise<void> {
    await this.refunds.update(refundId, {
      paymentStage: stage,
      ...(paymentReference ? { paymentReference } : {}),
      lastAttemptAt: new Date(),
    });
  }

  private async markOrdinaryRefundPending(refundId: string, paymentReference: string | null): Promise<void> {
    await this.markRefundStage(refundId, RefundPaymentStage.ORDINARY_REFUND_PENDING, paymentReference || undefined);
  }

  private day(date: Date | string = new Date()): string {
    const values = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(date)).filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
    return `${values.year}-${values.month}-${values.day}`;
  }
}
