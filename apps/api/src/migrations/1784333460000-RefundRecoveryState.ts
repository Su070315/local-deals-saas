import { MigrationInterface, QueryRunner } from 'typeorm';

export class RefundRecoveryState1784333460000 implements MigrationInterface {
  name = 'RefundRecoveryState1784333460000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE "refunds" ADD COLUMN IF NOT EXISTS "lastAttemptAt" TIMESTAMP');
    await queryRunner.query('ALTER TABLE "refunds" ADD COLUMN IF NOT EXISTS "attemptCount" integer NOT NULL DEFAULT 0');
    await queryRunner.query('CREATE INDEX IF NOT EXISTS "IDX_refunds_status_last_attempt" ON "refunds" ("status", "lastAttemptAt")');
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX IF EXISTS "IDX_refunds_status_last_attempt"');
    await queryRunner.query('ALTER TABLE "refunds" DROP COLUMN IF EXISTS "attemptCount"');
    await queryRunner.query('ALTER TABLE "refunds" DROP COLUMN IF EXISTS "lastAttemptAt"');
  }
}
