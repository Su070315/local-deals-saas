import { MigrationInterface, QueryRunner } from 'typeorm';

/** Additive validity policy fields. Existing packages remain ABSOLUTE. */
export class PackageValidityMode1784337900000 implements MigrationInterface {
  name = 'PackageValidityMode1784337900000';
  transaction = false;

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE "packages" ADD COLUMN IF NOT EXISTS "validityMode" varchar(24) NOT NULL DEFAULT \'ABSOLUTE\'');
    await queryRunner.query('ALTER TABLE "packages" ADD COLUMN IF NOT EXISTS "validityDurationDays" integer');
    await queryRunner.query('ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "validityModeSnapshot" varchar(24) NOT NULL DEFAULT \'ABSOLUTE\'');
    await queryRunner.query('ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "validityDurationDaysSnapshot" integer');
    const useInMemoryTestSql = process.env.TYPEORM_MIGRATION_TEST === 'true';
    if (useInMemoryTestSql && process.env.NODE_ENV !== 'test') throw new Error('TYPEORM_MIGRATION_TEST 仅允许测试环境使用');
    const addConstraint = async (constraint: string, expression: string) => {
      if (useInMemoryTestSql) {
        await queryRunner.query(`ALTER TABLE "${constraint.startsWith('CHK_orders') ? 'orders' : 'packages'}" ADD CONSTRAINT "${constraint}" CHECK (${expression})`);
        return;
      }
      await queryRunner.query(`DO $$
        BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = '${constraint}') THEN
            ALTER TABLE "${constraint.startsWith('CHK_orders') ? 'orders' : 'packages'}" ADD CONSTRAINT "${constraint}" CHECK (${expression});
          END IF;
        END
      $$`);
    };
    await addConstraint('CHK_packages_validity_mode', '"validityMode" IN (\'ABSOLUTE\', \'PURCHASE_RELATIVE\')');
    await addConstraint('CHK_packages_validity_duration', '"validityMode" = \'ABSOLUTE\' OR ("validityDurationDays" IS NOT NULL AND "validityDurationDays" >= 1 AND "validityDurationDays" <= 3650)');
    await addConstraint('CHK_orders_validity_mode_snapshot', '"validityModeSnapshot" IN (\'ABSOLUTE\', \'PURCHASE_RELATIVE\')');
    await addConstraint('CHK_orders_validity_duration_snapshot', '"validityModeSnapshot" = \'ABSOLUTE\' OR ("validityDurationDaysSnapshot" IS NOT NULL AND "validityDurationDaysSnapshot" >= 1 AND "validityDurationDaysSnapshot" <= 3650)');
    const createIndex = useInMemoryTestSql ? 'CREATE INDEX IF NOT EXISTS' : 'CREATE INDEX CONCURRENTLY IF NOT EXISTS';
    await queryRunner.query(`${createIndex} "IDX_packages_validity_mode" ON "packages" ("validityMode", "validityDurationDays")`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX CONCURRENTLY IF EXISTS "IDX_packages_validity_mode"');
    await queryRunner.query('ALTER TABLE "orders" DROP CONSTRAINT IF EXISTS "CHK_orders_validity_duration_snapshot"');
    await queryRunner.query('ALTER TABLE "orders" DROP CONSTRAINT IF EXISTS "CHK_orders_validity_mode_snapshot"');
    await queryRunner.query('ALTER TABLE "packages" DROP CONSTRAINT IF EXISTS "CHK_packages_validity_duration"');
    await queryRunner.query('ALTER TABLE "packages" DROP CONSTRAINT IF EXISTS "CHK_packages_validity_mode"');
    await queryRunner.query('ALTER TABLE "orders" DROP COLUMN IF EXISTS "validityDurationDaysSnapshot"');
    await queryRunner.query('ALTER TABLE "orders" DROP COLUMN IF EXISTS "validityModeSnapshot"');
    await queryRunner.query('ALTER TABLE "packages" DROP COLUMN IF EXISTS "validityDurationDays"');
    await queryRunner.query('ALTER TABLE "packages" DROP COLUMN IF EXISTS "validityMode"');
  }
}
