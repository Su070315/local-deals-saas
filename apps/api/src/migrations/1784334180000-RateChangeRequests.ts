import { MigrationInterface, QueryRunner } from 'typeorm';

/** Adds durable, reviewer-separated fee-rate change requests. */
export class RateChangeRequests1784334180000 implements MigrationInterface {
  name = 'RateChangeRequests1784334180000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TABLE IF NOT EXISTS "rate_change_requests" (
      "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
      "merchantId" uuid NOT NULL,
      "requestedBy" uuid NOT NULL,
      "rate" numeric(7,4) NOT NULL,
      "effectiveFrom" TIMESTAMP WITH TIME ZONE NOT NULL,
      "note" text NOT NULL,
      "status" character varying NOT NULL,
      "idempotencyKey" character varying NOT NULL,
      "requestHash" character varying NOT NULL,
      "reviewedBy" uuid,
      "reviewNote" text NOT NULL DEFAULT '',
      "reviewedAt" TIMESTAMP WITH TIME ZONE,
      "rateVersionId" uuid,
      "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
      "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
      CONSTRAINT "PK_rate_change_requests" PRIMARY KEY ("id")
    )`);
    await queryRunner.query('CREATE UNIQUE INDEX IF NOT EXISTS "IDX_rate_change_requests_idempotency" ON "rate_change_requests" ("merchantId", "requestedBy", "idempotencyKey")');
    await queryRunner.query('CREATE UNIQUE INDEX IF NOT EXISTS "IDX_rate_change_requests_pending_effective" ON "rate_change_requests" ("merchantId", "effectiveFrom") WHERE "status" = \'PENDING_REVIEW\'');
    await queryRunner.query('CREATE INDEX IF NOT EXISTS "IDX_rate_change_requests_status_created" ON "rate_change_requests" ("status", "createdAt")');
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS "rate_change_requests"');
  }
}
