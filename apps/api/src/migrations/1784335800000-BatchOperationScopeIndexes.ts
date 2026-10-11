import { MigrationInterface, QueryRunner } from 'typeorm';

/** Supports merchant-scoped batch task history without a sort spill. */
export class BatchOperationScopeIndexes1784335800000 implements MigrationInterface {
  name = 'BatchOperationScopeIndexes1784335800000';
  transaction = false;

  async up(queryRunner: QueryRunner): Promise<void> {
    const inMemory = process.env.TYPEORM_MIGRATION_TEST === 'true';
    if (inMemory && process.env.NODE_ENV !== 'test') throw new Error('TYPEORM_MIGRATION_TEST 仅允许测试环境使用');
    // pg-mem-test-only: the embedded migration runner cannot parse CONCURRENTLY.
    const createIndex = inMemory ? 'CREATE INDEX IF NOT EXISTS' : 'CREATE INDEX CONCURRENTLY IF NOT EXISTS';
    await queryRunner.query(`${createIndex} "IDX_batch_operations_merchant_created_id" ON "batch_operations" ("merchantId", "createdAt" DESC, "id" DESC)`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    const inMemory = process.env.TYPEORM_MIGRATION_TEST === 'true';
    const dropIndex = inMemory ? 'DROP INDEX IF EXISTS' : 'DROP INDEX CONCURRENTLY IF EXISTS';
    await queryRunner.query(`${dropIndex} "IDX_batch_operations_merchant_created_id"`);
  }
}
