import { MigrationInterface, QueryRunner } from 'typeorm';

export class SupportTicketSla1784333700000 implements MigrationInterface {
  name = 'SupportTicketSla1784333700000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE "support_tickets" ADD COLUMN IF NOT EXISTS "firstResponseDueAt" TIMESTAMP WITH TIME ZONE');
    await queryRunner.query('ALTER TABLE "support_tickets" ADD COLUMN IF NOT EXISTS "firstRespondedAt" TIMESTAMP WITH TIME ZONE');
    await queryRunner.query('ALTER TABLE "support_tickets" ADD COLUMN IF NOT EXISTS "firstRespondedBy" uuid');
    await queryRunner.query('CREATE INDEX IF NOT EXISTS "IDX_support_ticket_first_response_due" ON "support_tickets" ("firstResponseDueAt") WHERE "firstRespondedAt" IS NULL AND "status" = \'OPEN\'');
    await queryRunner.query('CREATE TABLE IF NOT EXISTS "support_ticket_replies" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "ticketId" uuid NOT NULL, "merchantId" uuid NOT NULL, "authorId" uuid NOT NULL, "authorRole" character varying NOT NULL, "visibility" character varying NOT NULL DEFAULT \'CUSTOMER\', "content" text NOT NULL, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_support_ticket_replies" PRIMARY KEY ("id"))');
    await queryRunner.query('CREATE INDEX IF NOT EXISTS "IDX_support_ticket_replies_ticket_created" ON "support_ticket_replies" ("ticketId", "createdAt")');
    await queryRunner.query('CREATE INDEX IF NOT EXISTS "IDX_support_ticket_replies_merchant" ON "support_ticket_replies" ("merchantId")');
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS "support_ticket_replies"');
    await queryRunner.query('DROP INDEX IF EXISTS "IDX_support_ticket_first_response_due"');
    await queryRunner.query('ALTER TABLE "support_tickets" DROP COLUMN IF EXISTS "firstRespondedBy"');
    await queryRunner.query('ALTER TABLE "support_tickets" DROP COLUMN IF EXISTS "firstRespondedAt"');
    await queryRunner.query('ALTER TABLE "support_tickets" DROP COLUMN IF EXISTS "firstResponseDueAt"');
  }
}
