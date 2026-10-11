import { MigrationInterface, QueryRunner } from 'typeorm';

/** 汇付延迟交易快照与确认 outbox；仅扩展 schema，普通支付链路不依赖这些表。 */
export class HuifuDelayedSettlement1784338000000 implements MigrationInterface {
  name = 'HuifuDelayedSettlement1784338000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TABLE IF NOT EXISTS "delayed_settlement_transactions" (
      "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
      "orderId" uuid NOT NULL,
      "merchantId" uuid NOT NULL,
      "provider" character varying(32) NOT NULL,
      "providerPaymentReference" character varying(128) NOT NULL,
      "amountFen" bigint NOT NULL,
      "snapshotJson" text NOT NULL,
      "status" character varying NOT NULL DEFAULT 'PENDING_CONFIRMATION',
      "confirmedAt" TIMESTAMP WITH TIME ZONE,
      "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
      "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
      CONSTRAINT "PK_delayed_settlement_transactions" PRIMARY KEY ("id")
    )`);
    await queryRunner.query('CREATE UNIQUE INDEX IF NOT EXISTS "IDX_delayed_settlement_transactions_order" ON "delayed_settlement_transactions" ("orderId")');
    await queryRunner.query('CREATE INDEX IF NOT EXISTS "IDX_delayed_settlement_transactions_status_created" ON "delayed_settlement_transactions" ("status", "createdAt")');
    await queryRunner.query(`CREATE TABLE IF NOT EXISTS "delayed_settlement_confirmation_outbox" (
      "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
      "transactionId" uuid NOT NULL,
      "verificationId" uuid NOT NULL,
      "orderId" uuid NOT NULL,
      "merchantId" uuid NOT NULL,
      "voucherId" uuid NOT NULL,
      "amountFen" bigint NOT NULL,
      "acctSplitBunch" json NOT NULL,
      "idempotencyKey" character varying(128) NOT NULL,
      "status" character varying NOT NULL DEFAULT 'PENDING',
      "attemptCount" integer NOT NULL DEFAULT 0,
      "lastAttemptAt" TIMESTAMP WITH TIME ZONE,
      "nextAttemptAt" TIMESTAMP WITH TIME ZONE NOT NULL,
      "providerReference" character varying(128),
      "lastError" character varying NOT NULL DEFAULT '',
      "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
      "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
      CONSTRAINT "PK_delayed_settlement_confirmation_outbox" PRIMARY KEY ("id")
    )`);
    await queryRunner.query('CREATE UNIQUE INDEX IF NOT EXISTS "IDX_delayed_confirmation_verification" ON "delayed_settlement_confirmation_outbox" ("verificationId")');
    await queryRunner.query('CREATE UNIQUE INDEX IF NOT EXISTS "IDX_delayed_confirmation_idempotency" ON "delayed_settlement_confirmation_outbox" ("idempotencyKey")');
    await queryRunner.query('CREATE INDEX IF NOT EXISTS "IDX_delayed_confirmation_status_next_attempt" ON "delayed_settlement_confirmation_outbox" ("status", "nextAttemptAt")');
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS "delayed_settlement_confirmation_outbox"');
    await queryRunner.query('DROP TABLE IF EXISTS "delayed_settlement_transactions"');
  }
}
