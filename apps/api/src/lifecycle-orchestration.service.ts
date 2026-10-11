import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, LessThan, Repository } from 'typeorm';
import { MonthlyBillGenerationCommand, Order, OrderStatus, User, UserRole, Voucher, VoucherStatus } from './domain/entities';
import { AuditWriterService } from './audit-writer.service';
import { AuditOutboxService } from './audit-outbox.service';
import { NotificationOutboxService } from './notifications/notification-outbox.service';
import { RequestThrottleService } from './request-throttle.service';
import { AuthService } from './auth.service';
import { BatchOperationService } from './batch-operation.service';
import { MerchantImportService } from './merchant-import.service';
import { ExportService } from './export.service';
import { RefundService } from './refund.service';
import { PaymentProcessingService } from './payment-processing.service';
import { MerchantExitService } from './merchant-exit.service';
import { BillingService } from './billing.service';
import { AgencyCooperationService } from './agency-cooperation.service';
import { WechatPlatformService } from './wechat-platform.service';
import { DelayedSettlementService } from './delayed-settlement.service';
import { auditOutboxBatchSize, expirySweepBatchSize, exportWorkerBatchSize } from './runtime-config';
import type { ExpiryQueueSnapshot, LifecycleSweepResult } from './app-service.core-types';

const PAYMENT_OUTBOX_BATCH_SIZE = 20;

@Injectable()
export class LifecycleOrchestrationService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly auditWriter: AuditWriterService,
    private readonly auditOutbox: AuditOutboxService,
    private readonly notificationOutbox: NotificationOutboxService,
    private readonly requestThrottle: RequestThrottleService,
    private readonly authService: AuthService,
    private readonly batchOperationService: BatchOperationService,
    private readonly merchantImportService: MerchantImportService,
    private readonly exportService: ExportService,
    private readonly refundService: RefundService,
    private readonly paymentProcessing: PaymentProcessingService,
    private readonly merchantExitService: MerchantExitService,
    private readonly billingService: BillingService,
    private readonly agencyCooperation: AgencyCooperationService,
    private readonly wechatPlatform: WechatPlatformService,
    private readonly delayedSettlement: DelayedSettlementService,
    @InjectRepository(Order) private readonly orders: Repository<Order>,
    @InjectRepository(Voucher) private readonly vouchers: Repository<Voucher>,
  ) {}

  /**
   * 支付查单快速补偿：独立于完整 sweep 的轻量循环（支付确认时效优先）。
   * 只做 DISPATCHED 意图查单，不碰投递、滞留补偿与过期清扫，保持最小职责。
   */
  async runPaymentReconciliation(): Promise<{ queried: number; recovered: number; failed: number }> {
    const paymentReconciliation = await this.paymentProcessing.reconcileDispatchedIntents(PAYMENT_OUTBOX_BATCH_SIZE);
    return { queried: paymentReconciliation.queried, recovered: paymentReconciliation.recovered, failed: paymentReconciliation.failed };
  }

  async runSweep(): Promise<LifecycleSweepResult> {
    await this.wechatPlatform.processWechatSyncTasks(20);
    const paymentDispatch = await this.paymentProcessing.dispatchPendingIntents(PAYMENT_OUTBOX_BATCH_SIZE);
    const paymentReconciliation = await this.paymentProcessing.reconcileDispatchedIntents(PAYMENT_OUTBOX_BATCH_SIZE);
    // #2：滞留事件（订单关闭后支付成功迟到）补偿——查单确认渠道状态，补发券或落终态
    const staleEventReconciliation = await this.paymentProcessing.reconcileNeedsReconciliation(PAYMENT_OUTBOX_BATCH_SIZE);
    const delayedSettlement = await this.delayedSettlement.processConfirmations(PAYMENT_OUTBOX_BATCH_SIZE);
    const expiryProcessing = await this.processExpiryQueues();
    const [purgeEligibleExitCases, _batchOperations, _merchantImports, clearedRequestThrottles, clearedLoginThrottles, refundRecovery, expiredExportJobs, exportProcessing, billLifecycle, staleEntitlementsReleased] = await Promise.all([
      this.merchantExitService.advanceRetention(), this.batchOperationService.processPending(), this.merchantImportService.processPending(), this.requestThrottle.purgeExpired(), this.authService.purgeExpiredLoginThrottles(), this.refundService.recoverStale(), this.exportService.expire(), this.exportService.process(exportWorkerBatchSize()), this.billingService.advanceBills(), this.agencyCooperation.reconcileStaleReservations(),
    ]);
    // FIX: 月度任务——每月自动生成上月本地服务费月结账单（幂等：同账期生成命令存在即跳过；失败不阻断本轮 sweep，下轮重试）
    await this.generateMonthlyBillsIfDue();
    const auditProcessing = await this.auditOutbox.process(auditOutboxBatchSize());
    const notificationProcessing = await this.notificationOutbox.process();
    const [exportQueue, auditOutbox, notificationOutbox] = await Promise.all([this.exportService.queueStatus(), this.auditOutbox.queueStatus(), this.notificationOutbox.queueStatus()]);
    return {
      closedOrders: expiryProcessing.closedOrders, expiredVouchers: expiryProcessing.expiredVouchers, suspendedContracts: 0,
      confirmedBills: billLifecycle.confirmed, overdueBills: billLifecycle.overdue, suspendedForOverdueBills: 0,
      purgeEligibleExitCases, clearedRequestThrottles, clearedLoginThrottles, recoveredRefunds: refundRecovery.recovered,
      failedRefundRecoveries: refundRecovery.failed, staleEntitlementsReleased, dispatchedPaymentIntents: paymentDispatch.dispatched,
      retriedPaymentIntents: paymentDispatch.retried, reconciledPaymentIntents: paymentReconciliation.recovered,
      failedPaymentReconciliations: paymentReconciliation.failed, reconciledStaleEvents: staleEventReconciliation.recovered,
      delayedSettlementConfirmations: delayedSettlement.confirmed, delayedSettlementRetries: delayedSettlement.retried, delayedSettlementQueries: delayedSettlement.queried,
      expiredExportJobs, completedExportJobs: exportProcessing.completed,
      failedExportJobs: exportProcessing.failed, exportQueue, expiryQueue: expiryProcessing.expiryQueue,
      signedAuditEvents: auditProcessing.signed, quarantinedAuditEvents: auditProcessing.quarantined, auditOutbox,
      sentNotifications: notificationProcessing.sent, failedNotifications: notificationProcessing.failed, notificationOutbox,
    };
  }

  private async generateMonthlyBillsIfDue(): Promise<void> {
    try {
      const today = this.day();
      const year = Number(today.slice(0, 4));
      const month = Number(today.slice(5, 7));
      // 上月（1 月 → 上年 12 月，注意 JS 负数取模会出 0，避免使用取模）
      const lastMonthYear = month === 1 ? year - 1 : year;
      const lastMonth = `${lastMonthYear}-${String(month === 1 ? 12 : month - 1).padStart(2, '0')}`;
      // 幂等：该账期已有生成命令（人工或定时）即跳过
      const existing = await this.dataSource.manager.findOneBy(MonthlyBillGenerationCommand, { period: lastMonth });
      if (existing) return;
      const admin = await this.dataSource.manager.findOne(User, { where: { role: UserRole.PLATFORM_ADMIN, active: true }, order: { createdAt: 'ASC' } });
      if (!admin) return;
      await this.billingService.generateBills(admin, lastMonth, `cron-${lastMonth}`);
    } catch {
      // 生成失败（如并发竞争）不阻断本轮 sweep，下轮幂等重试
    }
  }

  async processExpiryQueues(): Promise<{ closedOrders: number; expiredVouchers: number; expiryQueue: ExpiryQueueSnapshot }> {
    const batchSize = expirySweepBatchSize();
    const [closedOrders, expiredVouchers] = await Promise.all([
      this.paymentProcessing.expirePendingOrders(true, batchSize),
      this.expireVouchers(batchSize),
    ]);
    return { closedOrders, expiredVouchers, expiryQueue: await this.expiryQueueStatus() };
  }

  private async expireVouchers(limit: number): Promise<number> {
    const batchLimit = this.requiredInteger(limit, '券过期批量大小', 1, 1_000);
    return this.dataSource.transaction(async (manager) => {
      const expired = await manager.find(Voucher, { where: { status: VoucherStatus.UNUSED, validTo: LessThan(this.businessDayStart()) }, order: { validTo: 'ASC', id: 'ASC' }, take: batchLimit, lock: { mode: 'pessimistic_write' } });
      if (expired.length) {
        await manager.update(Voucher, { id: In(expired.map((voucher) => voucher.id)) }, { status: VoucherStatus.EXPIRED });
        for (const voucher of expired) await this.auditWriter.write('system', voucher.merchantId, 'VOUCHER_EXPIRED', 'Voucher', voucher.id, { status: VoucherStatus.UNUSED }, { status: VoucherStatus.EXPIRED }, manager);
      }
      return expired.length;
    });
  }

  private async expiryQueueStatus(): Promise<ExpiryQueueSnapshot> {
    const now = new Date();
    const businessDay = this.businessDayStart();
    const overdueOrder = { status: OrderStatus.PENDING_PAYMENT, paymentExpiresAt: LessThan(now) };
    const overdueVoucher = { status: VoucherStatus.UNUSED, validTo: LessThan(businessDay) };
    const [overdueOrders, overdueVouchers, oldestOverdueOrder, oldestOverdueVoucher] = await Promise.all([
      this.orders.countBy(overdueOrder),
      this.vouchers.countBy(overdueVoucher),
      this.orders.findOne({ where: overdueOrder, select: { id: true, paymentExpiresAt: true }, order: { paymentExpiresAt: 'ASC', id: 'ASC' } }),
      this.vouchers.findOne({ where: overdueVoucher, select: { id: true, validTo: true }, order: { validTo: 'ASC', id: 'ASC' } }),
    ]);
    return {
      overdueOrders, overdueVouchers,
      oldestOverdueOrderAt: oldestOverdueOrder?.paymentExpiresAt || null,
      oldestOverdueVoucherAt: oldestOverdueVoucher?.validTo || null,
    };
  }

  private day(date: Date | string = new Date()): string {
    const values = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(date)).filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
    return `${values.year}-${values.month}-${values.day}`;
  }

  private businessDayStart(day = this.day()): Date { return new Date(`${day}T00:00:00+08:00`); }

  private requiredInteger(value: unknown, label: string, min: number, max: number): number {
    const number = Number(value);
    if (!Number.isInteger(number) || number < min || number > max) throw new BadRequestException(`${label}必须为 ${min} 至 ${max} 的整数`);
    return number;
  }
}
