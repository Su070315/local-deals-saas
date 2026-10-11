import { MigrationInterface, QueryRunner } from 'typeorm';

export class SupportTicketOrigin1784332920000 implements MigrationInterface {
  name = 'SupportTicketOrigin1784332920000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE "support_tickets" ALTER COLUMN "customerId" DROP NOT NULL');
    await queryRunner.query('ALTER TABLE "support_tickets" ADD COLUMN IF NOT EXISTS "source" character varying NOT NULL DEFAULT \'CUSTOMER\'');
    await queryRunner.query('ALTER TABLE "support_tickets" ADD COLUMN IF NOT EXISTS "type" character varying NOT NULL DEFAULT \'GENERAL\'');
    await queryRunner.query('ALTER TABLE "support_tickets" ADD COLUMN IF NOT EXISTS "submittedBy" uuid');
    await queryRunner.query('CREATE INDEX IF NOT EXISTS "IDX_6f1e91a07e90aac9b2e19e7f9f" ON "support_tickets" ("merchantId", "type", "status")');
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX IF EXISTS "IDX_6f1e91a07e90aac9b2e19e7f9f"');
    await queryRunner.query('UPDATE "support_tickets" SET "customerId" = \'\' WHERE "customerId" IS NULL');
    await queryRunner.query('ALTER TABLE "support_tickets" ALTER COLUMN "customerId" SET NOT NULL');
    await queryRunner.query('ALTER TABLE "support_tickets" DROP COLUMN IF EXISTS "submittedBy"');
    await queryRunner.query('ALTER TABLE "support_tickets" DROP COLUMN IF EXISTS "type"');
    await queryRunner.query('ALTER TABLE "support_tickets" DROP COLUMN IF EXISTS "source"');
  }
}
