import { MigrationInterface, QueryRunner } from 'typeorm';

/** 2026-08-11 商家顶部轮播图（替代原商家头像展示）：图片持久化绑定商家，支持增删/替换/排序/设默认 */
export class MerchantBanners1784337100000 implements MigrationInterface {
  name = 'MerchantBanners1784337100000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TABLE IF NOT EXISTS "merchant_banners" (
      "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
      "merchantId" uuid NOT NULL,
      "url" character varying(500) NOT NULL,
      "sortOrder" integer NOT NULL DEFAULT 0,
      "isDefault" boolean NOT NULL DEFAULT false,
      "createdAt" timestamptz NOT NULL DEFAULT now(),
      "updatedAt" timestamptz NOT NULL DEFAULT now()
    )`);
    await queryRunner.query('CREATE INDEX IF NOT EXISTS "IDX_merchant_banners_merchant" ON "merchant_banners" ("merchantId")');
    await queryRunner.query('CREATE INDEX IF NOT EXISTS "IDX_merchant_banners_merchant_sort" ON "merchant_banners" ("merchantId", "sortOrder")');
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS "merchant_banners"');
  }
}
