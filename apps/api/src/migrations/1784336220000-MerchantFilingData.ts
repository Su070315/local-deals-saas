import { MigrationInterface, QueryRunner } from 'typeorm';

export class MerchantFilingData1784336220000 implements MigrationInterface {
  name = 'MerchantFilingData1784336220000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE "merchant_registrations" ADD COLUMN IF NOT EXISTS "filingDataJson" text NOT NULL DEFAULT \'{}\'');
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE "merchant_registrations" DROP COLUMN IF EXISTS "filingDataJson"');
  }
}
