import { MigrationInterface, QueryRunner } from 'typeorm';

/** 2026-08-12 商家资料增强：merchants 加 rating（评分，管理端可改）+ featureTags（附加服务标签，管理端可配） */
export class MerchantRatingFeatureTags1784337400000 implements MigrationInterface {
  name = 'MerchantRatingFeatureTags1784337400000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query("ALTER TABLE \"merchants\" ADD COLUMN IF NOT EXISTS \"rating\" varchar(8) NOT NULL DEFAULT '5.0'");
    await queryRunner.query("ALTER TABLE \"merchants\" ADD COLUMN IF NOT EXISTS \"featureTags\" text NOT NULL DEFAULT '[]'");
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE "merchants" DROP COLUMN IF EXISTS "featureTags"');
    await queryRunner.query('ALTER TABLE "merchants" DROP COLUMN IF EXISTS "rating"');
  }
}
