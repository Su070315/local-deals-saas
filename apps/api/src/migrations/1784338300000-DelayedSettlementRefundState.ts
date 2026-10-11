import { MigrationInterface, QueryRunner } from 'typeorm';

/** Persist stable confirmation-refund request identifiers for crash-safe retries. */
export class DelayedSettlementRefundState1784338300000 implements MigrationInterface {
  name = 'DelayedSettlementRefundState1784338300000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE "refunds" ADD COLUMN IF NOT EXISTS "confirmationRequestSeq" character varying(128)');
    await queryRunner.query('ALTER TABLE "refunds" ADD COLUMN IF NOT EXISTS "confirmationRequestDate" date');
    await queryRunner.query('ALTER TABLE "refunds" ADD COLUMN IF NOT EXISTS "confirmRefundRequestSeq" character varying(128)');
    await queryRunner.query('ALTER TABLE "refunds" ADD COLUMN IF NOT EXISTS "confirmRefundRequestDate" date');
    await queryRunner.query('ALTER TABLE "delayed_settlement_confirmation_outbox" ADD COLUMN IF NOT EXISTS "confirmationRequestSeq" character varying(128)');
    await queryRunner.query('ALTER TABLE "delayed_settlement_confirmation_outbox" ADD COLUMN IF NOT EXISTS "confirmationRequestDate" date');
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE "delayed_settlement_confirmation_outbox" DROP COLUMN IF EXISTS "confirmationRequestDate"');
    await queryRunner.query('ALTER TABLE "delayed_settlement_confirmation_outbox" DROP COLUMN IF EXISTS "confirmationRequestSeq"');
    await queryRunner.query('ALTER TABLE "refunds" DROP COLUMN IF EXISTS "confirmRefundRequestDate"');
    await queryRunner.query('ALTER TABLE "refunds" DROP COLUMN IF EXISTS "confirmRefundRequestSeq"');
    await queryRunner.query('ALTER TABLE "refunds" DROP COLUMN IF EXISTS "confirmationRequestDate"');
    await queryRunner.query('ALTER TABLE "refunds" DROP COLUMN IF EXISTS "confirmationRequestSeq"');
  }
}
