import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { AuditOutbox, AuditOutboxStatus } from './domain/entities';
import { AuditAppendInput, AuditChainService } from './audit-chain.service';
import { claimWithTransientEmptyRetry } from './outbox-claim-retry';
import { isLocalOrTestEnvironment, usesEmbeddedDatabase } from './runtime-config';

const AUDIT_OUTBOX_PROCESSING_STALE_MS = 5 * 60_000;

export type AuditOutboxQueueSnapshot = {
  pending: number;
  processing: number;
  quarantined: number;
  oldestPendingAt: Date | null;
  oldestProcessingAt: Date | null;
};

export type AuditOutboxProcessResult = { signed: number; quarantined: number };

@Injectable()
export class AuditOutboxService {
  private processor: Promise<AuditOutboxProcessResult> | null = null;

  constructor(
    @InjectRepository(AuditOutbox) private readonly outbox: Repository<AuditOutbox>,
    private readonly dataSource: DataSource,
    private readonly auditChain: AuditChainService,
  ) {}

  async enqueue(manager: EntityManager, input: AuditAppendInput): Promise<void> {
    // The in-memory pilot signs immediately so local demonstrations and their
    // audit screens remain synchronous. Shared deployments always use outbox.
    if (isLocalOrTestEnvironment()) {
      await this.auditChain.append(manager, input);
      return;
    }
    const createdAt = new Date();
    const event = { ...input, createdAt };
    await manager.save(AuditOutbox, manager.create(AuditOutbox, {
      ...event,
      outboxVersion: 1,
      payloadHash: this.auditChain.outboxPayloadHash(event),
      status: AuditOutboxStatus.PENDING,
      attemptCount: 0,
      lastAttemptAt: null,
      signedAt: null,
      signedAuditLogId: null,
      failureReason: '',
    }));
  }

  async process(limit = 100): Promise<AuditOutboxProcessResult> {
    if (this.processor) return this.processor;
    const task = this.processInternal(limit);
    this.processor = task;
    try {
      return await task;
    } finally {
      if (this.processor === task) this.processor = null;
    }
  }

  private async processInternal(limit: number): Promise<AuditOutboxProcessResult> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error('审计 outbox 批量大小必须是 1 至 500 的整数');
    let signed = 0;
    let quarantined = 0;
    for (let index = 0; index < limit; index += 1) {
      const event = await claimWithTransientEmptyRetry(() => this.claim());
      if (!event) break;
      try {
        const outcome = await this.sign(event.id, event.attemptCount);
        if (outcome === 'signed') signed += 1;
        if (outcome === 'quarantined') quarantined += 1;
      } catch {
        await this.recordAttemptFailure(event.id, event.attemptCount);
      }
    }
    return { signed, quarantined };
  }

  private async claim(): Promise<AuditOutbox | null> {
    return this.dataSource.transaction(async (manager) => {
      const staleBefore = new Date(Date.now() - AUDIT_OUTBOX_PROCESSING_STALE_MS);
      const query = manager.createQueryBuilder(AuditOutbox, 'outbox')
        .setLock('pessimistic_write')
        .where('(outbox.status = :pending OR (outbox.status = :processing AND outbox.lastAttemptAt < :staleBefore))', { pending: AuditOutboxStatus.PENDING, processing: AuditOutboxStatus.PROCESSING, staleBefore })
        .orderBy('outbox.createdAt', 'ASC').addOrderBy('outbox.id', 'ASC');
      if (!usesEmbeddedDatabase()) query.setOnLocked('skip_locked');
      const event = await query.getOne();
      if (!event) return null;
      event.status = AuditOutboxStatus.PROCESSING;
      event.attemptCount += 1;
      event.lastAttemptAt = new Date();
      event.failureReason = '';
      return manager.save(AuditOutbox, event);
    });
  }

  private input(event: AuditOutbox): AuditAppendInput & { createdAt: Date } {
    return {
      actorId: event.actorId,
      merchantId: event.merchantId,
      action: event.action,
      resourceType: event.resourceType,
      resourceId: event.resourceId,
      before: event.before,
      after: event.after,
      requestId: event.requestId,
      actorRole: event.actorRole,
      ipAddress: event.ipAddress,
      userAgent: event.userAgent,
      createdAt: event.createdAt,
    };
  }

  private async sign(eventId: string, attemptCount: number): Promise<'signed' | 'quarantined' | 'skipped'> {
    return this.dataSource.transaction(async (manager) => {
      const event = await manager.findOne(AuditOutbox, { where: { id: eventId }, lock: { mode: 'pessimistic_write' } });
      if (!event || event.status !== AuditOutboxStatus.PROCESSING || event.attemptCount !== attemptCount) return 'skipped';
      const input = this.input(event);
      if (event.outboxVersion !== 1 || !this.auditChain.outboxPayloadMatches(input, event.payloadHash)) {
        event.status = AuditOutboxStatus.QUARANTINED;
        event.failureReason = '审计 outbox 完整性校验失败';
        await manager.save(AuditOutbox, event);
        return 'quarantined';
      }
      const record = await this.auditChain.append(manager, input);
      event.status = AuditOutboxStatus.SIGNED;
      event.signedAt = new Date();
      event.signedAuditLogId = record.id;
      event.failureReason = '';
      await manager.save(AuditOutbox, event);
      return 'signed';
    });
  }

  private async recordAttemptFailure(eventId: string, attemptCount: number): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const event = await manager.findOne(AuditOutbox, { where: { id: eventId }, lock: { mode: 'pessimistic_write' } });
      if (!event || event.status !== AuditOutboxStatus.PROCESSING || event.attemptCount !== attemptCount) return;
      event.failureReason = '审计签名处理失败，请检查工作器日志';
      await manager.save(AuditOutbox, event);
    });
  }

  async queueStatus(): Promise<AuditOutboxQueueSnapshot> {
    const active = (status: AuditOutboxStatus) => ({ status });
    const [pending, processing, quarantined, oldestPending, oldestProcessing] = await Promise.all([
      this.outbox.count({ where: active(AuditOutboxStatus.PENDING) }),
      this.outbox.count({ where: active(AuditOutboxStatus.PROCESSING) }),
      this.outbox.count({ where: active(AuditOutboxStatus.QUARANTINED) }),
      this.outbox.findOne({ where: active(AuditOutboxStatus.PENDING), select: { id: true, createdAt: true }, order: { createdAt: 'ASC', id: 'ASC' } }),
      this.outbox.findOne({ where: active(AuditOutboxStatus.PROCESSING), select: { id: true, createdAt: true, lastAttemptAt: true }, order: { lastAttemptAt: 'ASC', id: 'ASC' } }),
    ]);
    return {
      pending,
      processing,
      quarantined,
      oldestPendingAt: oldestPending?.createdAt || null,
      oldestProcessingAt: oldestProcessing?.lastAttemptAt || oldestProcessing?.createdAt || null,
    };
  }
}
