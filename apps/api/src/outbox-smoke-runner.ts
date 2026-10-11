import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { createHash } from 'node:crypto';
import { unlink, writeFile } from 'node:fs/promises';
import { DataSource, In } from 'typeorm';
import { AppModule } from './app.module';
import { AuditChainService } from './audit-chain.service';
import { AuditOutboxService } from './audit-outbox.service';
import {
  AuditOutbox, AuditOutboxStatus, CommissionRateVersion, DealPackage, Merchant, NotificationChannel, NotificationOutbox, NotificationOutboxStatus, Order, OrderStatus, PackageStatus, PaymentOutbox, PaymentOutboxStatus, Store,
} from './domain/entities';
import { MockNotificationProvider } from './notifications/notification-provider';
import { NotificationOutboxService } from './notifications/notification-outbox.service';
import { MockPaymentProvider } from './payments/payment-provider';
import { PaymentProcessingService } from './payment-processing.service';

function requiredText(value: string | undefined, label: string): string {
  const text = String(value || '').trim();
  if (!/^[A-Za-z0-9_-]{4,64}$/.test(text)) throw new Error(`${label}格式不正确`);
  return text;
}

function requiredCount(value: string | undefined, maximum: number): number {
  const count = Number(value);
  if (!Number.isInteger(count) || count < 1 || count > maximum) throw new Error(`数量必须为 1 至 ${maximum} 的整数`);
  return count;
}

function lockMarkerPath(prefix: string): string {
  return `/tmp/local-deals-outbox-smoke-${prefix}.ready`;
}

function postgresErrorCode(error: unknown): string {
  const value = error as { code?: unknown; driverError?: { code?: unknown } };
  return String(value?.driverError?.code || value?.code || '');
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForStartBarrier(): Promise<void> {
  const startAt = Number(process.env.OUTBOX_SMOKE_START_AT || 0);
  if (!Number.isSafeInteger(startAt) || startAt <= Date.now()) return;
  await new Promise((resolve) => setTimeout(resolve, startAt - Date.now()));
}

async function main(): Promise<void> {
  if (process.env.NODE_ENV !== 'development' || process.env.ALLOW_OUTBOX_SMOKE !== 'true') {
    throw new Error('outbox 烟测运行器仅允许显式授权的 development 容器执行');
  }
  const command = String(process.argv[2] || '');
  const prefix = requiredText(process.argv[3], '烟测前缀');
  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  try {
    const dataSource = app.get(DataSource);
    const notifications = app.get(NotificationOutboxService);
    const auditOutbox = app.get(AuditOutboxService);
    const auditChain = app.get(AuditChainService);
    const payments = app.get(PaymentProcessingService);

    if (command === 'seed-notification') {
      const count = requiredCount(process.argv[4], 200);
      await dataSource.transaction(async (manager) => {
        for (let index = 0; index < count; index += 1) {
          await notifications.enqueue(manager, {
            eventType: 'DOCKER_SMOKE', templateKey: 'docker-smoke', channel: NotificationChannel.EMAIL,
            recipient: `docker-smoke-${prefix}-${index}@example.invalid`, payload: { sequence: index },
            resourceType: 'OutboxSmoke', resourceId: `${prefix}-${index}`, dedupeKey: `docker-smoke:${prefix}:${index}`,
          });
        }
      });
      console.log(JSON.stringify({ command, seeded: count }));
      return;
    }

    if (command === 'seed-audit') {
      const count = requiredCount(process.argv[4], 200);
      await dataSource.transaction(async (manager) => {
        for (let index = 0; index < count; index += 1) {
          const createdAt = new Date(Date.now() + index);
          const input = {
            actorId: 'docker-smoke', merchantId: null, action: 'DOCKER_SMOKE_OUTBOX', resourceType: 'OutboxSmoke',
            resourceId: `${prefix}-${index}`, before: null, after: { sequence: index }, requestId: `docker-smoke-${prefix}`,
            actorRole: 'SYSTEM', ipAddress: '', userAgent: 'docker-smoke', createdAt,
          };
          await manager.save(AuditOutbox, manager.create(AuditOutbox, {
            ...input, outboxVersion: 1, payloadHash: auditChain.outboxPayloadHash(input), status: AuditOutboxStatus.PENDING,
            attemptCount: 0, lastAttemptAt: null, signedAt: null, signedAuditLogId: null, failureReason: '', createdAt,
          }));
        }
      });
      console.log(JSON.stringify({ command, seeded: count }));
      return;
    }

    if (command === 'seed-payment') {
      const count = requiredCount(process.argv[4], 200);
      await dataSource.transaction(async (manager) => {
        const merchant = await manager.findOneByOrFail(Merchant, { brandName: '花时间花艺' });
        const store = await manager.findOneByOrFail(Store, { merchantId: merchant.id });
        const deal = await manager.findOneByOrFail(DealPackage, { merchantId: merchant.id, status: PackageStatus.ON_SALE });
        const rate = await manager.createQueryBuilder(CommissionRateVersion, 'rate')
          .where('rate.merchantId = :merchantId AND rate.effectiveFrom <= :at', { merchantId: merchant.id, at: new Date() })
          .orderBy('rate.effectiveFrom', 'DESC').getOneOrFail();
        const now = new Date();
        const expiresAt = new Date(now.getTime() + 15 * 60_000);
        const orders = Array.from({ length: count }, (_, index) => {
          const digest = createHash('sha256').update(`${prefix}:${index}`).digest('hex').slice(0, 16).toUpperCase();
          return manager.create(Order, {
            orderNo: `DG${now.toISOString().slice(0, 10).replace(/-/g, '')}${digest}`,
            merchantId: merchant.id, packageId: deal.id, storeId: store.id,
            customerId: `docker-payment-${prefix}-${index}`, idempotencyKey: `docker-payment:${prefix}:${index}`,
            quantity: 1, amountFen: deal.priceFen, unitPriceFen: deal.priceFen,
            packageTitleSnapshot: deal.title, packageVersionSnapshot: deal.version,
            validFromSnapshot: new Date(deal.validFrom), validToSnapshot: new Date(deal.validTo),
            commissionRateSnapshot: rate.rate, status: OrderStatus.PENDING_PAYMENT,
            paymentExpiresAt: expiresAt, paymentReference: null,
          });
        });
        const savedOrders = await manager.save(Order, orders);
        await manager.save(PaymentOutbox, savedOrders.map((order, index) => manager.create(PaymentOutbox, {
          orderId: order.id, merchantId: merchant.id, idempotencyKey: `docker-payment:${prefix}:${index}`,
          amountFen: order.amountFen, expiresAt, status: PaymentOutboxStatus.PENDING, attemptCount: 0,
          lastAttemptAt: null, lastReconciledAt: null, nextAttemptAt: now, providerReference: null, lastError: '',
        })));
      });
      console.log(JSON.stringify({ command, seeded: count }));
      return;
    }

    if (command === 'mark-notification-stale') {
      const event = await dataSource.getRepository(NotificationOutbox).createQueryBuilder('event')
        .where('event.dedupeKey LIKE :prefix', { prefix: `docker-smoke:${prefix}:%` })
        .orderBy('event.createdAt', 'ASC').addOrderBy('event.id', 'ASC').getOneOrFail();
      await dataSource.getRepository(NotificationOutbox).update(event.id, {
        status: NotificationOutboxStatus.PROCESSING, attemptCount: 1, lastAttemptAt: new Date(Date.now() - 10 * 60_000),
      });
      console.log(JSON.stringify({ command, marked: 1 }));
      return;
    }

    if (command === 'mark-audit-stale') {
      const event = await dataSource.getRepository(AuditOutbox).createQueryBuilder('event')
        .where('event.requestId = :requestId', { requestId: `docker-smoke-${prefix}` })
        .orderBy('event.createdAt', 'ASC').addOrderBy('event.id', 'ASC').getOneOrFail();
      await dataSource.getRepository(AuditOutbox).update(event.id, {
        status: AuditOutboxStatus.PROCESSING, attemptCount: 1, lastAttemptAt: new Date(Date.now() - 10 * 60_000),
      });
      console.log(JSON.stringify({ command, marked: 1 }));
      return;
    }

    if (command === 'tamper-audit') {
      const event = await dataSource.getRepository(AuditOutbox).createQueryBuilder('event')
        .where('event.requestId = :requestId', { requestId: `docker-smoke-${prefix}` })
        .orderBy('event.createdAt', 'ASC').addOrderBy('event.id', 'ASC').getOneOrFail();
      event.after = { sequence: -1, tampered: true };
      await dataSource.getRepository(AuditOutbox).save(event);
      console.log(JSON.stringify({ command, tampered: 1 }));
      return;
    }

    if (command === 'cleanup-audit') {
      const result = await dataSource.getRepository(AuditOutbox).delete({ requestId: `docker-smoke-${prefix}` });
      console.log(JSON.stringify({ command, deleted: result.affected || 0 }));
      return;
    }

    if (command === 'mark-payment-stale') {
      const event = await dataSource.getRepository(PaymentOutbox).createQueryBuilder('event')
        .where('event.idempotencyKey LIKE :prefix', { prefix: `docker-payment:${prefix}:%` })
        .orderBy('event.createdAt', 'ASC').addOrderBy('event.id', 'ASC').getOneOrFail();
      await dataSource.getRepository(PaymentOutbox).update(event.id, {
        status: PaymentOutboxStatus.PROCESSING, attemptCount: 1, lastAttemptAt: new Date(Date.now() - 10 * 60_000),
      });
      console.log(JSON.stringify({ command, marked: 1 }));
      return;
    }

    if (command === 'hold-payment-transaction') {
      requiredCount(process.argv[4], 1);
      const markerPath = lockMarkerPath(prefix);
      const queryRunner = dataSource.createQueryRunner();
      let interrupted = false;
      await queryRunner.connect();
      await queryRunner.startTransaction();
      try {
        const event = await queryRunner.manager.createQueryBuilder(PaymentOutbox, 'event')
          .setLock('pessimistic_write')
          .where('event.idempotencyKey LIKE :prefix', { prefix: `docker-payment:${prefix}:%` })
          .orderBy('event.createdAt', 'ASC').addOrderBy('event.id', 'ASC').getOneOrFail();
        event.status = PaymentOutboxStatus.PROCESSING;
        event.attemptCount += 1;
        event.lastAttemptAt = new Date();
        await queryRunner.manager.save(PaymentOutbox, event);
        const rows = await queryRunner.query('SELECT pg_backend_pid() AS pid') as Array<{ pid: number }>;
        const backendPid = Number(rows[0]?.pid);
        if (!Number.isSafeInteger(backendPid) || backendPid < 1) throw new Error('无法读取 PostgreSQL 后端进程编号');
        await writeFile(markerPath, `${backendPid}\n`, { encoding: 'utf8', mode: 0o600 });
        const deadline = Date.now() + 60_000;
        while (Date.now() < deadline) {
          await delay(100);
          await queryRunner.query('SELECT 1');
        }
      } catch (error) {
        interrupted = ['57P01', '08003', '08006'].includes(postgresErrorCode(error));
      } finally {
        if (queryRunner.isTransactionActive) {
          try { await queryRunner.rollbackTransaction(); } catch { /* The injected backend termination already rolled it back. */ }
        }
        try { await unlink(markerPath); } catch { /* The parent may already have removed an absent marker. */ }
        try { await queryRunner.release(); } catch { /* A terminated connection cannot return to the pool. */ }
      }
      console.log(JSON.stringify({ command, interrupted }));
      return;
    }

    if (command === 'probe-payment-lock') {
      requiredCount(process.argv[4], 1);
      const startedAt = Date.now();
      try {
        await dataSource.transaction(async (manager) => {
          await manager.createQueryBuilder(PaymentOutbox, 'event')
            .setLock('pessimistic_write')
            .where('event.idempotencyKey LIKE :prefix', { prefix: `docker-payment:${prefix}:%` })
            .orderBy('event.createdAt', 'ASC').addOrderBy('event.id', 'ASC').getOneOrFail();
        });
        console.log(JSON.stringify({ command, timedOut: false, elapsedMs: Date.now() - startedAt, sqlState: '' }));
      } catch (error) {
        const sqlState = postgresErrorCode(error);
        console.log(JSON.stringify({ command, timedOut: sqlState === '55P03', elapsedMs: Date.now() - startedAt, sqlState }));
      }
      return;
    }

    if (command === 'cleanup-payment') {
      requiredCount(process.argv[4], 200);
      const result = await dataSource.transaction(async (manager) => {
        const events = await manager.createQueryBuilder(PaymentOutbox, 'event')
          .where('event.idempotencyKey LIKE :prefix', { prefix: `docker-payment:${prefix}:%` }).getMany();
        if (!events.length) return { deletedOutbox: 0, deletedOrders: 0 };
        const orderIds = [...new Set(events.map((event) => event.orderId))];
        const deletedOutbox = await manager.delete(PaymentOutbox, { id: In(events.map((event) => event.id)) });
        const deletedOrders = await manager.delete(Order, { id: In(orderIds) });
        return { deletedOutbox: deletedOutbox.affected || 0, deletedOrders: deletedOrders.affected || 0 };
      });
      console.log(JSON.stringify({ command, ...result }));
      return;
    }

    if (command === 'process-notification') {
      const count = requiredCount(process.argv[4], 200);
      const delayMs = Math.max(0, Math.min(200, Number(process.env.MOCK_OUTBOX_SEND_DELAY_MS || 0)));
      if (delayMs) {
        const provider = app.get(MockNotificationProvider);
        const send = provider.send.bind(provider);
        provider.send = async (message) => {
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          return send(message);
        };
      }
      await waitForStartBarrier();
      console.log(JSON.stringify({ command, ...(await notifications.process(count)) }));
      return;
    }

    if (command === 'process-audit') {
      const count = requiredCount(process.argv[4], 200);
      const delayMs = Math.max(0, Math.min(200, Number(process.env.MOCK_OUTBOX_SIGN_DELAY_MS || 0)));
      if (delayMs) {
        const append = auditChain.append.bind(auditChain);
        auditChain.append = async (manager, input) => {
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          return append(manager, input);
        };
      }
      await waitForStartBarrier();
      console.log(JSON.stringify({ command, ...(await auditOutbox.process(count)) }));
      return;
    }

    if (command === 'process-payment') {
      const count = requiredCount(process.argv[4], 20);
      const delayMs = Math.max(0, Math.min(200, Number(process.env.MOCK_OUTBOX_SEND_DELAY_MS || 0)));
      if (delayMs) {
        const provider = app.get(MockPaymentProvider);
        const createPayment = provider.createPayment.bind(provider);
        provider.createPayment = async (intent) => {
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          return createPayment(intent);
        };
      }
      await waitForStartBarrier();
      console.log(JSON.stringify({ command, ...(await payments.dispatchPendingIntents(count)) }));
      return;
    }

    if (command === 'notification-stats') {
      const events = await dataSource.getRepository(NotificationOutbox).createQueryBuilder('event')
        .where('event.dedupeKey LIKE :prefix', { prefix: `docker-smoke:${prefix}:%` }).getMany();
      console.log(JSON.stringify({
        command, total: events.length,
        sent: events.filter((event) => event.status === NotificationOutboxStatus.SENT).length,
        pending: events.filter((event) => event.status === NotificationOutboxStatus.PENDING).length,
        processing: events.filter((event) => event.status === NotificationOutboxStatus.PROCESSING).length,
        failed: events.filter((event) => event.status === NotificationOutboxStatus.FAILED).length,
        attemptSum: events.reduce((sum, event) => sum + event.attemptCount, 0),
        recoveredStale: events.filter((event) => event.attemptCount === 2).length,
        maximumAttempts: Math.max(0, ...events.map((event) => event.attemptCount)),
        uniqueProviderMessages: new Set(events.map((event) => event.providerMessageId).filter(Boolean)).size,
      }));
      return;
    }

    if (command === 'audit-stats') {
      const events = await dataSource.getRepository(AuditOutbox).findBy({ requestId: `docker-smoke-${prefix}` });
      console.log(JSON.stringify({
        command, total: events.length,
        signed: events.filter((event) => event.status === AuditOutboxStatus.SIGNED).length,
        pending: events.filter((event) => event.status === AuditOutboxStatus.PENDING).length,
        processing: events.filter((event) => event.status === AuditOutboxStatus.PROCESSING).length,
        quarantined: events.filter((event) => event.status === AuditOutboxStatus.QUARANTINED).length,
        attemptSum: events.reduce((sum, event) => sum + event.attemptCount, 0),
        recoveredStale: events.filter((event) => event.attemptCount === 2).length,
        maximumAttempts: Math.max(0, ...events.map((event) => event.attemptCount)),
        uniqueSignedAuditLogs: new Set(events.map((event) => event.signedAuditLogId).filter(Boolean)).size,
        chain: await auditChain.verify(),
      }));
      return;
    }

    if (command === 'payment-stats') {
      const events = await dataSource.getRepository(PaymentOutbox).createQueryBuilder('event')
        .where('event.idempotencyKey LIKE :prefix', { prefix: `docker-payment:${prefix}:%` }).getMany();
      const orders = await dataSource.getRepository(Order).findBy({ id: In(events.map((event) => event.orderId)) });
      const orderById = new Map(orders.map((order) => [order.id, order]));
      const references = events.map((event) => event.providerReference).filter(Boolean);
      const mismatches = events.filter((event) => orderById.get(event.orderId)?.paymentReference !== event.providerReference).length;
      console.log(JSON.stringify({
        command, total: events.length,
        pending: events.filter((event) => event.status === PaymentOutboxStatus.PENDING).length,
        dispatched: events.filter((event) => event.status === PaymentOutboxStatus.DISPATCHED).length,
        retry: events.filter((event) => event.status === PaymentOutboxStatus.RETRY).length,
        processing: events.filter((event) => event.status === PaymentOutboxStatus.PROCESSING).length,
        cancelled: events.filter((event) => event.status === PaymentOutboxStatus.CANCELLED).length,
        attemptSum: events.reduce((sum, event) => sum + event.attemptCount, 0),
        recoveredStale: events.filter((event) => event.attemptCount === 2).length,
        maximumAttempts: Math.max(0, ...events.map((event) => event.attemptCount)),
        uniqueProviderReferences: new Set(references).size,
        orderReferenceMismatches: mismatches,
      }));
      return;
    }

    throw new Error(`未知 outbox 烟测命令：${command}`);
  } finally {
    await app.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
