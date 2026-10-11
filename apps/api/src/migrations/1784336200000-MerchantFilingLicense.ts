import { MigrationInterface, QueryRunner } from 'typeorm';

export class MerchantFilingLicense1784336200000 implements MigrationInterface {
  name = 'MerchantFilingLicense1784336200000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE "merchant_registrations" ADD COLUMN IF NOT EXISTS "filingLicenseDataUrl" text NOT NULL DEFAULT \'\'');
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE "merchant_registrations" DROP COLUMN IF EXISTS "filingLicenseDataUrl"');
  }
}
