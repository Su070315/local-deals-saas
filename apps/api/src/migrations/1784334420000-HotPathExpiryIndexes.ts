import { MigrationInterface, QueryRunner } from 'typeorm';

export class HotPathExpiryIndexes1784334420000 implements MigrationInterface {
  name = 'HotPathExpiryIndexes1784334420000';
  transaction = false;

  async up(queryRunner: QueryRunner): Promise<void> {
    const useInMemoryTestSql = process.env.TYPEORM_MIGRATION_TEST === 'true';
    if (useInMemoryTestSql && process.env.NODE_ENV !== 'test') throw new Error('TYPEORM_MIGRATION_TEST 仅允许测试环境使用');
    const createIndex = useInMemoryTestSql ? 'CREATE INDEX IF NOT EXISTS' : 'CREATE INDEX CONCURRENTLY IF NOT EXISTS';
    await queryRunner.query(`${createIndex} "IDX_orders_status_payment_expiry" ON "orders" ("status", "paymentExpiresAt")`);
    await queryRunner.query(`${createIndex} "IDX_vouchers_status_valid_to" ON "vouchers" ("status", "validTo")`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX CONCURRENTLY IF EXISTS "IDX_orders_status_payment_expiry"');
    await queryRunner.query('DROP INDEX CONCURRENTLY IF EXISTS "IDX_vouchers_status_valid_to"');
  }
}
