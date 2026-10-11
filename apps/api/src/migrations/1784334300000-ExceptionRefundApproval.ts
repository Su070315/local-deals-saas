import { MigrationInterface, QueryRunner } from 'typeorm';

/** Separates manual exception-refund approval from payment execution. */
export class ExceptionRefundApproval1784334300000 implements MigrationInterface {
  name = 'ExceptionRefundApproval1784334300000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE "support_tickets" ADD COLUMN IF NOT EXISTS "exceptionRefundApprovalStatus" character varying');
    await queryRunner.query('ALTER TABLE "support_tickets" ADD COLUMN IF NOT EXISTS "exceptionRefundApprovedBy" uuid');
    await queryRunner.query('ALTER TABLE "support_tickets" ADD COLUMN IF NOT EXISTS "exceptionRefundApprovalNote" text NOT NULL DEFAULT \'\'');
    await queryRunner.query('ALTER TABLE "support_tickets" ADD COLUMN IF NOT EXISTS "exceptionRefundApprovedAt" TIMESTAMP WITH TIME ZONE');
    await queryRunner.query('UPDATE "support_tickets" SET "exceptionRefundApprovalStatus" = \'PENDING_REVIEW\' WHERE "type" = \'EXCEPTION_REFUND\' AND "source" = \'MERCHANT\' AND "status" = \'OPEN\' AND "exceptionRefundApprovalStatus" IS NULL');
    await queryRunner.query('CREATE INDEX IF NOT EXISTS "IDX_exception_refund_approval_queue" ON "support_tickets" ("exceptionRefundApprovalStatus", "createdAt") WHERE "type" = \'EXCEPTION_REFUND\' AND "source" = \'MERCHANT\' AND "status" = \'OPEN\'');
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX IF EXISTS "IDX_exception_refund_approval_queue"');
    await queryRunner.query('ALTER TABLE "support_tickets" DROP COLUMN IF EXISTS "exceptionRefundApprovedAt"');
    await queryRunner.query('ALTER TABLE "support_tickets" DROP COLUMN IF EXISTS "exceptionRefundApprovalNote"');
    await queryRunner.query('ALTER TABLE "support_tickets" DROP COLUMN IF EXISTS "exceptionRefundApprovedBy"');
    await queryRunner.query('ALTER TABLE "support_tickets" DROP COLUMN IF EXISTS "exceptionRefundApprovalStatus"');
  }
}
