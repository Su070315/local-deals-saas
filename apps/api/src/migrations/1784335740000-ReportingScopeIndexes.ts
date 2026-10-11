import { MigrationInterface, QueryRunner } from 'typeorm';

/** Adds composite indexes used by merchant-scoped reporting aggregates. */
export class ReportingScopeIndexes1784335740000 implements MigrationInterface {
  name = 'ReportingScopeIndexes1784335740000';
  transaction = false;

  async up(queryRunner: QueryRunner): Promise<void> {
    const inMemory = process.env.TYPEORM_MIGRATION_TEST === 'true';
    if (inMemory && process.env.NODE_ENV !== 'test') throw new Error('TYPEORM_MIGRATION_TEST 仅允许测试环境使用');
    // pg-mem-test-only: the embedded migration runner cannot parse CONCURRENTLY.
    const createIndex = inMemory ? 'CREATE INDEX IF NOT EXISTS' : 'CREATE INDEX CONCURRENTLY IF NOT EXISTS';
    await queryRunner.query(`${createIndex} "IDX_refunds_merchant_status_created" ON "refunds" ("merchantId", "status", "createdAt")`);
    await queryRunner.query(`${createIndex} "IDX_ledger_merchant_occurred" ON "settlement_ledger_entries" ("merchantId", "occurredAt")`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    const inMemory = process.env.TYPEORM_MIGRATION_TEST === 'true';
    const dropIndex = inMemory ? 'DROP INDEX IF EXISTS' : 'DROP INDEX CONCURRENTLY IF EXISTS';
    await queryRunner.query(`${dropIndex} "IDX_ledger_merchant_occurred"`);
    await queryRunner.query(`${dropIndex} "IDX_refunds_merchant_status_created"`);
  }
}
