import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * A nullable profile preserves existing PLATFORM_ADMIN accounts as explicit
 * break-glass system administrators while allowing new accounts to be scoped
 * to operations, finance, compliance or security.
 */
export class PlatformAccessProfiles1784334060000 implements MigrationInterface {
  name = 'PlatformAccessProfiles1784334060000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "platformAccessProfile" character varying');
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE "users" DROP COLUMN IF EXISTS "platformAccessProfile"');
  }
}
