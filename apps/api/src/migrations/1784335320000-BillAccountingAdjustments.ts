import { MigrationInterface, QueryRunner } from 'typeorm';

/** Adds immutable, four-eyes accounting adjustments and explicit bill locks. */
export class BillAccountingAdjustments1784335320000 implements MigrationInterface {
  name = 'BillAccountingAdjustments1784335320000';
  transaction = false;

  async up(queryRunner: QueryRunner): Promise<void> {
    const inMemory = process.env.TYPEORM_MIGRATION_TEST === 'true';
    if (inMemory && process.env.NODE_ENV !== 'test') throw new Error('TYPEORM_MIGRATION_TEST 仅允许测试环境使用');
    await queryRunner.query('ALTER TABLE "monthly_bills" ADD COLUMN IF NOT EXISTS "accountingLockedAt" TIMESTAMP WITH TIME ZONE');
    await queryRunner.query('ALTER TABLE "monthly_bills" ADD COLUMN IF NOT EXISTS "accountingLockedBy" uuid');
    await queryRunner.query('ALTER TABLE "monthly_bills" ADD COLUMN IF NOT EXISTS "adjustmentVersion" integer NOT NULL DEFAULT 0');
    if (!inMemory) await queryRunner.query('CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "UQ_monthly_bills_id_merchant" ON "monthly_bills" ("id", "merchantId")');
    const foreignKeys = inMemory
      ? 'CONSTRAINT "FK_bill_adjustments_bill" FOREIGN KEY ("billId") REFERENCES "monthly_bills" ("id") ON DELETE CASCADE, CONSTRAINT "FK_bill_adjustments_merchant" FOREIGN KEY ("merchantId") REFERENCES "merchants" ("id") ON DELETE CASCADE'
      : 'CONSTRAINT "FK_bill_adjustments_bill_merchant" FOREIGN KEY ("billId", "merchantId") REFERENCES "monthly_bills" ("id", "merchantId") ON DELETE CASCADE, CONSTRAINT "FK_bill_adjustments_merchant" FOREIGN KEY ("merchantId") REFERENCES "merchants" ("id") ON DELETE CASCADE';
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "bill_adjustments" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "billId" uuid NOT NULL,
        "merchantId" uuid NOT NULL,
        "period" character varying NOT NULL,
        "verifiedAmountDeltaFen" bigint NOT NULL,
        "serviceFeeDeltaFen" bigint NOT NULL,
        "reasonCode" character varying(60) NOT NULL,
        "note" text NOT NULL,
        "status" character varying NOT NULL DEFAULT 'PENDING_REVIEW',
        "requestedBy" uuid NOT NULL,
        "reviewedBy" uuid,
        "reviewNote" text NOT NULL DEFAULT '',
        "reviewedAt" TIMESTAMP WITH TIME ZONE,
        "reversalOfId" uuid,
        "postedAt" TIMESTAMP WITH TIME ZONE,
        "idempotencyKey" character varying NOT NULL,
        "requestHash" character varying NOT NULL,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_bill_adjustments" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_bill_adjustments_idempotency" UNIQUE ("billId", "requestedBy", "idempotencyKey"),
        CONSTRAINT "CHK_bill_adjustments_delta" CHECK ("verifiedAmountDeltaFen" <> 0 OR "serviceFeeDeltaFen" <> 0),
        ${foreignKeys},
        CONSTRAINT "FK_bill_adjustments_reversal" FOREIGN KEY ("reversalOfId") REFERENCES "bill_adjustments" ("id")
      )
    `);
    if (!inMemory) {
      await queryRunner.query('CREATE INDEX CONCURRENTLY IF NOT EXISTS "IDX_bill_adjustments_bill_status" ON "bill_adjustments" ("billId", "status")');
      await queryRunner.query('CREATE INDEX CONCURRENTLY IF NOT EXISTS "IDX_bill_adjustments_merchant_period_created" ON "bill_adjustments" ("merchantId", "period", "createdAt")');
      await queryRunner.query('CREATE INDEX CONCURRENTLY IF NOT EXISTS "IDX_bill_adjustments_merchant" ON "bill_adjustments" ("merchantId")');
    }
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    const inMemory = process.env.TYPEORM_MIGRATION_TEST === 'true';
    const dropIndex = inMemory ? 'DROP INDEX IF EXISTS' : 'DROP INDEX CONCURRENTLY IF EXISTS';
    await queryRunner.query('DROP TABLE IF EXISTS "bill_adjustments"');
    await queryRunner.query('ALTER TABLE "monthly_bills" DROP COLUMN IF EXISTS "adjustmentVersion"');
    await queryRunner.query('ALTER TABLE "monthly_bills" DROP COLUMN IF EXISTS "accountingLockedBy"');
    await queryRunner.query('ALTER TABLE "monthly_bills" DROP COLUMN IF EXISTS "accountingLockedAt"');
    await queryRunner.query(`${dropIndex} "UQ_monthly_bills_id_merchant"`);
  }
}
