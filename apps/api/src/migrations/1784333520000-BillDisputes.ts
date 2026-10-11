import { MigrationInterface, QueryRunner } from 'typeorm';

export class BillDisputes1784333520000 implements MigrationInterface {
  name = 'BillDisputes1784333520000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('CREATE TABLE IF NOT EXISTS "bill_disputes" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "billId" uuid NOT NULL, "merchantId" uuid NOT NULL, "submittedBy" uuid NOT NULL, "content" text NOT NULL, "status" character varying NOT NULL DEFAULT \'OPEN\', "resolutionNote" text NOT NULL DEFAULT \'\', "resolvedBy" uuid, "resolvedAt" TIMESTAMP WITH TIME ZONE, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_bill_disputes" PRIMARY KEY ("id"))');
    await queryRunner.query('CREATE UNIQUE INDEX IF NOT EXISTS "IDX_bill_disputes_bill" ON "bill_disputes" ("billId")');
    await queryRunner.query('CREATE INDEX IF NOT EXISTS "IDX_bill_disputes_merchant_status" ON "bill_disputes" ("merchantId", "status")');
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS "bill_disputes"');
  }
}
