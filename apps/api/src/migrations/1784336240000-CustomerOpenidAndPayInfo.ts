import { MigrationInterface, QueryRunner } from 'typeorm';

export class CustomerOpenidAndPayInfo1784336240000 implements MigrationInterface {
  name = 'CustomerOpenidAndPayInfo1784336240000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE "customer_profiles" ADD COLUMN IF NOT EXISTS "openidCiphertext" text NOT NULL DEFAULT \'\'');
    await queryRunner.query('ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "payInfo" text NOT NULL DEFAULT \'\'');
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE "orders" DROP COLUMN IF EXISTS "payInfo"');
    await queryRunner.query('ALTER TABLE "customer_profiles" DROP COLUMN IF EXISTS "openidCiphertext"');
  }
}
