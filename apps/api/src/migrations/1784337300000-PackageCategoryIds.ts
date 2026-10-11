import { MigrationInterface, QueryRunner } from 'typeorm';

/** 2026-08-11 商品分类关联：packages 加 categoryIds（simple-json 存 settings type=PRODUCT_CATEGORY 的 id 列表） */
export class PackageCategoryIds1784337300000 implements MigrationInterface {
  name = 'PackageCategoryIds1784337300000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE "packages" ADD COLUMN IF NOT EXISTS "categoryIds" text NOT NULL DEFAULT \'[]\'');
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE "packages" DROP COLUMN IF EXISTS "categoryIds"');
  }
}
