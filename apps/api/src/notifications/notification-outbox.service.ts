import { BadRequestException, ConflictException, Inject, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import { DataSource, EntityManager, LessThanOrEqual, Repository } from 'typeorm';
import { NotificationChannel, NotificationOutbox, NotificationOutboxStatus } from '../domain/entities';
import { SensitiveDataService } from '../sensitive-data.service';
import { usesEmbeddedDatabase } from '../runtime-config';
import { claimWithTransientEmptyRetry } from '../outbox-claim-retry';
import { NOTIFICATION_PROVIDER, NotificationProvider } from './notification-provider';

const PROCESSING_STALE_MS = 5 * 60_000;
const MAX_ATTEMPTS = 8;

export type NotificationEnqueueInput = {
  eventType: string;
  templateKey: string;
  channel: NotificationChannel;
  recipient: string;
  merchantId?: string | null;
  resourceType?: string | null;
  resourceId?: string | null;
  payload?: Record<string, unknown>;
  dedupeKey: string;
};

export type NotificationOutboxQueueSnapshot = {
  pending: number;
  processing: number;
  failed: number;
  newestFailedAt: Date | null;
  oldestPendingAt: Date | null;
  oldestProcessingAt: Date | null;
};

export type NotificationProcessResult = { sent: number; failed: number };

@Injectable()
export class NotificationOutboxService {
  private processor: Promise<NotificationProcessResult> | null = null;

  constructor(
    @InjectRepository(NotificationOutbox) private readonly outbox: Repository<NotificationOutbox>,
    private readonly dataSource: DataSource,
    private readonly sensitiveData: SensitiveDataService,
    @Inject(NOTIFICATION_PROVIDER) private readonly provider: NotificationProvider,
  ) {}

  /** Enqueue inside the caller's transaction. The duplicate key is deliberate and idempotent. */
  async enqueue(manager: EntityManager, input: NotificationEnqueueInput): Promise<NotificationOutbox> {
    const eventType = this.requiredKey(input.eventType, '通知事件类型', 80);
    const templateKey = this.requiredKey(input.templateKey, '通知模板', 120);
    const dedupeKey = this.requiredKey(input.dedupeKey, '通知幂等标识', 240);
    const recipient = this.requiredText(input.recipient, '通知收件人', 320);
    const payload = input.payload || {};
    const serializedPayload = JSON.stringify(payload);
    if (serializedPayload.length > 10_000) throw new BadRequestException('通知模板参数过大');
    const existing = await manager.findOneBy(NotificationOutbox, { dedupeKey });
    if (existing) {
      this.assertSameEvent(existing, { eventType, templateKey, channel: input.channel, merchantId: input.merchantId || null, resourceType: input.resourceType || null, resourceId: input.resourceId || null, payload });
      return existing;
    }
    const id = randomUUID();
    await manager.createQueryBuilder().insert().into(NotificationOutbox).values({
      id, eventType, templateKey, channel: input.channel,
      recipientCiphertext: this.sensitiveData.encrypt(recipient), merchantId: input.merchantId || null,
      resourceType: input.resourceType || null, resourceId: input.resourceId || null,
      payload: payload as never, dedupeKey, status: NotificationOutboxStatus.PENDING, attemptCount: 0,
      nextAttemptAt: new Date(), lastAttemptAt: null, sentAt: null, providerMessageId: null, lastError: '',
    }).orIgnore().execute();
    const created = await manager.findOneBy(NotificationOutbox, { dedupeKey });
    if (!created) throw new Error('通知 outbox 写入后无法读取');
    this.assertSameEvent(created, { eventType, templateKey, channel: input.channel, merchantId: input.merchantId || null, resourceType: input.resourceType || null, resourceId: input.resourceId || null, payload });
    return created;
  }

  async process(limit = 50): Promise<NotificationProcessResult> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error('通知 outbox 批量大小必须是 1 至 200 的整数');
    if (this.processor) return this.processor;
    const task = this.processInternal(limit);
    this.processor = task;
    try { return await task; } finally { if (this.processor === task) this.processor = null; }
  }

  private async processInternal(limit: number): Promise<NotificationProcessResult> {
    let sent = 0;
    let failed = 0;
    for (let index = 0; index < limit; index += 1) {
      const event = await claimWithTransientEmptyRetry(() => this.claim());
      if (!event) break;
      try {
        const recipient = this.sensitiveData.decrypt(event.recipientCiphertext);
        const result = await this.provider.send({
          id: event.id, eventType: event.eventType, templateKey: event.templateKey, channel: event.channel,
          recipient, payload: event.payload, idempotencyKey: event.dedupeKey,
        });
        await this.markSent(event.id, event.attemptCount, result.providerMessageId);
        sent += 1;
      } catch (error) {
        const terminal = await this.recordFailure(event.id, event.attemptCount, error);
        if (terminal) failed += 1;
      }
    }
    return { sent, failed };
  }

  private async claim(): Promise<NotificationOutbox | null> {
    return this.dataSource.transaction(async (manager) => {
      const staleBefore = new Date(Date.now() - PROCESSING_STALE_MS);
      const query = manager.createQueryBuilder(NotificationOutbox, 'outbox')
        .setLock('pessimistic_write')
        .where('(outbox.status = :pending AND outbox.nextAttemptAt <= :now OR outbox.status = :processing AND outbox.lastAttemptAt < :staleBefore)', {
          pending: NotificationOutboxStatus.PENDING, processing: NotificationOutboxStatus.PROCESSING, now: new Date(), staleBefore,
        })
        .orderBy('outbox.nextAttemptAt', 'ASC').addOrderBy('outbox.id', 'ASC');
      // A slow provider call must not make another Worker wait on the same
      // oldest row. Embedded pg-mem does not implement this PostgreSQL lock
      // option, so the pilot keeps the query portable there.
      if (!usesEmbeddedDatabase()) query.setOnLocked('skip_locked');
      const event = await query.getOne();
      if (!event) return null;
      event.status = NotificationOutboxStatus.PROCESSING;
      event.attemptCount += 1;
      event.lastAttemptAt = new Date();
      event.lastError = '';
      return manager.save(NotificationOutbox, event);
    });
  }

  private async markSent(eventId: string, attemptCount: number, providerMessageId: string): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const event = await manager.findOne(NotificationOutbox, { where: { id: eventId }, lock: { mode: 'pessimistic_write' } });
      if (!event || event.status !== NotificationOutboxStatus.PROCESSING || event.attemptCount !== attemptCount) return;
      event.status = NotificationOutboxStatus.SENT;
      event.sentAt = new Date();
      event.providerMessageId = this.requiredText(providerMessageId, '通知供应商消息标识', 200);
      event.lastError = '';
      await manager.save(NotificationOutbox, event);
    });
  }

  private async recordFailure(eventId: string, attemptCount: number, error: unknown): Promise<boolean> {
    return this.dataSource.transaction(async (manager) => {
      const event = await manager.findOne(NotificationOutbox, { where: { id: eventId }, lock: { mode: 'pessimistic_write' } });
      if (!event || event.status !== NotificationOutboxStatus.PROCESSING || event.attemptCount !== attemptCount) return false;
      const message = error instanceof Error ? error.message : String(error);
      event.lastError = message.slice(0, 500);
      if (event.attemptCount >= MAX_ATTEMPTS) {
        event.status = NotificationOutboxStatus.FAILED;
        await manager.save(NotificationOutbox, event);
        return true;
      }
      event.status = NotificationOutboxStatus.PENDING;
      event.nextAttemptAt = new Date(Date.now() + this.backoffMs(event.attemptCount));
      await manager.save(NotificationOutbox, event);
      return false;
    });
  }

  async retryFailed(id: string, transactionManager?: EntityManager): Promise<NotificationOutbox> {
    const retry = async (manager: EntityManager): Promise<NotificationOutbox> => {
      const event = await manager.findOne(NotificationOutbox, { where: { id }, lock: { mode: 'pessimistic_write' } });
      if (!event) throw new ConflictException('通知任务不存在');
      if (event.status !== NotificationOutboxStatus.FAILED) throw new BadRequestException('只有失败通知可以重试');
      event.status = NotificationOutboxStatus.PENDING;
      event.nextAttemptAt = new Date();
      event.lastError = '';
      await manager.save(NotificationOutbox, event);
      return event;
    };
    return transactionManager ? retry(transactionManager) : this.dataSource.transaction(retry);
  }

  async queueStatus(): Promise<NotificationOutboxQueueSnapshot> {
    const [pending, processing, failed, oldestPending, oldestProcessing, newestFailed] = await Promise.all([
      this.outbox.count({ where: { status: NotificationOutboxStatus.PENDING } }),
      this.outbox.count({ where: { status: NotificationOutboxStatus.PROCESSING } }),
      this.outbox.count({ where: { status: NotificationOutboxStatus.FAILED } }),
      this.outbox.findOne({ where: { status: NotificationOutboxStatus.PENDING, nextAttemptAt: LessThanOrEqual(new Date()) }, select: { id: true, createdAt: true }, order: { createdAt: 'ASC', id: 'ASC' } }),
      this.outbox.findOne({ where: { status: NotificationOutboxStatus.PROCESSING }, select: { id: true, createdAt: true, lastAttemptAt: true }, order: { lastAttemptAt: 'ASC', id: 'ASC' } }),
      this.outbox.findOne({ where: { status: NotificationOutboxStatus.FAILED }, select: { id: true, updatedAt: true }, order: { updatedAt: 'DESC', id: 'DESC' } }),
    ]);
    return { pending, processing, failed, newestFailedAt: newestFailed?.updatedAt || null, oldestPendingAt: oldestPending?.createdAt || null, oldestProcessingAt: oldestProcessing?.lastAttemptAt || oldestProcessing?.createdAt || null };
  }

  private backoffMs(attemptCount: number): number { return Math.min(60 * 60_000, 5_000 * (2 ** Math.max(0, attemptCount - 1))); }

  private assertSameEvent(event: NotificationOutbox, input: Pick<NotificationEnqueueInput, 'eventType' | 'templateKey' | 'channel' | 'merchantId' | 'resourceType' | 'resourceId' | 'payload'>): void {
    const same = event.eventType === input.eventType && event.templateKey === input.templateKey && event.channel === input.channel && event.merchantId === (input.merchantId || null) && event.resourceType === (input.resourceType || null) && event.resourceId === (input.resourceId || null) && JSON.stringify(event.payload || {}) === JSON.stringify(input.payload || {});
    if (!same) throw new ConflictException('通知幂等标识已用于其他消息');
  }

  private requiredKey(value: unknown, label: string, maxLength: number): string {
    const text = this.requiredText(value, label, maxLength);
    if (!/^[A-Za-z0-9_.:-]+$/.test(text)) throw new BadRequestException(`${label}格式不正确`);
    return text;
  }

  private requiredText(value: unknown, label: string, maxLength: number): string {
    if (typeof value !== 'string') throw new BadRequestException(`${label}格式不正确`);
    const text = value.trim();
    if (!text || text.length > maxLength) throw new BadRequestException(`${label}不能为空且不能超过 ${maxLength} 个字符`);
    return text;
  }
}
