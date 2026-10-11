import { MigrationInterface, QueryRunner } from 'typeorm';

export class MerchantAppConfigs1784336120000 implements MigrationInterface {
  name = 'MerchantAppConfigs1784336120000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TABLE IF NOT EXISTS "merchant_app_configs" (
      "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
      "merchantId" uuid NOT NULL,
      "configVersion" integer NOT NULL DEFAULT 1,
      "config" jsonb NOT NULL DEFAULT '{}'::jsonb,
      "updatedBy" uuid,
      "createdAt" timestamptz NOT NULL DEFAULT now(),
      "updatedAt" timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT "PK_merchant_app_configs" PRIMARY KEY ("id"),
      CONSTRAINT "UQ_merchant_app_configs_merchant" UNIQUE ("merchantId")
    )`);
    await queryRunner.query('CREATE INDEX IF NOT EXISTS "IDX_merchant_app_configs_merchant" ON "merchant_app_configs" ("merchantId")');
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX IF EXISTS "IDX_merchant_app_configs_merchant"');
    await queryRunner.query('DROP TABLE IF EXISTS "merchant_app_configs"');
  }
}
