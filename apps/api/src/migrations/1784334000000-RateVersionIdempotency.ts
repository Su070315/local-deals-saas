import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Fee changes affect future customer payments. Persist the command identity
 * separately from the public rate version so retries cannot add a duplicate
 * commercial version or leak replay-control material.
 */
export class RateVersionIdempotency1784334000000 implements MigrationInterface {
  name = 'RateVersionIdempotency1784334000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE "commission_rate_versions" ADD COLUMN IF NOT EXISTS "idempotencyKey" character varying');
    await queryRunner.query('ALTER TABLE "commission_rate_versions" ADD COLUMN IF NOT EXISTS "requestHash" character varying');
    await queryRunner.query('CREATE UNIQUE INDEX IF NOT EXISTS "IDX_rate_versions_operator_idempotency" ON "commission_rate_versions" ("merchantId", "createdBy", "idempotencyKey")');
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX IF EXISTS "IDX_rate_versions_operator_idempotency"');
    await queryRunner.query('ALTER TABLE "commission_rate_versions" DROP COLUMN IF EXISTS "requestHash"');
    await queryRunner.query('ALTER TABLE "commission_rate_versions" DROP COLUMN IF EXISTS "idempotencyKey"');
  }
}
