import { MigrationInterface, QueryRunner } from 'typeorm';

export class CustomerVoucherPageIndex1784334660000 implements MigrationInterface {
  name = 'CustomerVoucherPageIndex1784334660000';
  transaction = false;

  async up(queryRunner: QueryRunner): Promise<void> {
    const useInMemoryTestSql = process.env.TYPEORM_MIGRATION_TEST === 'true';
    if (useInMemoryTestSql && process.env.NODE_ENV !== 'test') throw new Error('TYPEORM_MIGRATION_TEST 仅允许测试环境使用');
    const createIndex = useInMemoryTestSql ? 'CREATE INDEX IF NOT EXISTS' : 'CREATE INDEX CONCURRENTLY IF NOT EXISTS';
    await queryRunner.query(`${createIndex} "IDX_vouchers_customer_created" ON "vouchers" ("customerId", "createdAt" DESC, "id" DESC)`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX CONCURRENTLY IF EXISTS "IDX_vouchers_customer_created"');
  }
}
