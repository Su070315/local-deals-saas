import { MigrationInterface, QueryRunner } from 'typeorm';

export class StoreFulfillmentStatus1784333820000 implements MigrationInterface {
  name = 'StoreFulfillmentStatus1784333820000';

  async up(queryRunner: QueryRunner): Promise<void> {
    // Existing stores continue honoring already sold vouchers until a platform
    // operator explicitly marks them unable to fulfill.
    await queryRunner.query('ALTER TABLE "stores" ADD COLUMN IF NOT EXISTS "openForVerification" boolean NOT NULL DEFAULT true');
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE "stores" DROP COLUMN IF EXISTS "openForVerification"');
  }
}
