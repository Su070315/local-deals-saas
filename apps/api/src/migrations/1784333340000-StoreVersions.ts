import { MigrationInterface, QueryRunner } from 'typeorm';

export class StoreVersions1784333340000 implements MigrationInterface {
  name = 'StoreVersions1784333340000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE "stores" ADD COLUMN IF NOT EXISTS "version" integer NOT NULL DEFAULT 1');
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE "stores" DROP COLUMN IF EXISTS "version"');
  }
}
