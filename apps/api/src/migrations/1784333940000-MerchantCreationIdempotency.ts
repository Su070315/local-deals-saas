import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * A declared legal name is not proof of a legal subject. Replace the historical
 * draft-name constraint with idempotent creation scoped to the operator.
 */
export class MerchantCreationIdempotency1784333940000 implements MigrationInterface {
  name = 'MerchantCreationIdempotency1784333940000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX IF EXISTS "IDX_merchants_legal_name_unique"');
    await queryRunner.query('ALTER TABLE "merchants" ADD COLUMN IF NOT EXISTS "createdBy" uuid');
    await queryRunner.query('ALTER TABLE "merchants" ADD COLUMN IF NOT EXISTS "creationIdempotencyKey" character varying');
    await queryRunner.query('ALTER TABLE "merchants" ADD COLUMN IF NOT EXISTS "creationRequestHash" character varying');
    await queryRunner.query('CREATE UNIQUE INDEX IF NOT EXISTS "IDX_merchants_creation_idempotency" ON "merchants" ("createdBy", "creationIdempotencyKey")');
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX IF EXISTS "IDX_merchants_creation_idempotency"');
    await queryRunner.query('ALTER TABLE "merchants" DROP COLUMN IF EXISTS "creationRequestHash"');
    await queryRunner.query('ALTER TABLE "merchants" DROP COLUMN IF EXISTS "creationIdempotencyKey"');
    await queryRunner.query('ALTER TABLE "merchants" DROP COLUMN IF EXISTS "createdBy"');
    // A downgrade intentionally fails if newer same-name draft workspaces were
    // created; operators must reconcile them rather than silently discard data.
    await queryRunner.query('CREATE UNIQUE INDEX IF NOT EXISTS "IDX_merchants_legal_name_unique" ON "merchants" ("legalName")');
  }
}
