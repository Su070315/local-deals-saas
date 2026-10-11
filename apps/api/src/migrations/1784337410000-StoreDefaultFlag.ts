import { MigrationInterface, QueryRunner } from 'typeorm';

/** 2026-08-12 门店总店标记：stores 加 isDefault（首页总店/分店标签与切换） */
export class StoreDefaultFlag1784337410000 implements MigrationInterface {
  name = 'StoreDefaultFlag1784337410000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE "stores" ADD COLUMN IF NOT EXISTS "isDefault" boolean NOT NULL DEFAULT false');
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE "stores" DROP COLUMN IF EXISTS "isDefault"');
  }
}
