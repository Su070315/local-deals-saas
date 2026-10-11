import { MigrationInterface, QueryRunner } from 'typeorm';

/** Additive merchandising fields used by the customer-facing package template. */
export class PackageMerchandisingFields1784335200000 implements MigrationInterface {
  name = 'PackageMerchandisingFields1784335200000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE "packages" ADD COLUMN "coverImageUrl" character varying(1000)');
    await queryRunner.query('ALTER TABLE "packages" ADD COLUMN "originalPriceFen" bigint');
    await queryRunner.query('ALTER TABLE "packages" ADD COLUMN "tags" text NOT NULL DEFAULT \'[]\'');
    await queryRunner.query('ALTER TABLE "packages" ADD COLUMN "purchaseNotes" text NOT NULL DEFAULT \'\'');
    await queryRunner.query('ALTER TABLE "packages" ADD COLUMN "usageRules" text NOT NULL DEFAULT \'\'');
    await queryRunner.query('ALTER TABLE "packages" ADD CONSTRAINT "CHK_packages_original_price" CHECK ("originalPriceFen" IS NULL OR ("originalPriceFen" >= "priceFen" AND "originalPriceFen" > 0))');
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE "packages" DROP CONSTRAINT "CHK_packages_original_price"');
    await queryRunner.query('ALTER TABLE "packages" DROP COLUMN "usageRules"');
    await queryRunner.query('ALTER TABLE "packages" DROP COLUMN "purchaseNotes"');
    await queryRunner.query('ALTER TABLE "packages" DROP COLUMN "tags"');
    await queryRunner.query('ALTER TABLE "packages" DROP COLUMN "originalPriceFen"');
    await queryRunner.query('ALTER TABLE "packages" DROP COLUMN "coverImageUrl"');
  }
}
