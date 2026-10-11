import { Injectable } from '@nestjs/common';
import { NotificationChannel } from '../domain/entities';

export type NotificationMessage = {
  id: string;
  eventType: string;
  templateKey: string;
  channel: NotificationChannel;
  recipient: string;
  payload: Record<string, unknown>;
  idempotencyKey: string;
};

export interface NotificationProvider {
  readonly providerName: string;
  readonly enabled: boolean;
  send(message: NotificationMessage): Promise<{ providerMessageId: string }>;
}

/** The local provider records delivery without contacting an external service. */
@Injectable()
export class MockNotificationProvider implements NotificationProvider {
  readonly providerName = 'mock';
  readonly enabled = true;
  readonly deliveries: NotificationMessage[] = [];
  private failure: Error | null = null;

  failNextDelivery(message = '模拟通知通道暂不可用'): void {
    this.failure = new Error(message);
  }

  async send(message: NotificationMessage): Promise<{ providerMessageId: string }> {
    const failure = this.failure;
    this.failure = null;
    if (failure) throw failure;
    this.deliveries.push(message);
    return { providerMessageId: `mock_notification_${message.id.slice(0, 12)}` };
  }
}

/** Production stays fail-closed until a contracted email/WeChat adapter is configured. */
@Injectable()
export class UnavailableNotificationProvider implements NotificationProvider {
  readonly providerName = 'unconfigured';
  readonly enabled = false;

  async send(_message: NotificationMessage): Promise<{ providerMessageId: string }> {
    throw new Error('通知通道尚未签约并启用');
  }
}

export const NOTIFICATION_PROVIDER = Symbol('NOTIFICATION_PROVIDER');
