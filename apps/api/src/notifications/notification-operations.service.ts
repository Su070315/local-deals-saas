import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import {
  NotificationOutbox,
  NotificationOutboxStatus,
  PlatformAccessProfile,
  User,
  UserRole,
} from '../domain/entities';
import { AuditWriterService } from '../audit-writer.service';
import { NotificationOutboxService } from './notification-outbox.service';

export type NotificationOperationsQuery = {
  status?: NotificationOutboxStatus;
  merchantId?: string;
  limit?: number;
};

export type NotificationOperationsItem = {
  id: string;
  eventType: string;
  templateKey: string;
  channel: string;
  merchantId: string | null;
  resourceType: string | null;
  resourceId: string | null;
  payloadKeys: string[];
  status: NotificationOutboxStatus;
  attemptCount: number;
  nextAttemptAt: Date;
  lastAttemptAt: Date | null;
  sentAt: Date | null;
  providerMessageId: string | null;
  lastError: string;
  createdAt: Date;
  updatedAt: Date;
};

const NOTIFICATION_OPERATIONS_PROFILES = new Set([
  PlatformAccessProfile.SYSTEM_ADMIN,
  PlatformAccessProfile.OPERATIONS,
  PlatformAccessProfile.FINANCE,
  PlatformAccessProfile.COMPLIANCE,
  PlatformAccessProfile.SECURITY,
]);

@Injectable()
export class NotificationOperationsService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly auditWriter: AuditWriterService,
    private readonly notificationOutbox: NotificationOutboxService,
    @InjectRepository(NotificationOutbox) private readonly outbox: Repository<NotificationOutbox>,
  ) {}

  async list(user: User, query: NotificationOperationsQuery = {}): Promise<NotificationOperationsItem[]> {
    this.assertAccess(user);
    const limit = this.integer(query.limit ?? 50, 1, 100, '通知列表条数');
    if (query.status !== undefined && !Object.values(NotificationOutboxStatus).includes(query.status)) throw new BadRequestException('通知状态不正确');
    const records = await this.outbox.find({
      where: {
        ...(query.status ? { status: query.status } : {}),
        ...(query.merchantId ? { merchantId: query.merchantId } : {}),
      },
      order: { createdAt: 'DESC', id: 'DESC' },
      take: limit,
    });
    return records.map((record) => this.safe(record));
  }

  async retryFailed(user: User, id: string): Promise<NotificationOperationsItem> {
    this.assertAccess(user);
    return this.dataSource.transaction(async (manager) => {
      const event = await this.notificationOutbox.retryFailed(id, manager);
      await this.auditWriter.write(user.id, event.merchantId, 'NOTIFICATION_RETRY_REQUESTED', 'NotificationOutbox', event.id, {
        status: NotificationOutboxStatus.FAILED,
        attemptCount: event.attemptCount,
      }, {
        status: event.status,
        nextAttemptAt: event.nextAttemptAt,
      }, manager);
      return this.safe(event);
    });
  }

  private assertAccess(user: User): void {
    if (user.role !== UserRole.PLATFORM_ADMIN) throw new ForbiddenException('只有平台账号可以管理通知队列');
    if (user.platformAccessProfile && !NOTIFICATION_OPERATIONS_PROFILES.has(user.platformAccessProfile)) throw new ForbiddenException('当前平台职责无权管理通知队列');
  }

  private safe(record: NotificationOutbox): NotificationOperationsItem {
    return {
      id: record.id,
      eventType: record.eventType,
      templateKey: record.templateKey,
      channel: record.channel,
      merchantId: record.merchantId,
      resourceType: record.resourceType,
      resourceId: record.resourceId,
      payloadKeys: Object.keys(record.payload || {}).sort(),
      status: record.status,
      attemptCount: record.attemptCount,
      nextAttemptAt: record.nextAttemptAt,
      lastAttemptAt: record.lastAttemptAt,
      sentAt: record.sentAt,
      providerMessageId: record.providerMessageId,
      lastError: record.lastError,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  }

  private integer(value: unknown, min: number, max: number, label: string): number {
    const number = Number(value);
    if (!Number.isInteger(number) || number < min || number > max) throw new BadRequestException(`${label}必须为 ${min} 至 ${max} 的整数`);
    return number;
  }
}
