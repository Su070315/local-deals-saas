import { MigrationInterface, QueryRunner } from 'typeorm';

export class BillInvoiceStatus1784333400000 implements MigrationInterface {
  name = 'BillInvoiceStatus1784333400000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query("ALTER TABLE \"monthly_bills\" ADD COLUMN IF NOT EXISTS \"invoiceStatus\" character varying NOT NULL DEFAULT 'PENDING'");
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE "monthly_bills" DROP COLUMN IF EXISTS "invoiceStatus"');
  }
}
