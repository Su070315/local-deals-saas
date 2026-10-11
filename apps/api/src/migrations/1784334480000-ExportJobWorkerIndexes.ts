import { MigrationInterface, QueryRunner } from 'typeorm';

export class ExportJobWorkerIndexes1784334480000 implements MigrationInterface {
  name = 'ExportJobWorkerIndexes1784334480000';
  transaction = false;

  async up(queryRunner: QueryRunner): Promise<void> {
    const useInMemoryTestSql = process.env.TYPEORM_MIGRATION_TEST === 'true';
    if (useInMemoryTestSql && process.env.NODE_ENV !== 'test') throw new Error('TYPEORM_MIGRATION_TEST 仅允许测试环境使用');
    const createIndex = useInMemoryTestSql ? 'CREATE INDEX IF NOT EXISTS' : 'CREATE INDEX CONCURRENTLY IF NOT EXISTS';
    await queryRunner.query(`${createIndex} "IDX_export_jobs_status_created" ON "export_jobs" ("status", "createdAt")`);
    await queryRunner.query(`${createIndex} "IDX_export_jobs_status_attempt" ON "export_jobs" ("status", "lastAttemptAt")`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX CONCURRENTLY IF EXISTS "IDX_export_jobs_status_created"');
    await queryRunner.query('DROP INDEX CONCURRENTLY IF EXISTS "IDX_export_jobs_status_attempt"');
  }
}
