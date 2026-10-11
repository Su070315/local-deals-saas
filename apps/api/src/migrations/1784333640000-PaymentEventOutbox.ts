import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Payment intent dispatch and verified payment results are independent durable
 * records. This migration is additive so an existing pilot database keeps all
 * orders and can be upgraded before a contracted provider is enabled.
 */
export class PaymentEventOutbox1784333640000 implements MigrationInterface {
  name = 'PaymentEventOutbox1784333640000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('CREATE TABLE IF NOT EXISTS "payment_outbox" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "orderId" uuid NOT NULL, "merchantId" uuid NOT NULL, "idempotencyKey" character varying NOT NULL, "amountFen" integer NOT NULL, "expiresAt" TIMESTAMP WITH TIME ZONE NOT NULL, "status" character varying NOT NULL DEFAULT \'PENDING\', "attemptCount" integer NOT NULL DEFAULT 0, "lastAttemptAt" TIMESTAMP WITH TIME ZONE, "lastReconciledAt" TIMESTAMP WITH TIME ZONE, "nextAttemptAt" TIMESTAMP WITH TIME ZONE NOT NULL, "providerReference" character varying, "lastError" character varying NOT NULL DEFAULT \'\', "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_payment_outbox" PRIMARY KEY ("id"))');
    await queryRunner.query('CREATE UNIQUE INDEX IF NOT EXISTS "IDX_payment_outbox_order" ON "payment_outbox" ("orderId")');
    await queryRunner.query('CREATE UNIQUE INDEX IF NOT EXISTS "IDX_payment_outbox_idempotency" ON "payment_outbox" ("idempotencyKey")');
    await queryRunner.query('CREATE INDEX IF NOT EXISTS "IDX_payment_outbox_status_next_attempt" ON "payment_outbox" ("status", "nextAttemptAt")');
    await queryRunner.query('CREATE INDEX IF NOT EXISTS "IDX_payment_outbox_merchant" ON "payment_outbox" ("merchantId")');

    await queryRunner.query('CREATE TABLE IF NOT EXISTS "payment_events" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "orderId" uuid NOT NULL, "merchantId" uuid NOT NULL, "provider" character varying NOT NULL, "providerEventId" character varying NOT NULL, "eventType" character varying NOT NULL, "providerPaymentReference" character varying NOT NULL, "amountFen" integer NOT NULL, "occurredAt" TIMESTAMP WITH TIME ZONE NOT NULL, "receivedAt" TIMESTAMP NOT NULL DEFAULT now(), "rawPayloadHash" character varying(64) NOT NULL, "normalizedHash" character varying(64) NOT NULL, "status" character varying NOT NULL DEFAULT \'RECEIVED\', "processingNote" character varying NOT NULL DEFAULT \'\', "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_payment_events" PRIMARY KEY ("id"))');
    await queryRunner.query('CREATE UNIQUE INDEX IF NOT EXISTS "IDX_payment_events_provider_event" ON "payment_events" ("provider", "providerEventId")');
    await queryRunner.query('CREATE INDEX IF NOT EXISTS "IDX_payment_events_provider_reference" ON "payment_events" ("provider", "providerPaymentReference")');
    await queryRunner.query('CREATE INDEX IF NOT EXISTS "IDX_payment_events_status_received" ON "payment_events" ("status", "receivedAt")');
    await queryRunner.query('CREATE INDEX IF NOT EXISTS "IDX_payment_events_order" ON "payment_events" ("orderId")');
    await queryRunner.query('CREATE INDEX IF NOT EXISTS "IDX_payment_events_merchant" ON "payment_events" ("merchantId")');
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS "payment_events"');
    await queryRunner.query('DROP TABLE IF EXISTS "payment_outbox"');
  }
}
