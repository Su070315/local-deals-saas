import { MigrationInterface, QueryRunner } from 'typeorm';

/** Makes commercial wind-down an auditable case rather than a single status. */
export class MerchantExitCases1784334120000 implements MigrationInterface {
  name = 'MerchantExitCases1784334120000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TABLE IF NOT EXISTS "merchant_exit_cases" (
      "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
      "merchantId" uuid NOT NULL,
      "status" character varying NOT NULL,
      "requestedBy" uuid NOT NULL,
      "requestReason" text NOT NULL,
      "salesPausedAt" TIMESTAMP WITH TIME ZONE,
      "fulfillmentStartedAt" TIMESTAMP WITH TIME ZONE,
      "fulfillmentStartedBy" uuid,
      "exportReadyAt" TIMESTAMP WITH TIME ZONE,
      "dataExportConfirmedAt" TIMESTAMP WITH TIME ZONE,
      "dataExportConfirmedBy" uuid,
      "dataExportConfirmationNote" text NOT NULL DEFAULT '',
      "authorizationRevocationAcknowledgedAt" TIMESTAMP WITH TIME ZONE,
      "authorizationRevocationAcknowledgedBy" uuid,
      "authorizationRevocationNote" text NOT NULL DEFAULT '',
      "closedAt" TIMESTAMP WITH TIME ZONE,
      "closedBy" uuid,
      "retentionPolicyReference" character varying NOT NULL DEFAULT '',
      "retentionUntil" date,
      "retentionReviewNote" text NOT NULL DEFAULT '',
      "retentionReviewedBy" uuid,
      "purgeEligibleAt" TIMESTAMP WITH TIME ZONE,
      "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
      "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
      CONSTRAINT "PK_merchant_exit_cases" PRIMARY KEY ("id")
    )`);
    await queryRunner.query('CREATE UNIQUE INDEX IF NOT EXISTS "IDX_merchant_exit_cases_merchant" ON "merchant_exit_cases" ("merchantId")');
    await queryRunner.query('CREATE INDEX IF NOT EXISTS "IDX_merchant_exit_cases_status" ON "merchant_exit_cases" ("status")');
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS "merchant_exit_cases"');
  }
}
