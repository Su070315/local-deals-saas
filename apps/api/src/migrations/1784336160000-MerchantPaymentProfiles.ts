import { MigrationInterface, QueryRunner } from 'typeorm';

export class MerchantPaymentProfiles1784336160000 implements MigrationInterface {
  name = 'MerchantPaymentProfiles1784336160000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TABLE IF NOT EXISTS "merchant_payment_profiles" (
      "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
      "merchantId" uuid NOT NULL,
      "provider" varchar(32) NOT NULL DEFAULT 'HUIFU',
      "externalMerchantNo" varchar(64) NOT NULL,
      "providerMerchantId" varchar(64),
      "applicationNo" varchar(64) NOT NULL DEFAULT '',
      "status" varchar(24) NOT NULL DEFAULT 'PENDING',
      "version" integer NOT NULL DEFAULT 1,
      "verifiedBy" uuid,
      "verifiedAt" timestamptz,
      "updatedBy" uuid NOT NULL,
      "createdAt" timestamptz NOT NULL DEFAULT now(),
      "updatedAt" timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT "PK_merchant_payment_profiles" PRIMARY KEY ("id"),
      CONSTRAINT "FK_merchant_payment_profiles_merchant" FOREIGN KEY ("merchantId") REFERENCES "merchants"("id") ON DELETE RESTRICT,
      CONSTRAINT "UQ_merchant_payment_profiles_provider_merchant" UNIQUE ("provider", "merchantId"),
      CONSTRAINT "UQ_merchant_payment_profiles_provider_external" UNIQUE ("provider", "externalMerchantNo"),
      CONSTRAINT "UQ_merchant_payment_profiles_provider_account" UNIQUE ("provider", "providerMerchantId")
    )`);
    await queryRunner.query('ALTER TABLE "payment_outbox" ADD COLUMN IF NOT EXISTS "provider" varchar(32)');
    await queryRunner.query('ALTER TABLE "payment_outbox" ADD COLUMN IF NOT EXISTS "paymentProfileId" uuid');
    await queryRunner.query('ALTER TABLE "payment_outbox" ADD COLUMN IF NOT EXISTS "providerMerchantId" varchar(64)');
    await queryRunner.query('ALTER TABLE "payment_events" ADD COLUMN IF NOT EXISTS "providerMerchantId" varchar(64)');
    await queryRunner.query('ALTER TABLE "payment_outbox" ADD CONSTRAINT "FK_payment_outbox_payment_profile" FOREIGN KEY ("paymentProfileId") REFERENCES "merchant_payment_profiles"("id") ON DELETE RESTRICT');
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE "payment_outbox" DROP CONSTRAINT IF EXISTS "FK_payment_outbox_payment_profile"');
    await queryRunner.query('ALTER TABLE "payment_events" DROP COLUMN IF EXISTS "providerMerchantId"');
    await queryRunner.query('ALTER TABLE "payment_outbox" DROP COLUMN IF EXISTS "providerMerchantId"');
    await queryRunner.query('ALTER TABLE "payment_outbox" DROP COLUMN IF EXISTS "paymentProfileId"');
    await queryRunner.query('ALTER TABLE "payment_outbox" DROP COLUMN IF EXISTS "provider"');
    await queryRunner.query('DROP TABLE IF EXISTS "merchant_payment_profiles"');
  }
}
