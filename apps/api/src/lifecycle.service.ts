import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { DataSource, QueryRunner } from 'typeorm';
import { LifecycleOrchestrationService } from './lifecycle-orchestration.service';
import { auditOutboxBatchSize, auditOutboxPollIntervalMs, expirySweepPollIntervalMs, lifecycleSweepPollIntervalMs, paymentReconciliationPollIntervalMs, usesEmbeddedDatabase } from './runtime-config';
import { HealthService } from './health.service';
import { AuditOutboxService } from './audit-outbox.service';

@Injectable()
export class LifecycleService implements OnApplicationBootstrap, OnApplicationShutdown {
  private static readonly advisoryLockId = 6_418_042;
  private readonly logger = new Logger(LifecycleService.name);
  private timer: NodeJS.Timeout | undefined;
  private auditOutboxTimer: NodeJS.Timeout | undefined;
  private expiryTimer: NodeJS.Timeout | undefined;
  private paymentReconciliationTimer: NodeJS.Timeout | undefined;
  private running = false;
  private auditOutboxRunning = false;
  private expiryRunning = false;
  private paymentReconciliationRunning = false;

  constructor(private readonly lifecycle: LifecycleOrchestrationService, private readonly auditOutbox: AuditOutboxService, private readonly dataSource: DataSource, private readonly health: HealthService) {}

  onApplicationBootstrap() {
    if (!this.shouldRunWorker()) return;
    this.health.markLifecycleWorkerConfigured();
    void this.sweep();
    void this.auditOutboxSweep();
    void this.expirySweep();
    void this.paymentReconciliationSweep();
    this.timer = setInterval(() => void this.sweep(), lifecycleSweepPollIntervalMs());
    this.auditOutboxTimer = setInterval(() => void this.auditOutboxSweep(), auditOutboxPollIntervalMs());
    this.expiryTimer = setInterval(() => void this.expirySweep(), expirySweepPollIntervalMs());
    this.paymentReconciliationTimer = setInterval(() => void this.paymentReconciliationSweep(), paymentReconciliationPollIntervalMs());
  }

  onApplicationShutdown() {
    if (this.timer) clearInterval(this.timer);
    if (this.auditOutboxTimer) clearInterval(this.auditOutboxTimer);
    if (this.expiryTimer) clearInterval(this.expiryTimer);
    if (this.paymentReconciliationTimer) clearInterval(this.paymentReconciliationTimer);
  }

  private shouldRunWorker(): boolean {
    if (process.env.RUN_LIFECYCLE_WORKER === 'true') return true;
    if (process.env.RUN_LIFECYCLE_WORKER === 'false') return false;
    return usesEmbeddedDatabase();
  }

  private usesSharedPostgres(): boolean {
    return !usesEmbeddedDatabase();
  }

  private acquired(result: unknown): boolean {
    const value = Array.isArray(result) && result[0] && typeof result[0] === 'object' ? (result[0] as Record<string, unknown>).locked : false;
    return value === true || value === 'true' || value === 't' || value === 1;
  }

  private async acquireWorkerLease(): Promise<{ queryRunner?: QueryRunner; acquired: boolean }> {
    if (!this.usesSharedPostgres()) return { acquired: true };
    const queryRunner = this.dataSource.createQueryRunner();
    try {
      await queryRunner.connect();
      const acquired = this.acquired(await queryRunner.query('SELECT pg_try_advisory_lock($1) AS locked', [LifecycleService.advisoryLockId]));
      if (acquired) return { queryRunner, acquired: true };
      await queryRunner.release();
      return { acquired: false };
    } catch (error) {
      await queryRunner.release().catch(() => undefined);
      throw error;
    }
  }

  private async releaseWorkerLease(queryRunner?: QueryRunner): Promise<void> {
    if (!queryRunner) return;
    try {
      await queryRunner.query('SELECT pg_advisory_unlock($1)', [LifecycleService.advisoryLockId]);
    } catch (error) {
      this.logger.error('生命周期锁释放失败', error instanceof Error ? error.stack : String(error));
    } finally {
      await queryRunner.release();
    }
  }

  private async sweep() {
    if (this.running) return;
    this.running = true;
    let queryRunner: QueryRunner | undefined;
    try {
      const lease = await this.acquireWorkerLease();
      if (!lease.acquired) return;
      queryRunner = lease.queryRunner;
      const result = await this.lifecycle.runSweep();
      this.health.markLifecycleWorkerSweepSucceeded(new Date(), result.exportQueue, result.auditOutbox, result.expiryQueue, result.notificationOutbox);
      const notificationQueue = result.notificationOutbox;
      if (result.closedOrders || result.expiredVouchers || result.suspendedContracts || result.confirmedBills || result.overdueBills || result.suspendedForOverdueBills || result.purgeEligibleExitCases || result.clearedRequestThrottles || result.clearedLoginThrottles || result.recoveredRefunds || result.failedRefundRecoveries || result.dispatchedPaymentIntents || result.retriedPaymentIntents || result.reconciledPaymentIntents || result.failedPaymentReconciliations || result.expiredExportJobs || result.completedExportJobs || result.failedExportJobs || result.signedAuditEvents || result.quarantinedAuditEvents || result.sentNotifications || result.failedNotifications || result.exportQueue.pending || result.exportQueue.processing || result.exportQueue.failed || result.expiryQueue.overdueOrders || result.expiryQueue.overdueVouchers || result.auditOutbox.pending || result.auditOutbox.processing || result.auditOutbox.quarantined || notificationQueue?.pending || notificationQueue?.processing || notificationQueue?.failed) this.logger.log(`生命周期清理完成: 关闭待支付订单 ${result.closedOrders}，过期券 ${result.expiredVouchers}，合同到期停售 ${result.suspendedContracts}，确认账单 ${result.confirmedBills}，逾期账单 ${result.overdueBills}，账单逾期停售 ${result.suspendedForOverdueBills}，离场清理资格 ${result.purgeEligibleExitCases}，清理请求限流 ${result.clearedRequestThrottles}，清理登录限流 ${result.clearedLoginThrottles}，恢复退款 ${result.recoveredRefunds}，恢复失败 ${result.failedRefundRecoveries}，支付意图投递 ${result.dispatchedPaymentIntents}，支付意图重试 ${result.retriedPaymentIntents}，支付查单补偿 ${result.reconciledPaymentIntents}，查单失败 ${result.failedPaymentReconciliations}，过期导出 ${result.expiredExportJobs}，完成导出 ${result.completedExportJobs}，失败导出 ${result.failedExportJobs}，已签名审计 ${result.signedAuditEvents}，隔离审计 ${result.quarantinedAuditEvents}，通知发送 ${result.sentNotifications || 0}，通知终态失败 ${result.failedNotifications || 0}，导出待处理 ${result.exportQueue.pending}，导出处理中 ${result.exportQueue.processing}，导出失败待查 ${result.exportQueue.failed}，待清扫订单 ${result.expiryQueue.overdueOrders}，待清扫券 ${result.expiryQueue.overdueVouchers}，审计待签名 ${result.auditOutbox.pending}，审计签名中 ${result.auditOutbox.processing}，审计隔离 ${result.auditOutbox.quarantined}，通知待处理 ${notificationQueue?.pending || 0}，通知处理中 ${notificationQueue?.processing || 0}，通知失败 ${notificationQueue?.failed || 0}`);
    } catch (error) {
      this.health.markLifecycleWorkerSweepFailed();
      this.logger.error('生命周期清理失败', error instanceof Error ? error.stack : String(error));
    } finally {
      await this.releaseWorkerLease(queryRunner);
      this.running = false;
    }
  }

  private async auditOutboxSweep() {
    if (this.auditOutboxRunning) return;
    this.auditOutboxRunning = true;
    let queryRunner: QueryRunner | undefined;
    try {
      const lease = await this.acquireWorkerLease();
      if (!lease.acquired) return;
      queryRunner = lease.queryRunner;
      const processing = await this.auditOutbox.process(auditOutboxBatchSize());
      const queue = await this.auditOutbox.queueStatus();
      this.health.markLifecycleWorkerAuditOutboxProcessed(queue, processing.signed, processing.quarantined);
      if (processing.signed || processing.quarantined || queue.pending || queue.processing || queue.quarantined) this.logger.log(`审计 outbox 批处理完成: 已签名 ${processing.signed}，隔离 ${processing.quarantined}，待签名 ${queue.pending}，处理中 ${queue.processing}，隔离待查 ${queue.quarantined}`);
    } catch (error) {
      this.health.markLifecycleWorkerAuditOutboxFailed();
      this.logger.error('审计 outbox 批处理失败', error instanceof Error ? error.stack : String(error));
    } finally {
      await this.releaseWorkerLease(queryRunner);
      this.auditOutboxRunning = false;
    }
  }

  private async expirySweep() {
    if (this.expiryRunning) return;
    this.expiryRunning = true;
    let queryRunner: QueryRunner | undefined;
    try {
      const lease = await this.acquireWorkerLease();
      if (!lease.acquired) return;
      queryRunner = lease.queryRunner;
      const result = await this.lifecycle.processExpiryQueues();
      this.health.markLifecycleWorkerExpiryProcessed(result.expiryQueue, result.closedOrders, result.expiredVouchers);
      if (result.closedOrders || result.expiredVouchers || result.expiryQueue.overdueOrders || result.expiryQueue.overdueVouchers) this.logger.log(`过期队列批处理完成: 关闭待支付订单 ${result.closedOrders}，过期券 ${result.expiredVouchers}，待清扫订单 ${result.expiryQueue.overdueOrders}，待清扫券 ${result.expiryQueue.overdueVouchers}`);
    } catch (error) {
      this.health.markLifecycleWorkerExpiryFailed();
      this.logger.error('过期队列批处理失败', error instanceof Error ? error.stack : String(error));
    } finally {
      await this.releaseWorkerLease(queryRunner);
      this.expiryRunning = false;
    }
  }

  /** 支付查单快速补偿：独立高频循环，让刚支付订单在秒级确认，不等待完整 sweep。 */
  private async paymentReconciliationSweep() {
    if (this.paymentReconciliationRunning) return;
    this.paymentReconciliationRunning = true;
    let queryRunner: QueryRunner | undefined;
    try {
      const lease = await this.acquireWorkerLease();
      if (!lease.acquired) return;
      queryRunner = lease.queryRunner;
      const result = await this.lifecycle.runPaymentReconciliation();
      if (result.queried || result.recovered || result.failed) this.logger.log(`支付查单快速补偿完成: 查询 ${result.queried}，确认 ${result.recovered}，失败 ${result.failed}`);
    } catch (error) {
      this.logger.error('支付查单快速补偿失败', error instanceof Error ? error.stack : String(error));
    } finally {
      await this.releaseWorkerLease(queryRunner);
      this.paymentReconciliationRunning = false;
    }
  }
}
