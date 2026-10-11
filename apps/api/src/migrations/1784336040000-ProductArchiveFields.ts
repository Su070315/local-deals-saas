import { MigrationInterface, QueryRunner } from 'typeorm';

/** Additive product archive fields based on the merchant product workflow. */
export class ProductArchiveFields1784336040000 implements MigrationInterface {
  name = 'ProductArchiveFields1784336040000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE "packages" ADD COLUMN "productType" character varying(32) NOT NULL DEFAULT \'GROUP_BUY\'');
    await queryRunner.query('ALTER TABLE "packages" ADD COLUMN "skuCode" character varying(64) NOT NULL DEFAULT \'\'');
    await queryRunner.query('ALTER TABLE "packages" ADD COLUMN "barcode" character varying(64) NOT NULL DEFAULT \'\'');
    await queryRunner.query('ALTER TABLE "packages" ADD COLUMN "recommendation" character varying(500) NOT NULL DEFAULT \'\'');
    await queryRunner.query('ALTER TABLE "packages" ADD COLUMN "galleryUrls" text NOT NULL DEFAULT \'[]\'');
    await queryRunner.query('ALTER TABLE "packages" ADD COLUMN "videoUrl" character varying(1000)');
    await queryRunner.query('ALTER TABLE "packages" ADD COLUMN "memberPriceFen" bigint');
    await queryRunner.query('ALTER TABLE "packages" ADD COLUMN "purchasePriceFen" bigint');
    await queryRunner.query('ALTER TABLE "packages" ADD COLUMN "categoryName" character varying(120) NOT NULL DEFAULT \'\'');
    await queryRunner.query('ALTER TABLE "packages" ADD COLUMN "unit" character varying(20) NOT NULL DEFAULT \'份\'');
    await queryRunner.query('ALTER TABLE "packages" ADD COLUMN "minPurchaseQuantity" integer NOT NULL DEFAULT 1');
    await queryRunner.query('ALTER TABLE "packages" ADD COLUMN "virtualSales" integer NOT NULL DEFAULT 0');
    await queryRunner.query('ALTER TABLE "packages" ADD COLUMN "fulfillmentMethods" text NOT NULL DEFAULT \'["STORE_PICKUP"]\'');
    await queryRunner.query('ALTER TABLE "packages" ADD COLUMN "distributionEnabled" boolean NOT NULL DEFAULT false');
    await queryRunner.query('ALTER TABLE "packages" ADD COLUMN "batchManaged" boolean NOT NULL DEFAULT false');
    await queryRunner.query('ALTER TABLE "packages" ADD COLUMN "pointsEnabled" boolean NOT NULL DEFAULT true');
    await queryRunner.query('ALTER TABLE "packages" ADD COLUMN "inventoryEnabled" boolean NOT NULL DEFAULT true');
    await queryRunner.query('ALTER TABLE "packages" ADD COLUMN "inventoryWarningThreshold" integer NOT NULL DEFAULT 0');
    await queryRunner.query('ALTER TABLE "packages" ADD COLUMN "salesChannels" text NOT NULL DEFAULT \'["ONLINE","OFFLINE"]\'');
    await queryRunner.query('ALTER TABLE "packages" ADD COLUMN "guaranteeLabels" text NOT NULL DEFAULT \'[]\'');
    await queryRunner.query('ALTER TABLE "packages" ADD COLUMN "parameterValues" text NOT NULL DEFAULT \'[]\'');
    await queryRunner.query('ALTER TABLE "packages" ADD COLUMN "detailContent" text NOT NULL DEFAULT \'\'');
    await queryRunner.query('ALTER TABLE "packages" ADD CONSTRAINT "CHK_packages_product_type" CHECK ("productType" IN (\'STANDARD\', \'GROUP_BUY\', \'WEIGHED\', \'MULTI_SPEC\'))');
    await queryRunner.query('ALTER TABLE "packages" ADD CONSTRAINT "CHK_packages_member_price" CHECK ("memberPriceFen" IS NULL OR ("memberPriceFen" > 0 AND "memberPriceFen" <= "priceFen"))');
    await queryRunner.query('ALTER TABLE "packages" ADD CONSTRAINT "CHK_packages_purchase_price" CHECK ("purchasePriceFen" IS NULL OR "purchasePriceFen" > 0)');
    await queryRunner.query('ALTER TABLE "packages" ADD CONSTRAINT "CHK_packages_archive_counts" CHECK ("minPurchaseQuantity" > 0 AND "virtualSales" >= 0 AND "inventoryWarningThreshold" >= 0)');
    await queryRunner.query('CREATE INDEX "IDX_packages_merchant_sku" ON "packages" ("merchantId", "skuCode")');
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX "IDX_packages_merchant_sku"');
    await queryRunner.query('ALTER TABLE "packages" DROP CONSTRAINT "CHK_packages_archive_counts"');
    await queryRunner.query('ALTER TABLE "packages" DROP CONSTRAINT "CHK_packages_purchase_price"');
    await queryRunner.query('ALTER TABLE "packages" DROP CONSTRAINT "CHK_packages_member_price"');
    await queryRunner.query('ALTER TABLE "packages" DROP CONSTRAINT "CHK_packages_product_type"');
    for (const column of ['detailContent', 'parameterValues', 'guaranteeLabels', 'salesChannels', 'inventoryWarningThreshold', 'inventoryEnabled', 'pointsEnabled', 'batchManaged', 'distributionEnabled', 'fulfillmentMethods', 'virtualSales', 'minPurchaseQuantity', 'unit', 'categoryName', 'purchasePriceFen', 'memberPriceFen', 'videoUrl', 'galleryUrls', 'recommendation', 'barcode', 'skuCode', 'productType']) {
      await queryRunner.query(`ALTER TABLE "packages" DROP COLUMN "${column}"`);
    }
  }
}
