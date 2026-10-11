import { MigrationInterface, QueryRunner } from 'typeorm';

export class ExportJobIdempotency1784334720000 implements MigrationInterface {
  name = 'ExportJobIdempotency1784334720000';
  transaction = false;

  async up(queryRunner: QueryRunner): Promise<void> {
    const useInMemoryTestSql = process.env.TYPEORM_MIGRATION_TEST === 'true';
    if (useInMemoryTestSql && process.env.NODE_ENV !== 'test') throw new Error('TYPEORM_MIGRATION_TEST 仅允许测试环境使用');
    const createIndex = useInMemoryTestSql ? 'CREATE UNIQUE INDEX IF NOT EXISTS' : 'CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS';
    await queryRunner.query('ALTER TABLE "export_jobs" ADD COLUMN IF NOT EXISTS "idempotencyKey" character varying');
    await queryRunner.query('ALTER TABLE "export_jobs" ADD COLUMN IF NOT EXISTS "requestHash" character varying');
    await queryRunner.query(`${createIndex} "IDX_export_jobs_request_idempotency" ON "export_jobs" ("requestedBy", "idempotencyKey") WHERE "idempotencyKey" IS NOT NULL`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX CONCURRENTLY IF EXISTS "IDX_export_jobs_request_idempotency"');
    await queryRunner.query('ALTER TABLE "export_jobs" DROP COLUMN IF EXISTS "requestHash"');
    await queryRunner.query('ALTER TABLE "export_jobs" DROP COLUMN IF EXISTS "idempotencyKey"');
  }
}
