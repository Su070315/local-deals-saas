import { MigrationInterface, QueryRunner } from 'typeorm';

export class PaymentProfileWxAppletAppId1784336260000 implements MigrationInterface {
  name = 'PaymentProfileWxAppletAppId1784336260000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE "merchant_payment_profiles" ADD COLUMN IF NOT EXISTS "wxAppletAppId" varchar(32) NOT NULL DEFAULT \'\'');
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE "merchant_payment_profiles" DROP COLUMN IF EXISTS "wxAppletAppId"');
  }
}
