import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import {
  NotificationChannel,
  PlatformAccessProfile,
  User,
  UserRole,
} from '../domain/entities';
import {
  NotificationEnqueueInput,
  NotificationOutboxService,
} from './notification-outbox.service';
import { createHash } from 'crypto';

export type AudienceNotificationInput = Omit<NotificationEnqueueInput, 'recipient' | 'channel' | 'dedupeKey'> & {
  dedupeKey: string;
};

/**
 * Keeps audience selection out of business services. Every call still writes
 * through the caller's transaction, so a committed state change cannot lose
 * its notification hand-off.
 */
@Injectable()
export class NotificationAudienceService {
  constructor(private readonly outbox: NotificationOutboxService) {}

  event(eventType: string, templateKey: string, merchantId: string | null, resourceType: string, resourceId: string, payload: Record<string, unknown>, dedupeKey: string): AudienceNotificationInput {
    return { eventType, templateKey, merchantId, resourceType, resourceId, payload, dedupeKey };
  }

  async merchantAdmins(manager: EntityManager, merchantId: string, input: AudienceNotificationInput): Promise<void> {
    const users = await manager.find(User, { where: { merchantId, role: UserRole.MERCHANT_ADMIN, active: true } });
    await this.enqueueEmails(manager, users, input);
  }

  async agencyAdmins(manager: EntityManager, agencyId: string, input: AudienceNotificationInput): Promise<void> {
    const users = await manager.find(User, { where: { agencyId, role: UserRole.AGENCY_ADMIN, active: true } });
    await this.enqueueEmails(manager, users, input);
  }

  async platformAdmins(manager: EntityManager, profiles: PlatformAccessProfile[], input: AudienceNotificationInput): Promise<void> {
    const allowed = new Set(profiles);
    const users = (await manager.find(User, { where: { role: UserRole.PLATFORM_ADMIN, active: true } }))
      .filter((user) => user.platformAccessProfile === null || allowed.has(user.platformAccessProfile as PlatformAccessProfile));
    await this.enqueueEmails(manager, users, input);
  }

  async customerInbox(manager: EntityManager, customerId: string, input: AudienceNotificationInput): Promise<void> {
    const customerKey = createHash('sha256').update(customerId).digest('hex').slice(0, 24);
    await this.outbox.enqueue(manager, {
      ...input,
      channel: NotificationChannel.CUSTOMER_INBOX,
      recipient: customerId,
      dedupeKey: `${input.dedupeKey}:customer:${customerKey}`,
    });
  }

  private async enqueueEmails(manager: EntityManager, users: User[], input: AudienceNotificationInput): Promise<void> {
    const uniqueUsers = [...new Map(users.map((user) => [user.id, user])).values()];
    for (const user of uniqueUsers) {
      await this.outbox.enqueue(manager, {
        ...input,
        channel: NotificationChannel.EMAIL,
        recipient: user.email,
        dedupeKey: `${input.dedupeKey}:user:${user.id}`,
      });
    }
  }
}
