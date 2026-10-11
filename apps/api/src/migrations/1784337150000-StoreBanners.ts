import { MigrationInterface, QueryRunner } from 'typeorm';

/** 2026-08-11 轮播图迁移至门店维度：merchant_banners 加 storeId/link，每家门店独立管理自己的首页轮播图 */
export class StoreBanners1784337150000 implements MigrationInterface {
  name = 'StoreBanners1784337150000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE "merchant_banners" ADD COLUMN IF NOT EXISTS "storeId" uuid');
    await queryRunner.query('ALTER TABLE "merchant_banners" ADD COLUMN IF NOT EXISTS "link" character varying(500) NOT NULL DEFAULT \'\'');
    await queryRunner.query('CREATE INDEX IF NOT EXISTS "IDX_merchant_banners_store_sort" ON "merchant_banners" ("storeId", "sortOrder")');
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX IF EXISTS "IDX_merchant_banners_store_sort"');
    await queryRunner.query('ALTER TABLE "merchant_banners" DROP COLUMN IF EXISTS "link"');
    await queryRunner.query('ALTER TABLE "merchant_banners" DROP COLUMN IF EXISTS "storeId"');
  }
}
