import { MigrationInterface, QueryRunner } from 'typeorm';

/** Durable notification delivery queue. It is intentionally provider-neutral. */
export class NotificationOutbox1784335560000 implements MigrationInterface {
  name = 'NotificationOutbox1784335560000';
  transaction = false;

  async up(queryRunner: QueryRunner): Promise<void> {
    const inMemory = process.env.TYPEORM_MIGRATION_TEST === 'true';
    if (inMemory && process.env.NODE_ENV !== 'test') throw new Error('TYPEORM_MIGRATION_TEST 仅允许测试环境使用');
    // PostgreSQL production requires non-blocking index creation. pg-mem does
    // not implement CONCURRENTLY, so the explicitly marked test-only branch is
    // used only by the migration test harness and can never run in production.
    const createIndex = inMemory ? 'CREATE INDEX IF NOT EXISTS' : 'CREATE INDEX CONCURRENTLY IF NOT EXISTS';
    const testOnlySuffix = inMemory ? '_pg-mem-test-only' : '';
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "notification_outbox" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "eventType" character varying NOT NULL,
        "templateKey" character varying NOT NULL,
        "channel" character varying NOT NULL,
        "recipientCiphertext" text NOT NULL,
        "merchantId" uuid,
        "resourceType" character varying,
        "resourceId" character varying,
        "payload" text NOT NULL DEFAULT '{}',
        "dedupeKey" character varying NOT NULL,
        "status" character varying NOT NULL DEFAULT 'PENDING',
        "attemptCount" integer NOT NULL DEFAULT 0,
        "nextAttemptAt" TIMESTAMP WITH TIME ZONE NOT NULL,
        "lastAttemptAt" TIMESTAMP WITH TIME ZONE,
        "sentAt" TIMESTAMP WITH TIME ZONE,
        "providerMessageId" character varying,
        "lastError" character varying NOT NULL DEFAULT '',
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_notification_outbox" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_notification_outbox_dedupe" UNIQUE ("dedupeKey")
      )
    `);
    await queryRunner.query(`${createIndex} "IDX_notification_outbox_status_next_attempt${testOnlySuffix}" ON "notification_outbox" ("status", "nextAttemptAt")`);
    await queryRunner.query(`${createIndex} "IDX_notification_outbox_status_created${testOnlySuffix}" ON "notification_outbox" ("status", "createdAt")`);
    await queryRunner.query(`${createIndex} "IDX_notification_outbox_merchant_created${testOnlySuffix}" ON "notification_outbox" ("merchantId", "createdAt")`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS "notification_outbox"');
  }
}
