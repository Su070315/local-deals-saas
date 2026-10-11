import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash, randomBytes } from 'crypto';
import { DataSource, EntityManager, In, IsNull, LessThan, MoreThanOrEqual, Repository } from 'typeorm';
import { AuditWriterService } from './audit-writer.service';
import {
  CommissionRateVersion, DealPackage, Order, OrderStatus, PaymentEvent, PaymentEventStatus, PaymentEventType,
  PaymentOutbox, PaymentOutboxStatus, Voucher, VoucherStatus,
} from './domain/entities';
import {
  isDemoPaymentProvider, NormalizedPaymentEvent, PAYMENT_PROVIDER, PaymentIntent, PaymentProvider,
} from './payments/payment-provider';
import { expirySweepBatchSize, usesEmbeddedDatabase } from './runtime-config';
import type { CustomerIdentity } from './app-service.core-types';
import { MerchantPaymentProfileService } from './merchant-payment-profile.service';
import { CustomerAuthService } from './customer-auth.service';
import { RoutingPaymentProvider } from './payments/routing-payment-provider';
import { DelayedSettlementService } from './delayed-settlement.service';

const OUTBOX_BATCH_SIZE = 20;
const PROCESSING_STALE_MS = 5 * 60_000;
const MAX_RETRY_DELAY_MS = 15 * 60_000;
const EXPIRY_RECONCILIATION_COOLDOWN_MS = 60_000;
/** 滞留事件（NEEDS_RECONCILIATION）补偿专用 advisory lock id（与退款补偿锁区分） */
const RECONCILIATION_LOCK_ID = 7_310_922;
/** 滞留事件检疫期：超过该时长仍未确认渠道状态则转人工核查，避免无限滞留 */
const RECONCILIATION_QUARANTINE_MS = 7 * 24 * 60 * 60 * 1000;
/** DISPATCHED 查单持续失败超过该时长强制关闭订单（晚到支付事件由滞留补偿复活） */
const EXPIRY_FORCE_CLOSE_AFTER_MS = 24 * 60 * 60 * 1000;
/** 新派发订单快速查单冷却：支付确认时效优先，避免 10s 内对同一订单重复查汇付 */
const FAST_RECONCILE_COOLDOWN_MS = 10_000;
/** 仅对近 5 分钟内创建的支付意图快速重查；更早订单维持 60s 慢冷却，避免长期轮询汇付 */
const FAST_RECONCILE_WINDOW_MS = 5 * 60_000;

type ResolvedPaymentEvent = NormalizedPaymentEvent & { merchantId: string; providerMerchantId: string | null };
type PaymentRoute = { provider: string; paymentProfileId: string | null; providerMerchantId: string | null };

@Injectable()
export class PaymentProcessingService {
  /** PostgreSQL row locks remain authoritative; this serializes pg-mem callbacks. */
  private readonly eventApplyLocks = new Map<string, Promise<PaymentEvent | undefined>>();

  constructor(
    private readonly dataSource: DataSource,
    private readonly auditWriter: AuditWriterService,
    private readonly merchantPaymentProfiles: MerchantPaymentProfileService,
    private readonly customerAuth: CustomerAuthService,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
    private readonly delayedSettlement: DelayedSettlementService,
    @InjectRepository(Order) private readonly orders: Repository<Order>,
    @InjectRepository(PaymentOutbox) private readonly outbox: Repository<PaymentOutbox>,
    @InjectRepository(PaymentEvent) private readonly events: Repository<PaymentEvent>,
    @InjectRepository(Voucher) private readonly vouchers: Repository<Voucher>,
  ) {}

  assertEnabled(): void {
    if (!this.provider.enabled) throw new ServiceUnavailableException('支付通道尚未启用');
  }

  async paymentRoute(manager: EntityManager, merchantId: string): Promise<PaymentRoute> {
    // 按商家支付档案路由：代理端配置的通道优先；无档案默认微信直连（全局商户号）
    if (this.provider instanceof RoutingPaymentProvider) {
      const route = await this.merchantPaymentProfiles.activeRoute(manager, merchantId);
      return {
        provider: route.provider,
        paymentProfileId: route.paymentProfileId || null,
        providerMerchantId: route.providerMerchantId || null,
      };
    }
    if (!this.provider.requiresMerchantProfile) return { provider: this.provider.providerName, paymentProfileId: null, providerMerchantId: null };
    const profile = await this.merchantPaymentProfiles.activeRouteByProvider(manager, merchantId, this.provider.providerName);
    return { provider: this.provider.providerName, paymentProfileId: profile.paymentProfileId, providerMerchantId: profile.providerMerchantId };
  }

  /** H-06：支持定向领取指定订单的支付意图（当前订单只处理自己的），无 orderId 时全局批处理。 */
  async dispatchPendingIntents(limit = OUTBOX_BATCH_SIZE, orderId?: string): Promise<{ dispatched: number; retried: number; cancelled: number }> {
    if (!this.provider.enabled) return { dispatched: 0, retried: 0, cancelled: 0 };
    const claimed = await this.claimOutbox(Math.max(1, Math.min(limit, OUTBOX_BATCH_SIZE)), orderId);
    let dispatched = 0;
    let retried = 0;
    let cancelled = 0;
    for (const claimedItem of claimed) {
      try {
        const order = await this.orders.findOneBy({ id: claimedItem.orderId });
        if (!order || order.status !== OrderStatus.PENDING_PAYMENT || new Date(order.paymentExpiresAt) <= new Date()) {
          await this.outbox.update(claimedItem.id, { status: PaymentOutboxStatus.CANCELLED, lastError: '订单已关闭或超时' });
          cancelled += 1;
          continue;
        }
        const customerOpenid = order.customerId ? await this.customerAuth.openidOf(order.customerId) : '';
        // H-04：上次已派发过渠道单（结果不明进入重试）时，先按原参考号查单，避免重复建渠道支付单
        if (claimedItem.providerReference) {
          const existing = await this.provider.queryPayment({ ...this.intentFor(order, claimedItem, customerOpenid), paymentReference: claimedItem.providerReference });
          if (existing) {
            await this.persistEvent(existing, this.hash(Buffer.from(`recovered:${existing.providerEventId}`, 'utf8')));
            dispatched += 1;
            continue;
          }
        }
        const payment = await this.provider.createPayment(this.intentFor(order, claimedItem, customerOpenid));
        const settled = await this.dataSource.transaction(async (manager) => {
          const item = await manager.findOne(PaymentOutbox, { where: { id: claimedItem.id }, lock: { mode: 'pessimistic_write' } });
          const currentOrder = await manager.findOne(Order, { where: { id: claimedItem.orderId }, lock: { mode: 'pessimistic_write' } });
          if (!item || item.status !== PaymentOutboxStatus.PROCESSING) return false;
          if (!currentOrder || currentOrder.status !== OrderStatus.PENDING_PAYMENT || new Date(currentOrder.paymentExpiresAt) <= new Date()) {
            item.status = PaymentOutboxStatus.CANCELLED;
            item.lastError = '支付意图返回时订单已关闭或超时';
            await manager.save(PaymentOutbox, item);
            return false;
          }
          item.status = PaymentOutboxStatus.DISPATCHED;
          item.providerReference = payment.paymentReference;
          item.lastReconciledAt = null;
          item.lastError = '';
          currentOrder.paymentReference = payment.paymentReference;
          if (payment.payInfo) currentOrder.payInfo = payment.payInfo;
          await manager.save(PaymentOutbox, item);
          await manager.save(Order, currentOrder);
          await this.auditWriter.write('system', currentOrder.merchantId, 'PAYMENT_INTENT_DISPATCHED', 'PaymentOutbox', item.id, null, { orderId: currentOrder.id, attemptCount: item.attemptCount }, manager);
          return true;
        });
        if (settled) dispatched += 1;
        else cancelled += 1;
      } catch {
        await this.dataSource.transaction(async (manager) => {
          const item = await manager.findOne(PaymentOutbox, { where: { id: claimedItem.id }, lock: { mode: 'pessimistic_write' } });
          if (!item || item.status !== PaymentOutboxStatus.PROCESSING) return;
          item.status = PaymentOutboxStatus.RETRY;
          item.nextAttemptAt = this.retryAt(item.attemptCount);
          item.lastError = '支付通道请求失败，等待重试';
          await manager.save(PaymentOutbox, item);
        });
        retried += 1;
      }
    }
    return { dispatched, retried, cancelled };
  }

  async reconcileDispatchedIntents(limit = OUTBOX_BATCH_SIZE): Promise<{ queried: number; recovered: number; failed: number }> {
    if (!this.provider.enabled) return { queried: 0, recovered: 0, failed: 0 };
    const now = new Date();
    const slowCooldownBefore = new Date(now.getTime() - 60_000);
    const fastCooldownBefore = new Date(now.getTime() - FAST_RECONCILE_COOLDOWN_MS);
    const fastWindowStart = new Date(now.getTime() - FAST_RECONCILE_WINDOW_MS);
    // 近 5 分钟内创建的支付意图用 10s 冷却快速重查（用户正在支付，确认时效优先）；
    // 更早订单维持 60s 冷却，避免对已放弃订单长期高频轮询汇付。
    const candidates = await this.outbox.find({
      where: [
        { status: PaymentOutboxStatus.DISPATCHED, lastReconciledAt: IsNull() },
        { status: PaymentOutboxStatus.DISPATCHED, lastReconciledAt: LessThan(fastCooldownBefore), createdAt: MoreThanOrEqual(fastWindowStart) },
        { status: PaymentOutboxStatus.DISPATCHED, lastReconciledAt: LessThan(slowCooldownBefore), createdAt: LessThan(fastWindowStart) },
      ],
      order: { createdAt: 'ASC' },
      take: Math.max(1, Math.min(limit, OUTBOX_BATCH_SIZE)),
    });
    let queried = 0;
    let recovered = 0;
    let failed = 0;
    for (const item of candidates) {
      const order = await this.orders.findOneBy({ id: item.orderId });
      if (!order) { await this.outbox.update(item.id, { status: PaymentOutboxStatus.CANCELLED, lastError: '支付意图对应订单不存在' }); continue; }
      if ([OrderStatus.PAID, OrderStatus.REFUNDED].includes(order.status)) { await this.outbox.update(item.id, { status: PaymentOutboxStatus.COMPLETED, lastReconciledAt: new Date(), lastError: '' }); continue; }
      if (order.status !== OrderStatus.PENDING_PAYMENT) { await this.outbox.update(item.id, { status: PaymentOutboxStatus.CANCELLED, lastError: '订单已关闭，停止支付查单' }); continue; }
      try {
        const event = await this.provider.queryPayment({ ...this.intentFor(order, item), paymentReference: item.providerReference });
        await this.outbox.update(item.id, { lastReconciledAt: new Date() });
        queried += 1;
        if (event) { await this.persistEvent(event, this.hash(Buffer.from(`provider-query:${event.providerEventId}`, 'utf8'))); recovered += 1; }
      } catch {
        await this.outbox.update(item.id, { lastReconciledAt: new Date(), lastError: '支付查单失败，等待下次补偿' });
        failed += 1;
      }
    }
    return { queried, recovered, failed };
  }

  /**
   * 顾客支付成功后请求后端尽快补偿（前端 wx.requestPayment 成功回调立即调用）。
   * 这里只校验订单归属并唤醒现有 PaymentOutbox 补偿循环，不同步调用汇付，避免把外部渠道
   * 延迟带入顾客 API 请求。支付事实仍只由回调或统一 reconcileDispatchedIntents 落事件确认，
   * 订单 PAID、Voucher 生成和资金管控隔离规则保持不变。
   */
  async requestOrderPaymentReconciliation(orderId: string, customerId: string): Promise<OrderStatus> {
    const order = await this.orders.findOneBy({ id: orderId });
    if (!order || order.customerId !== customerId) throw new NotFoundException('订单不存在');
    if (order.status !== OrderStatus.PENDING_PAYMENT) return order.status;
    const item = await this.outbox.findOneBy({ orderId });
    if (!item || item.status !== PaymentOutboxStatus.DISPATCHED || !item.providerReference) return order.status;
    const now = new Date();
    // reconcileDispatchedIntents 使用 lastReconciledAt 实现渠道查单冷却；仅提前 nextAttemptAt
    // 不会唤醒一个刚刚查过的订单，因此这里必须清空冷却时间，确保本次顾客确认请求能被下一轮 worker 立即拾取。
    await this.outbox.update(item.id, {
      nextAttemptAt: now,
      lastReconciledAt: null,
      lastError: '顾客主动请求支付确认，已加入补偿队列',
    });
    return order.status;
  }

  /**
   * 补偿 NEEDS_RECONCILIATION 事件（订单关闭后支付成功迟到造成的资金滞留）。
   * 查单确认渠道真实状态：渠道确认已支付→补发券+订单复活为 PAID；确认未支付→事件落终态、订单保持关闭；
   * 查不到/查单失败→检疫期后转人工核查，期间下轮再查。advisory lock 防多实例并发。
   */
  async reconcileNeedsReconciliation(limit = OUTBOX_BATCH_SIZE): Promise<{ recovered: number; settled: number; quarantined: number }> {
    if (!this.provider.enabled) return { recovered: 0, settled: 0, quarantined: 0 };
    const queryRunner = this.dataSource.createQueryRunner();
    try {
      await queryRunner.connect();
      const locked = await queryRunner.query('SELECT pg_try_advisory_lock($1) AS locked', [RECONCILIATION_LOCK_ID]);
      const acquired = Array.isArray(locked) && locked[0] && (locked[0] as Record<string, unknown>).locked === true;
      if (!acquired) return { recovered: 0, settled: 0, quarantined: 0 };
    } catch {
      await queryRunner.release().catch(() => undefined);
      return { recovered: 0, settled: 0, quarantined: 0 };
    }
    try {
      const candidates = await this.events.find({ where: { status: PaymentEventStatus.NEEDS_RECONCILIATION }, order: { occurredAt: 'ASC', id: 'ASC' }, take: Math.max(1, Math.min(limit, OUTBOX_BATCH_SIZE)) });
      let recovered = 0;
      let settled = 0;
      let quarantined = 0;
      for (const event of candidates) {
        try {
          const outcome = await this.reconcileSingleEvent(event);
          if (outcome === 'RECOVERED') recovered += 1;
          else if (outcome === 'SETTLED') settled += 1;
          else if (outcome === 'QUARANTINED') quarantined += 1;
        } catch { /* 单条失败不阻塞整批 */ }
      }
      return { recovered, settled, quarantined };
    } finally {
      await queryRunner.query('SELECT pg_advisory_unlock($1)', [RECONCILIATION_LOCK_ID]).catch(() => undefined);
      await queryRunner.release().catch(() => undefined);
    }
  }

  private async reconcileSingleEvent(event: PaymentEvent): Promise<'RECOVERED' | 'SETTLED' | 'QUARANTINED' | 'SKIP'> {
    const order = await this.orders.findOneBy({ id: event.orderId });
    if (!order) {
      await this.events.update(event.id, { status: PaymentEventStatus.PROCESSED, processingNote: '订单不存在，请人工核查' });
      return 'SETTLED';
    }
    const item = await this.outbox.findOneBy({ orderId: order.id });
    try {
      const query = await this.provider.queryPayment({ ...this.intentFor(order, item), paymentReference: event.providerPaymentReference || item?.providerReference || null });
      if (query && query.eventType === PaymentEventType.PAYMENT_SUCCEEDED) {
        await this.reconcileFulfillOrder(event, order, query);
        return 'RECOVERED';
      }
      if (query) {
        // 渠道确认未成功支付：订单保持关闭，事件落终态
        await this.events.update(event.id, { status: PaymentEventStatus.PROCESSED, processingNote: '渠道确认未支付成功，订单保持关闭' });
        return 'SETTLED';
      }
    } catch { /* 查单失败进入检疫分支 */ }
    if (Date.now() - event.receivedAt.getTime() > RECONCILIATION_QUARANTINE_MS) {
      await this.events.update(event.id, { status: PaymentEventStatus.PROCESSED, processingNote: '超过检疫期仍未确认渠道状态，请人工核查' });
      return 'QUARANTINED';
    }
    return 'SKIP';
  }

  private async reconcileFulfillOrder(event: PaymentEvent, order: Order, query: NormalizedPaymentEvent): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const lockedEvent = await manager.findOne(PaymentEvent, { where: { id: event.id }, lock: { mode: 'pessimistic_write' } });
      if (!lockedEvent || lockedEvent.status !== PaymentEventStatus.NEEDS_RECONCILIATION) return;
      const lockedOrder = await manager.findOne(Order, { where: { id: order.id }, lock: { mode: 'pessimistic_write' } });
      if (!lockedOrder) return;
      if (lockedOrder.status === OrderStatus.PAID) {
        lockedEvent.status = PaymentEventStatus.PROCESSED; lockedEvent.processingNote = '订单已入账，事件补录';
        await manager.save(PaymentEvent, lockedEvent); await this.completeOutbox(manager, lockedOrder.id);
        return;
      }
      if (lockedOrder.status === OrderStatus.CLOSED) {
        // 渠道确认已支付但订单已关闭：补录入账（复活为 PAID + 补发券 + 销售计数补回）
        // A2：费率同样按下单时间定格（order.createdAt），与 applySuccessfulPayment 一致
        const rate = await manager.createQueryBuilder(CommissionRateVersion, 'rate').where('rate.merchantId = :merchantId AND rate.effectiveFrom <= :at', { merchantId: lockedOrder.merchantId, at: lockedOrder.createdAt }).orderBy('rate.effectiveFrom', 'DESC').getOne();
        if (!rate) throw new BadRequestException('商家未配置有效服务费率');
        lockedOrder.status = OrderStatus.PAID;
        lockedOrder.paymentReference = query.providerPaymentReference;
        lockedOrder.commissionRateSnapshot = rate.rate;
        await manager.save(Order, lockedOrder);
        const route = await manager.findOne(PaymentOutbox, { where: { orderId: lockedOrder.id } });
        await this.delayedSettlement.createSnapshot(manager, lockedOrder, query.providerPaymentReference, route?.provider || event.provider);
        const vouchers = await manager.save(Voucher, Array.from({ length: lockedOrder.quantity }, () => manager.create(Voucher, { code: randomBytes(8).toString('hex').toUpperCase(), orderId: lockedOrder.id, merchantId: lockedOrder.merchantId, packageId: lockedOrder.packageId, storeId: lockedOrder.storeId, customerId: lockedOrder.customerId, faceValueFen: lockedOrder.unitPriceFen, commissionRateSnapshot: lockedOrder.commissionRateSnapshot, status: VoucherStatus.UNUSED, validFrom: lockedOrder.validFromSnapshot, validTo: lockedOrder.validToSnapshot, verificationId: null })));
        await manager.increment(DealPackage, { id: lockedOrder.packageId }, 'soldCount', lockedOrder.quantity);
        lockedEvent.status = PaymentEventStatus.PROCESSED; lockedEvent.processingNote = '';
        await manager.save(PaymentEvent, lockedEvent); await this.completeOutbox(manager, lockedOrder.id);
        await this.auditWriter.write(`payment:${lockedEvent.provider}`, lockedOrder.merchantId, 'ORDER_PAID_RECONCILED', 'Order', lockedOrder.id, { status: OrderStatus.CLOSED }, { status: OrderStatus.PAID, voucherCount: vouchers.length, paymentEventId: lockedEvent.id, note: '渠道查单确认已支付，补录入账' }, manager);
        return;
      }
      lockedEvent.status = PaymentEventStatus.PROCESSED; lockedEvent.processingNote = `订单状态 ${lockedOrder.status}，事件补录`;
      await manager.save(PaymentEvent, lockedEvent);
    });
  }

  async receiveWebhook(providerName: string, rawBody: Buffer, headers: Readonly<Record<string, string | undefined>>, providerParam?: string): Promise<PaymentEvent> {
    if (!this.provider.enabled) throw new NotFoundException();
    if (!Buffer.isBuffer(rawBody) || !rawBody.length) throw new BadRequestException('支付回调缺少原始请求体');
    // URL 段可能用连字符（wechat-direct）而 providerName 是下划线（wechat_direct），统一归一化兼容
    const normalizedProvider = String(providerName || '').replace(/-/g, '_');
    let normalized: NormalizedPaymentEvent;
    try {
      if (this.provider instanceof RoutingPaymentProvider) {
        normalized = await this.provider.parseWebhookFor(normalizedProvider, { rawBody, headers }, providerParam);
      } else {
        if (normalizedProvider !== this.provider.providerName) throw new NotFoundException();
        normalized = await this.provider.parseWebhook({ rawBody, headers });
      }
    } catch (error) {
      if (error instanceof NotFoundException) throw error;
      throw new BadRequestException('支付回调验签失败');
    }
    if (!normalized || !Object.values(PaymentEventType).includes(normalized.eventType) || !/^[A-Za-z0-9_-]{1,128}$/.test(normalized.providerEventId) || !/^[A-Za-z0-9_-]{1,128}$/.test(normalized.providerPaymentReference) || !/^DG\d{8}[A-F0-9]{16}$/.test(normalized.orderNo) || (normalized.merchantId !== undefined && !/^[0-9a-f-]{36}$/i.test(normalized.merchantId)) || (normalized.providerMerchantId != null && !/^[A-Za-z0-9_-]{6,64}$/.test(normalized.providerMerchantId)) || !Number.isSafeInteger(normalized.amountFen) || normalized.amountFen < 1 || Number.isNaN(new Date(normalized.occurredAt).getTime())) throw new BadRequestException('支付回调格式不正确');
    return this.persistEvent(normalized, this.hash(rawBody));
  }

  async expirePendingOrders(checkDispatchedPayments = true, limit = expirySweepBatchSize()): Promise<number> {
    const batchLimit = this.batchLimit(limit);
    const now = new Date();
    const query = this.orders.createQueryBuilder('order')
      .where('order.status = :status AND order.paymentExpiresAt < :now', { status: OrderStatus.PENDING_PAYMENT, now })
      .orderBy('order.paymentExpiresAt', 'ASC').addOrderBy('order.id', 'ASC').take(batchLimit);
    if (checkDispatchedPayments && this.provider.enabled) {
      const reconciliationBefore = new Date(now.getTime() - EXPIRY_RECONCILIATION_COOLDOWN_MS);
      query.leftJoin(PaymentOutbox, 'outbox', 'outbox.orderId = order.id')
        .andWhere('(outbox.orderId IS NULL OR outbox.status != :dispatched OR outbox.lastReconciledAt IS NULL OR outbox.lastReconciledAt < :reconciliationBefore)', { dispatched: PaymentOutboxStatus.DISPATCHED, reconciliationBefore });
    }
    const overdue = await query.getMany();
    let closed = 0;
    for (const order of overdue) {
      const item = await this.outbox.findOneBy({ orderId: order.id });
      if (checkDispatchedPayments && this.provider.enabled && item?.status === PaymentOutboxStatus.DISPATCHED) {
        try {
          const event = await this.provider.queryPayment({ ...this.intentFor(order, item), paymentReference: item.providerReference });
          await this.outbox.update(item.id, { lastReconciledAt: new Date() });
          if (event) await this.persistEvent(event, this.hash(Buffer.from(`provider-query:${event.providerEventId}`, 'utf8')));
        } catch {
          await this.outbox.update(item.id, { lastReconciledAt: new Date(), lastError: '订单到期查单失败，保留待补偿' });
          // #7：DISPATCHED 持续查单失败超 24h 仍无法确认 → 强制关闭订单，防永留 PENDING_PAYMENT；
          // 若渠道实际已扣款，迟到事件会走 NEEDS_RECONCILIATION 补偿复活（补发券），不丢钱
          if (Date.now() - item.createdAt.getTime() > EXPIRY_FORCE_CLOSE_AFTER_MS && await this.closeExpiredOrder(order.id)) closed += 1;
          continue;
        }
      } else if (!checkDispatchedPayments && item?.status === PaymentOutboxStatus.DISPATCHED) continue;
      if (await this.closeExpiredOrder(order.id)) closed += 1;
    }
    return closed;
  }

  async confirmDemoPayment(orderId: string, customer: CustomerIdentity): Promise<{ order: Order; vouchers: Voucher[] }> {
    if (!isDemoPaymentProvider(this.provider)) throw new NotFoundException();
    const order = await this.orders.findOneBy({ id: orderId });
    if (!order || order.customerId !== customer.id) throw new NotFoundException('订单不存在');
    if (order.status !== OrderStatus.PAID) {
      if (order.status !== OrderStatus.PENDING_PAYMENT || new Date(order.paymentExpiresAt) < new Date()) throw new BadRequestException('订单已超时，请重新下单');
      const event = await this.provider.createDemoPaymentEvent(this.intentFor(order));
      await this.persistEvent(event, this.hash(Buffer.from(`demo:${event.providerEventId}`, 'utf8')));
    }
    return { order: await this.orders.findOneByOrFail({ id: orderId }), vouchers: await this.vouchers.findBy({ orderId }) };
  }

  /** 取小程序端调起支付参数：payInfo 已由 dispatch 异步落库，未就绪时补一次 dispatch 同步等待。 */
  async paymentParams(orderId: string, customerId: string): Promise<{ payInfo: string; expiresAt: Date }> {
    const order = await this.orders.findOneBy({ id: orderId });
    if (!order || order.customerId !== customerId) throw new NotFoundException('订单不存在');
    if (order.status !== OrderStatus.PENDING_PAYMENT) throw new BadRequestException('订单当前不可支付');
    if (new Date(order.paymentExpiresAt) < new Date()) throw new BadRequestException('订单已超时，请重新下单');
    if (!order.payInfo) {
      // H-06：定向领取当前订单的支付意图，避免全局队列积压导致本订单被饿死
      await this.dispatchPendingIntents(1, orderId);
      const refreshed = await this.orders.findOneBy({ id: orderId });
      if (!refreshed?.payInfo) throw new ServiceUnavailableException('支付参数尚未就绪，请稍后重试');
      return { payInfo: refreshed.payInfo, expiresAt: refreshed.paymentExpiresAt };
    }
    return { payInfo: order.payInfo, expiresAt: order.paymentExpiresAt };
  }

  private async claimOutbox(limit: number, orderId?: string): Promise<PaymentOutbox[]> {
    const now = new Date();
    const staleBefore = new Date(now.getTime() - PROCESSING_STALE_MS);
    return this.dataSource.transaction(async (manager) => {
      const query = manager.createQueryBuilder(PaymentOutbox, 'outbox').setLock('pessimistic_write')
        .where('(outbox.status = :pending AND outbox.nextAttemptAt <= :now) OR (outbox.status = :retry AND outbox.nextAttemptAt <= :now) OR (outbox.status = :processing AND outbox.lastAttemptAt < :staleBefore)', { pending: PaymentOutboxStatus.PENDING, retry: PaymentOutboxStatus.RETRY, processing: PaymentOutboxStatus.PROCESSING, now, staleBefore })
        .orderBy('outbox.createdAt', 'ASC').addOrderBy('outbox.id', 'ASC').take(limit);
      // H-06：定向领取时只处理指定订单
      if (orderId) query.andWhere('outbox.orderId = :orderId', { orderId });
      if (!usesEmbeddedDatabase()) query.setOnLocked('skip_locked');
      const candidates = await query.getMany();
      const claimed: PaymentOutbox[] = [];
      for (const item of candidates) {
        const order = await manager.findOne(Order, { where: { id: item.orderId }, lock: { mode: 'pessimistic_write' } });
        if (!order || order.status !== OrderStatus.PENDING_PAYMENT || new Date(order.paymentExpiresAt) <= now) {
          item.status = PaymentOutboxStatus.CANCELLED; item.lastError = '订单已关闭或超时'; await manager.save(PaymentOutbox, item); continue;
        }
        item.status = PaymentOutboxStatus.PROCESSING; item.attemptCount += 1; item.lastAttemptAt = now; item.lastError = '';
        await manager.save(PaymentOutbox, item); claimed.push(item);
      }
      return claimed;
    });
  }

  private async persistEvent(normalized: NormalizedPaymentEvent, rawPayloadHash: string): Promise<PaymentEvent> {
    const sourceOrder = await this.orders.findOneBy({ orderNo: normalized.orderNo });
    if (!sourceOrder || (normalized.merchantId && sourceOrder.merchantId !== normalized.merchantId)) {
      throw new BadRequestException('支付事件订单归属不匹配');
    }
    const sourceOutbox = await this.outbox.findOneBy({ orderId: sourceOrder.id });
    this.assertEventRoute(normalized, sourceOutbox);
    const resolved: ResolvedPaymentEvent = {
      ...normalized,
      merchantId: sourceOrder.merchantId,
      providerMerchantId: sourceOutbox?.providerMerchantId || normalized.providerMerchantId || null,
    };
    const normalizedHash = this.normalizedHash(resolved);
    const existing = await this.events.findOneBy({ provider: this.provider.providerName, providerEventId: normalized.providerEventId });
    if (existing) {
      if (existing.normalizedHash !== normalizedHash) throw new ConflictException('支付事件标识与内容不一致');
      return this.applyEvent(existing.id);
    }
    try {
      const received = await this.dataSource.transaction(async (manager) => {
        const order = await manager.findOneBy(Order, { orderNo: resolved.orderNo });
        if (!order || order.merchantId !== resolved.merchantId) throw new BadRequestException('支付事件订单归属不匹配');
        const outbox = await manager.findOneBy(PaymentOutbox, { orderId: order.id });
        this.assertEventRoute(resolved, outbox);
        return manager.save(PaymentEvent, { orderId: order.id, merchantId: order.merchantId, provider: this.provider.providerName, providerMerchantId: resolved.providerMerchantId, providerEventId: resolved.providerEventId, eventType: resolved.eventType, providerPaymentReference: resolved.providerPaymentReference, amountFen: resolved.amountFen, occurredAt: resolved.occurredAt, rawPayloadHash, normalizedHash, status: PaymentEventStatus.RECEIVED, huifuFundControlStatus: resolved.fundControl?.status || null, huifuFundFrozenAt: resolved.fundControl?.frozenAt || null, huifuFundUnfrozenAt: resolved.fundControl?.unfrozenAt || null, huifuFundUnfrozenAmountFen: resolved.fundControl?.unfrozenAmountFen ?? null, processingNote: '' });
      });
      return this.applyEvent(received.id);
    } catch (error) {
      if (!this.isUniqueConstraintError(error)) throw error;
      const duplicate = await this.events.findOneBy({ provider: this.provider.providerName, providerEventId: resolved.providerEventId });
      if (!duplicate) throw error;
      if (duplicate.normalizedHash !== normalizedHash) throw new ConflictException('支付事件标识与内容不一致');
      return this.applyEvent(duplicate.id);
    }
  }

  private async applyEvent(eventId: string): Promise<PaymentEvent> {
    const previous = this.eventApplyLocks.get(eventId) || Promise.resolve<PaymentEvent | undefined>(undefined);
    const current = previous.catch(() => undefined).then(() => this.applyEventTransaction(eventId));
    this.eventApplyLocks.set(eventId, current);
    try { return await current; }
    finally { if (this.eventApplyLocks.get(eventId) === current) this.eventApplyLocks.delete(eventId); }
  }

  private async applyEventTransaction(eventId: string): Promise<PaymentEvent> {
    return this.dataSource.transaction(async (manager) => {
      const event = await manager.findOne(PaymentEvent, { where: { id: eventId }, lock: { mode: 'pessimistic_write' } });
      if (!event) throw new NotFoundException('支付事件不存在');
      if (event.status === PaymentEventStatus.PROCESSED) { await this.completeOutbox(manager, event.orderId); return event; }
      if ([PaymentEventStatus.REJECTED, PaymentEventStatus.NEEDS_RECONCILIATION].includes(event.status)) return event;
      const order = await manager.findOne(Order, { where: { id: event.orderId }, lock: { mode: 'pessimistic_write' } });
      if (!order || order.merchantId !== event.merchantId || (event.eventType !== PaymentEventType.DELAYED_SETTLEMENT_UPDATED && order.amountFen !== event.amountFen)) {
        event.status = PaymentEventStatus.REJECTED; event.processingNote = '订单或金额校验失败'; return manager.save(PaymentEvent, event);
      }
      if (event.eventType === PaymentEventType.FUND_CONTROL_UPDATED || event.eventType === PaymentEventType.DELAYED_SETTLEMENT_UPDATED) return this.applyNonPaymentEvent(manager, event, order);
      if (event.eventType === PaymentEventType.PAYMENT_SUCCEEDED) return this.applySuccessfulPayment(manager, event, order);
      if (order.status === OrderStatus.PENDING_PAYMENT) {
        order.status = OrderStatus.CLOSED;
        await manager.save(Order, order);
        await manager.decrement(DealPackage, { id: order.packageId }, 'soldCount', order.quantity);
        await this.auditWriter.write(`payment:${event.provider}`, order.merchantId, 'ORDER_PAYMENT_NOT_COMPLETED', 'Order', order.id, { status: OrderStatus.PENDING_PAYMENT }, { status: OrderStatus.CLOSED, eventType: event.eventType }, manager);
      }
      event.status = PaymentEventStatus.PROCESSED; event.processingNote = '';
      await manager.save(PaymentEvent, event); await this.completeOutbox(manager, order.id); return event;
    });
  }

  /**
   * 非支付事件（资金管控 FREEZE/UNFREEZE、延迟交易确认 resp_data 通知）只记录渠道事实，
   * 不改变订单、券或 outbox 状态，避免把资金冻结/确认通知误判为支付结果。
   */
  private async applyNonPaymentEvent(manager: EntityManager, event: PaymentEvent, order: Order): Promise<PaymentEvent> {
    if (event.eventType === PaymentEventType.DELAYED_SETTLEMENT_UPDATED && (event.amountFen <= 0 || event.amountFen > order.amountFen)) {
      // 上层金额校验对 DS 事件豁免（确认金额可能分批），这里补上硬边界：必须为正且不超过订单应付金额。
      event.status = PaymentEventStatus.REJECTED;
      event.processingNote = '延迟交易确认金额越界';
      return manager.save(PaymentEvent, event);
    }
    if (event.eventType === PaymentEventType.DELAYED_SETTLEMENT_UPDATED) {
      event.status = PaymentEventStatus.PROCESSED;
      event.processingNote = '延迟交易确认通知已记录，确认 outbox 负责最终入账幂等';
      return manager.save(PaymentEvent, event);
    }
    if (event.eventType === PaymentEventType.FUND_CONTROL_UPDATED && !event.huifuFundControlStatus) {
      event.status = PaymentEventStatus.REJECTED;
      event.processingNote = '资金管控事件缺少 FREEZE/UNFREEZE 状态';
      return manager.save(PaymentEvent, event);
    }
    if (event.eventType === PaymentEventType.FUND_CONTROL_UPDATED && event.huifuFundUnfrozenAmountFen !== null && event.huifuFundUnfrozenAmountFen > event.amountFen) {
      event.status = PaymentEventStatus.REJECTED;
      event.processingNote = '资金解冻金额超过订单金额';
      return manager.save(PaymentEvent, event);
    }
    event.status = PaymentEventStatus.PROCESSED;
    event.processingNote = '';
    await manager.save(PaymentEvent, event);
    // 资金管控通知是渠道事实，不是支付成功/失败，也不改变订单、券或 outbox 状态。
    return event;
  }

  private async applySuccessfulPayment(manager: EntityManager, event: PaymentEvent, order: Order): Promise<PaymentEvent> {
    if (order.status === OrderStatus.PAID) {
      if (order.paymentReference && order.paymentReference !== event.providerPaymentReference) { event.status = PaymentEventStatus.NEEDS_RECONCILIATION; event.processingNote = '同一订单收到不同支付参考号'; }
      else event.status = PaymentEventStatus.PROCESSED;
      await manager.save(PaymentEvent, event);
      if (event.status === PaymentEventStatus.PROCESSED) await this.completeOutbox(manager, order.id);
      return event;
    }
    if (order.status !== OrderStatus.PENDING_PAYMENT || new Date(order.paymentExpiresAt) < new Date(event.occurredAt)) {
      event.status = PaymentEventStatus.NEEDS_RECONCILIATION; event.processingNote = '付款结果晚于订单有效期或订单状态不可入账';
      await manager.save(PaymentEvent, event);
      await this.auditWriter.write(`payment:${event.provider}`, order.merchantId, 'PAYMENT_EVENT_REQUIRES_RECONCILIATION', 'PaymentEvent', event.id, null, { orderId: order.id, reason: event.processingNote }, manager);
      return event;
    }
    // A2：费率以下单时间定格（order.createdAt）——费率改版落在"下单~支付"窗口时不覆盖下单时费率快照，
    // 与 customer-commerce 下单时的 activeRate() 语义一致，订单/券/台账三处快照同源
    const rate = await manager.createQueryBuilder(CommissionRateVersion, 'rate').where('rate.merchantId = :merchantId AND rate.effectiveFrom <= :at', { merchantId: order.merchantId, at: order.createdAt }).orderBy('rate.effectiveFrom', 'DESC').getOne();
    if (!rate) throw new BadRequestException('商家未配置有效服务费率');
    order.status = OrderStatus.PAID; order.paymentReference = event.providerPaymentReference; order.commissionRateSnapshot = rate.rate;
    await manager.save(Order, order);
    const route = await manager.findOne(PaymentOutbox, { where: { orderId: order.id } });
    await this.delayedSettlement.createSnapshot(manager, order, event.providerPaymentReference, route?.provider || event.provider);
    const vouchers = await manager.save(Voucher, Array.from({ length: order.quantity }, () => manager.create(Voucher, { code: randomBytes(8).toString('hex').toUpperCase(), orderId: order.id, merchantId: order.merchantId, packageId: order.packageId, storeId: order.storeId, customerId: order.customerId, faceValueFen: order.unitPriceFen, commissionRateSnapshot: order.commissionRateSnapshot, status: VoucherStatus.UNUSED, validFrom: order.validFromSnapshot, validTo: order.validToSnapshot, verificationId: null })));
    event.status = PaymentEventStatus.PROCESSED; event.processingNote = '';
    await manager.save(PaymentEvent, event); await this.completeOutbox(manager, order.id);
    await this.auditWriter.write(`payment:${event.provider}`, order.merchantId, 'ORDER_PAID', 'Order', order.id, { status: OrderStatus.PENDING_PAYMENT }, { status: OrderStatus.PAID, voucherCount: vouchers.length, paymentEventId: event.id }, manager);
    return event;
  }

  private async closeExpiredOrder(orderId: string): Promise<boolean> {
    return this.dataSource.transaction(async (manager) => {
      const order = await manager.findOne(Order, { where: { id: orderId }, lock: { mode: 'pessimistic_write' } });
      if (!order || order.status !== OrderStatus.PENDING_PAYMENT || new Date(order.paymentExpiresAt) >= new Date()) return false;
      await this.auditWriter.write('system', order.merchantId, 'ORDER_PAYMENT_EXPIRED', 'Order', order.id, { status: order.status }, { status: OrderStatus.CLOSED }, manager);
      order.status = OrderStatus.CLOSED; await manager.save(Order, order);
      await manager.update(PaymentOutbox, { orderId: order.id, status: In([PaymentOutboxStatus.PENDING, PaymentOutboxStatus.PROCESSING, PaymentOutboxStatus.RETRY, PaymentOutboxStatus.DISPATCHED]) }, { status: PaymentOutboxStatus.CANCELLED, lastError: '订单支付超时' });
      await manager.decrement(DealPackage, { id: order.packageId }, 'soldCount', order.quantity);
      return true;
    });
  }

  private async completeOutbox(manager: EntityManager, orderId: string): Promise<void> {
    await manager.update(PaymentOutbox, { orderId, status: In([PaymentOutboxStatus.PENDING, PaymentOutboxStatus.PROCESSING, PaymentOutboxStatus.RETRY, PaymentOutboxStatus.DISPATCHED]) }, { status: PaymentOutboxStatus.COMPLETED, lastReconciledAt: new Date(), lastError: '' });
  }

  private intentFor(order: Order, outbox?: PaymentOutbox | null, customerOpenid?: string): PaymentIntent {
    if (this.provider.requiresMerchantProfile && (!outbox?.paymentProfileId || !outbox.providerMerchantId || outbox.provider !== this.provider.providerName)) throw new ServiceUnavailableException('订单缺少有效的商家支付路由');
    return { orderId: order.id, orderNo: order.orderNo, merchantId: order.merchantId, amountFen: order.amountFen, expiresAt: new Date(order.paymentExpiresAt), idempotencyKey: `order-${order.id}`, paymentProfileId: outbox?.paymentProfileId || null, providerMerchantId: outbox?.providerMerchantId || null, provider: outbox?.provider || null, customerOpenid, orderCreatedAt: order.createdAt };
  }

  /** H-02：事件路由核对不再因 routing 模式跳过；校验订单对应的持久化渠道与事件来源一致。 */
  private assertEventRoute(event: NormalizedPaymentEvent, outbox: PaymentOutbox | null): void {
    if (!outbox) throw new BadRequestException('支付事件缺少订单对应的支付意图');
    // 渠道一致性：双方都有 provider 时必须一致（微信直连等无档案通道也可校验）。
    // `routing` 是旧版路由层持久化的包装名；订单 outbox 才保存真实底层渠道，
    // 对该兼容值按 outbox 路由继续处理，避免历史汇付成功事件无法补建延迟快照。
    if (outbox.provider && event.provider && event.provider.toUpperCase() !== 'ROUTING' && outbox.provider.toUpperCase() !== event.provider.toUpperCase()) {
      throw new BadRequestException(`支付事件来源渠道(${event.provider})与订单渠道(${outbox.provider})不匹配`);
    }
    // 商户号一致性：仅当双方都有值时校验（微信直连无商家级商户号）
    if (event.providerMerchantId && outbox.providerMerchantId && event.providerMerchantId !== outbox.providerMerchantId) {
      throw new BadRequestException('支付事件商户号与订单不匹配');
    }
  }

  private hash(value: Buffer): string { return createHash('sha256').update(value).digest('hex'); }
  /** H-03：幂等哈希移除接收时间（occurredAt），渠道无稳定事件时间时避免合法重投被 409。 */
  private normalizedHash(event: ResolvedPaymentEvent): string {
    const content: Record<string, unknown> = { eventType: event.eventType, merchantId: event.merchantId, amountFen: event.amountFen, orderNo: event.orderNo, providerEventId: event.providerEventId, providerPaymentReference: event.providerPaymentReference };
    if (event.fundControl) {
      content.fundControl = {
        status: event.fundControl.status,
        frozenAt: event.fundControl.frozenAt?.toISOString() || null,
        unfrozenAt: event.fundControl.unfrozenAt?.toISOString() || null,
        unfrozenAmountFen: event.fundControl.unfrozenAmountFen ?? null,
      };
    }
    if (this.provider.requiresMerchantProfile || event.providerMerchantId) {
      content.providerMerchantId = event.providerMerchantId;
    }
    return this.hash(Buffer.from(JSON.stringify(content), 'utf8'));
  }
  private retryAt(attemptCount: number): Date { return new Date(Date.now() + Math.min(MAX_RETRY_DELAY_MS, 30_000 * 2 ** Math.min(attemptCount, 5))); }
  private batchLimit(value: number): number { if (!Number.isInteger(value) || value < 1 || value > 1_000) throw new BadRequestException('待支付订单过期批量大小必须是 1 至 1000 的整数'); return value; }
  private isUniqueConstraintError(error: unknown): boolean { return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === '23505'; }
}
