import { MigrationInterface, QueryRunner } from 'typeorm';

/** 2026-08-12 门店级评分/附加服务：stores 加 rating + featureTags（首页按门店展示，门店可改） */
export class StoreRatingFeatureTags1784337500000 implements MigrationInterface {
  name = 'StoreRatingFeatureTags1784337500000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query("ALTER TABLE \"stores\" ADD COLUMN IF NOT EXISTS \"rating\" varchar(8) NOT NULL DEFAULT ''");
    await queryRunner.query("ALTER TABLE \"stores\" ADD COLUMN IF NOT EXISTS \"featureTags\" text NOT NULL DEFAULT '[]'");
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE "stores" DROP COLUMN IF EXISTS "featureTags"');
    await queryRunner.query('ALTER TABLE "stores" DROP COLUMN IF EXISTS "rating"');
  }
}
