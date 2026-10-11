import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { auditOutboxMaxAgeMs, auditOutboxPollIntervalMs, chinaOperationalCalendar, expiryQueueMaxAgeMs, expirySweepPollIntervalMs, exportQueueMaxAgeMs, lifecycleWorkerMaxStalenessMs, notificationFailureGraceMs, releaseId, usesEmbeddedDatabase } from './runtime-config';

type ExportQueueWorkerStatus = {
  pending: number;
  processing: number;
  failed: number;
  oldestPendingAt: Date | null;
  oldestProcessingAt: Date | null;
};

type AuditOutboxWorkerStatus = {
  pending: number;
  processing: number;
  quarantined: number;
  oldestPendingAt: Date | null;
  oldestProcessingAt: Date | null;
};

type NotificationOutboxWorkerStatus = {
  pending: number;
  processing: number;
  failed: number;
  newestFailedAt: Date | null;
  oldestPendingAt: Date | null;
  oldestProcessingAt: Date | null;
};

type ExpiryQueueWorkerStatus = {
  overdueOrders: number;
  overdueVouchers: number;
  oldestOverdueOrderAt: Date | null;
  oldestOverdueVoucherAt: Date | null;
};

type DatabasePoolStatus = {
  mode: 'embedded-demo' | 'postgresql';
  observability: 'not-applicable' | 'available' | 'unavailable';
  pressure: 'normal' | 'at-capacity' | 'waiting' | 'saturated' | 'unknown';
  maxConnections: number | null;
  totalConnections: number | null;
  idleConnections: number | null;
  waitingRequests: number | null;
};

type PostgreSqlPool = {
  totalCount?: unknown;
  idleCount?: unknown;
  waitingCount?: unknown;
  options?: { max?: unknown };
};

@Injectable()
export class HealthService {
  private acceptingTraffic = true;
  // A process serves one immutable artifact. Snapshot the release identity at
  // boot so health responses cannot drift if a test harness or runtime helper
  // mutates process environment variables after the instance is accepting
  // traffic.
  private readonly currentReleaseId = releaseId();
  private lifecycleWorkerConfigured = false;
  private lifecycleWorkerLastSuccessAt: Date | null = null;
  private lifecycleWorkerLastFailureAt: Date | null = null;
  private lifecycleWorkerExportQueue: ExportQueueWorkerStatus | null = null;
  private lifecycleWorkerAuditOutbox: AuditOutboxWorkerStatus | null = null;
  private lifecycleWorkerNotificationOutbox: NotificationOutboxWorkerStatus | null = null;
  private lifecycleWorkerExpiryQueue: ExpiryQueueWorkerStatus | null = null;
  private auditOutboxLastProcessedAt: Date | null = null;
  private auditOutboxLastFailureAt: Date | null = null;
  private auditOutboxLastBatchSigned = 0;
  private auditOutboxLastBatchQuarantined = 0;
  private expiryLastProcessedAt: Date | null = null;
  private expiryLastFailureAt: Date | null = null;
  private expiryLastBatchClosedOrders = 0;
  private expiryLastBatchExpiredVouchers = 0;

  constructor(private readonly dataSource: DataSource) {}

  markDraining(): void {
    this.acceptingTraffic = false;
  }

  markLifecycleWorkerConfigured(): void {
    this.lifecycleWorkerConfigured = true;
    this.lifecycleWorkerLastFailureAt = null;
  }

  markLifecycleWorkerSweepSucceeded(at = new Date(), exportQueue?: ExportQueueWorkerStatus, auditOutbox?: AuditOutboxWorkerStatus, expiryQueue?: ExpiryQueueWorkerStatus, notificationOutbox?: NotificationOutboxWorkerStatus): void {
    this.lifecycleWorkerLastSuccessAt = at;
    this.lifecycleWorkerLastFailureAt = null;
    if (exportQueue) this.lifecycleWorkerExportQueue = exportQueue;
    if (auditOutbox) this.lifecycleWorkerAuditOutbox = auditOutbox;
    if (expiryQueue) this.lifecycleWorkerExpiryQueue = expiryQueue;
    if (notificationOutbox) this.lifecycleWorkerNotificationOutbox = notificationOutbox;
  }

  markLifecycleWorkerSweepFailed(at = new Date()): void {
    this.lifecycleWorkerLastFailureAt = at;
  }

  markLifecycleWorkerAuditOutboxProcessed(auditOutbox: AuditOutboxWorkerStatus, signed: number, quarantined: number, at = new Date()): void {
    this.lifecycleWorkerAuditOutbox = auditOutbox;
    this.auditOutboxLastProcessedAt = at;
    this.auditOutboxLastFailureAt = null;
    this.auditOutboxLastBatchSigned = signed;
    this.auditOutboxLastBatchQuarantined = quarantined;
  }

  markLifecycleWorkerAuditOutboxFailed(at = new Date()): void {
    this.auditOutboxLastFailureAt = at;
  }

  markLifecycleWorkerExpiryProcessed(expiryQueue: ExpiryQueueWorkerStatus, closedOrders: number, expiredVouchers: number, at = new Date()): void {
    this.lifecycleWorkerExpiryQueue = expiryQueue;
    this.expiryLastProcessedAt = at;
    this.expiryLastFailureAt = null;
    this.expiryLastBatchClosedOrders = closedOrders;
    this.expiryLastBatchExpiredVouchers = expiredVouchers;
  }

  markLifecycleWorkerExpiryFailed(at = new Date()): void {
    this.expiryLastFailureAt = at;
  }

  live() {
    return { status: 'ok', service: 'local-deals-api', releaseId: this.currentReleaseId, timestamp: new Date().toISOString() };
  }

  publicLive() {
    return { status: 'ok' };
  }

  async publicReady() {
    try {
      await this.ready();
      return { status: 'ok' };
    } catch {
      throw new ServiceUnavailableException('服务暂不可用');
    }
  }

  publicWorkerReady() {
    try {
      this.workerReady();
      return { status: 'ok' };
    } catch {
      throw new ServiceUnavailableException('服务暂不可用');
    }
  }

  workerStatus() {
    const now = Date.now();
    const exportQueue = this.lifecycleWorkerExportQueue;
    const auditOutbox = this.lifecycleWorkerAuditOutbox;
    const expiryQueue = this.lifecycleWorkerExpiryQueue;
    return {
      configured: this.lifecycleWorkerConfigured,
      lastSuccessAt: this.lifecycleWorkerLastSuccessAt?.toISOString() || null,
      lastFailureAt: this.lifecycleWorkerLastFailureAt?.toISOString() || null,
      maxStalenessSeconds: lifecycleWorkerMaxStalenessMs() / 1000,
      exportQueue: exportQueue ? {
        pending: exportQueue.pending,
        processing: exportQueue.processing,
        failed: exportQueue.failed,
        oldestPendingAt: exportQueue.oldestPendingAt?.toISOString() || null,
        oldestPendingAgeSeconds: exportQueue.oldestPendingAt ? Math.max(0, Math.floor((now - exportQueue.oldestPendingAt.getTime()) / 1000)) : null,
        oldestProcessingAt: exportQueue.oldestProcessingAt?.toISOString() || null,
        oldestProcessingAgeSeconds: exportQueue.oldestProcessingAt ? Math.max(0, Math.floor((now - exportQueue.oldestProcessingAt.getTime()) / 1000)) : null,
        maxAgeSeconds: exportQueueMaxAgeMs() / 1000,
      } : null,
      auditOutbox: auditOutbox ? {
        pending: auditOutbox.pending,
        processing: auditOutbox.processing,
        quarantined: auditOutbox.quarantined,
        pollIntervalSeconds: auditOutboxPollIntervalMs() / 1000,
        lastProcessedAt: this.auditOutboxLastProcessedAt?.toISOString() || null,
        lastFailureAt: this.auditOutboxLastFailureAt?.toISOString() || null,
        lastBatchSigned: this.auditOutboxLastBatchSigned,
        lastBatchQuarantined: this.auditOutboxLastBatchQuarantined,
        oldestPendingAt: auditOutbox.oldestPendingAt?.toISOString() || null,
        oldestPendingAgeSeconds: auditOutbox.oldestPendingAt ? Math.max(0, Math.floor((now - auditOutbox.oldestPendingAt.getTime()) / 1000)) : null,
        oldestProcessingAt: auditOutbox.oldestProcessingAt?.toISOString() || null,
        oldestProcessingAgeSeconds: auditOutbox.oldestProcessingAt ? Math.max(0, Math.floor((now - auditOutbox.oldestProcessingAt.getTime()) / 1000)) : null,
        maxAgeSeconds: auditOutboxMaxAgeMs() / 1000,
      } : null,
      notificationOutbox: this.lifecycleWorkerNotificationOutbox ? {
        pending: this.lifecycleWorkerNotificationOutbox.pending,
        processing: this.lifecycleWorkerNotificationOutbox.processing,
        failed: this.lifecycleWorkerNotificationOutbox.failed,
        newestFailedAt: this.lifecycleWorkerNotificationOutbox.newestFailedAt?.toISOString() || null,
        newestFailedAgeSeconds: this.lifecycleWorkerNotificationOutbox.newestFailedAt ? Math.max(0, Math.floor((now - this.lifecycleWorkerNotificationOutbox.newestFailedAt.getTime()) / 1000)) : null,
        oldestPendingAt: this.lifecycleWorkerNotificationOutbox.oldestPendingAt?.toISOString() || null,
        oldestProcessingAt: this.lifecycleWorkerNotificationOutbox.oldestProcessingAt?.toISOString() || null,
        oldestPendingAgeSeconds: this.lifecycleWorkerNotificationOutbox.oldestPendingAt ? Math.max(0, Math.floor((now - this.lifecycleWorkerNotificationOutbox.oldestPendingAt.getTime()) / 1000)) : null,
        oldestProcessingAgeSeconds: this.lifecycleWorkerNotificationOutbox.oldestProcessingAt ? Math.max(0, Math.floor((now - this.lifecycleWorkerNotificationOutbox.oldestProcessingAt.getTime()) / 1000)) : null,
        maxAgeSeconds: auditOutboxMaxAgeMs() / 1000,
      } : null,
      expiryQueue: expiryQueue ? {
        overdueOrders: expiryQueue.overdueOrders,
        overdueVouchers: expiryQueue.overdueVouchers,
        pollIntervalSeconds: expirySweepPollIntervalMs() / 1000,
        lastProcessedAt: this.expiryLastProcessedAt?.toISOString() || null,
        lastFailureAt: this.expiryLastFailureAt?.toISOString() || null,
        lastBatchClosedOrders: this.expiryLastBatchClosedOrders,
        lastBatchExpiredVouchers: this.expiryLastBatchExpiredVouchers,
        oldestOverdueOrderAt: expiryQueue.oldestOverdueOrderAt?.toISOString() || null,
        oldestOverdueOrderAgeSeconds: expiryQueue.oldestOverdueOrderAt ? Math.max(0, Math.floor((now - expiryQueue.oldestOverdueOrderAt.getTime()) / 1000)) : null,
        oldestOverdueVoucherAt: expiryQueue.oldestOverdueVoucherAt?.toISOString() || null,
        oldestOverdueVoucherAgeSeconds: expiryQueue.oldestOverdueVoucherAt ? Math.max(0, Math.floor((now - expiryQueue.oldestOverdueVoucherAt.getTime()) / 1000)) : null,
        maxAgeSeconds: expiryQueueMaxAgeMs() / 1000,
      } : null,
    };
  }

  private operationalCalendarStatus() {
    const calendar = chinaOperationalCalendar();
    return { validThrough: calendar.validThrough, holidays: calendar.holidays.size, compensatoryWorkdays: calendar.workingDays.size };
  }

  private assertOperationalCalendar() {
    try {
      return this.operationalCalendarStatus();
    } catch (error) {
      throw new ServiceUnavailableException(error instanceof Error ? `运营日历不可用：${error.message}` : '运营日历不可用');
    }
  }

  private poolCount(value: unknown): number | null {
    return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
  }

  private databasePoolStatus(usesRealPostgres: boolean): DatabasePoolStatus {
    if (!usesRealPostgres) {
      return {
        mode: 'embedded-demo', observability: 'not-applicable', pressure: 'unknown',
        maxConnections: null, totalConnections: null, idleConnections: null, waitingRequests: null,
      };
    }
    const driver = this.dataSource.driver as unknown as { master?: unknown } | undefined;
    const pool = driver?.master as PostgreSqlPool | undefined;
    const maxConnections = this.poolCount(pool?.options?.max);
    const totalConnections = this.poolCount(pool?.totalCount);
    const idleConnections = this.poolCount(pool?.idleCount);
    const waitingRequests = this.poolCount(pool?.waitingCount);
    if (maxConnections === null || totalConnections === null || idleConnections === null || waitingRequests === null) {
      return {
        mode: 'postgresql', observability: 'unavailable', pressure: 'unknown',
        maxConnections, totalConnections, idleConnections, waitingRequests,
      };
    }
    const atCapacity = totalConnections >= maxConnections;
    const pressure = waitingRequests > 0 ? atCapacity ? 'saturated' : 'waiting' : atCapacity ? 'at-capacity' : 'normal';
    return {
      mode: 'postgresql', observability: 'available', pressure,
      maxConnections, totalConnections, idleConnections, waitingRequests,
    };
  }

  workerReady() {
    const operationalCalendar = this.assertOperationalCalendar();
    if (!this.lifecycleWorkerConfigured) throw new ServiceUnavailableException('本实例未配置生命周期工作器');
    const lastSuccess = this.lifecycleWorkerLastSuccessAt;
    if (!lastSuccess) throw new ServiceUnavailableException('生命周期工作器尚未完成首轮任务');
    const now = Date.now();
    if (now - lastSuccess.getTime() > lifecycleWorkerMaxStalenessMs()) throw new ServiceUnavailableException('生命周期工作器心跳已超时');
    const exportQueue = this.lifecycleWorkerExportQueue;
    const maximumQueueAge = exportQueueMaxAgeMs();
    if (exportQueue?.oldestPendingAt && now - exportQueue.oldestPendingAt.getTime() > maximumQueueAge) throw new ServiceUnavailableException('导出任务队列等待超时');
    if (exportQueue?.oldestProcessingAt && now - exportQueue.oldestProcessingAt.getTime() > maximumQueueAge) throw new ServiceUnavailableException('导出任务处理超时');
    const auditOutbox = this.lifecycleWorkerAuditOutbox;
    const maximumAuditOutboxAge = auditOutboxMaxAgeMs();
    if (auditOutbox?.quarantined) throw new ServiceUnavailableException('存在隔离的审计 outbox 事件');
    if (auditOutbox?.oldestPendingAt && now - auditOutbox.oldestPendingAt.getTime() > maximumAuditOutboxAge) throw new ServiceUnavailableException('审计 outbox 队列等待超时');
    if (auditOutbox?.oldestProcessingAt && now - auditOutbox.oldestProcessingAt.getTime() > maximumAuditOutboxAge) throw new ServiceUnavailableException('审计 outbox 处理超时');
    const notificationOutbox = this.lifecycleWorkerNotificationOutbox;
    // 终态 FAILED 是"8 次尝试后放弃"的死信，不代表 worker 停止工作，历史死信不再阻塞存活判定；
    // 仅在宽限窗口内出现新失败时视为渠道正在故障，需要告警。
    if (notificationOutbox?.newestFailedAt && now - notificationOutbox.newestFailedAt.getTime() < notificationFailureGraceMs()) throw new ServiceUnavailableException('近期存在失败的通知 outbox 事件');
    if (notificationOutbox?.oldestPendingAt && now - notificationOutbox.oldestPendingAt.getTime() > maximumAuditOutboxAge) throw new ServiceUnavailableException('通知 outbox 队列等待超时');
    if (notificationOutbox?.oldestProcessingAt && now - notificationOutbox.oldestProcessingAt.getTime() > maximumAuditOutboxAge) throw new ServiceUnavailableException('通知 outbox 处理超时');
    const expiryQueue = this.lifecycleWorkerExpiryQueue;
    const maximumExpiryQueueAge = expiryQueueMaxAgeMs();
    if (expiryQueue?.oldestOverdueOrderAt && now - expiryQueue.oldestOverdueOrderAt.getTime() > maximumExpiryQueueAge) throw new ServiceUnavailableException('过期订单清扫超时');
    if (expiryQueue?.oldestOverdueVoucherAt && now - expiryQueue.oldestOverdueVoucherAt.getTime() > maximumExpiryQueueAge) throw new ServiceUnavailableException('过期券清扫超时');
    return { ...this.live(), worker: 'ok', ...this.workerStatus(), databasePool: this.databasePoolStatus(!usesEmbeddedDatabase()), operationalCalendar };
  }

  async ready() {
    if (!this.acceptingTraffic) throw new ServiceUnavailableException('实例正在停止接流');
    if (!this.dataSource.isInitialized) throw new ServiceUnavailableException('数据库尚未就绪');
    const operationalCalendar = this.assertOperationalCalendar();
    try {
      await this.dataSource.query('SELECT 1');
      const usesRealPostgres = !usesEmbeddedDatabase();
      let databaseTimeZone: string | null = null;
      if (usesRealPostgres) {
        const rows = await this.dataSource.query("SELECT current_setting('TimeZone') AS timezone") as Array<{ timezone?: unknown }>;
        databaseTimeZone = String(rows?.[0]?.timezone || '');
        if (databaseTimeZone !== 'UTC') throw new ServiceUnavailableException('数据库会话时区不是 UTC');
      }
      if (usesRealPostgres && await this.dataSource.showMigrations()) throw new ServiceUnavailableException('数据库迁移尚未完成');
      return { ...this.live(), mode: usesRealPostgres ? 'postgresql' : 'embedded-demo', database: 'ok', databaseTimeZone, migrations: usesRealPostgres ? 'current' : 'not-applicable', databasePool: this.databasePoolStatus(usesRealPostgres), worker: this.workerStatus(), operationalCalendar };
    } catch (error) {
      if (error instanceof ServiceUnavailableException) throw error;
      throw new ServiceUnavailableException('数据库暂不可用');
    }
  }
}
