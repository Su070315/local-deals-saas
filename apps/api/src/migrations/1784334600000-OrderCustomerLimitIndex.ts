import { MigrationInterface, QueryRunner } from 'typeorm';

export class OrderCustomerLimitIndex1784334600000 implements MigrationInterface {
  name = 'OrderCustomerLimitIndex1784334600000';
  transaction = false;

  async up(queryRunner: QueryRunner): Promise<void> {
    const useInMemoryTestSql = process.env.TYPEORM_MIGRATION_TEST === 'true';
    if (useInMemoryTestSql && process.env.NODE_ENV !== 'test') throw new Error('TYPEORM_MIGRATION_TEST 仅允许测试环境使用');
    const createIndex = useInMemoryTestSql ? 'CREATE INDEX IF NOT EXISTS' : 'CREATE INDEX CONCURRENTLY IF NOT EXISTS';
    await queryRunner.query(`${createIndex} "IDX_orders_package_customer_status" ON "orders" ("packageId", "customerId", "status")`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX CONCURRENTLY IF EXISTS "IDX_orders_package_customer_status"');
  }
}
