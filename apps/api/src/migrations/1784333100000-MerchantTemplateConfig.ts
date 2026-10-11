import { MigrationInterface, QueryRunner } from 'typeorm';

export class MerchantTemplateConfig1784333100000 implements MigrationInterface {
  name = 'MerchantTemplateConfig1784333100000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('CREATE TABLE "merchant_template_configs" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "merchantId" uuid NOT NULL, "homeTitle" character varying NOT NULL DEFAULT \'\', "homeSubtitle" text NOT NULL DEFAULT \'\', "featuredPackageId" uuid, "version" integer NOT NULL DEFAULT 1, "updatedBy" uuid, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_merchant_template_configs" PRIMARY KEY ("id"))');
    await queryRunner.query('CREATE UNIQUE INDEX "IDX_merchant_template_configs_merchant" ON "merchant_template_configs" ("merchantId")');
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE "merchant_template_configs"');
  }
}
