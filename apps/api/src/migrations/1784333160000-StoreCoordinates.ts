import { MigrationInterface, QueryRunner } from 'typeorm';

export class StoreCoordinates1784333160000 implements MigrationInterface {
  name = 'StoreCoordinates1784333160000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE "stores" ADD COLUMN IF NOT EXISTS "latitude" double precision');
    await queryRunner.query('ALTER TABLE "stores" ADD COLUMN IF NOT EXISTS "longitude" double precision');
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE "stores" DROP COLUMN IF EXISTS "longitude"');
    await queryRunner.query('ALTER TABLE "stores" DROP COLUMN IF EXISTS "latitude"');
  }
}
