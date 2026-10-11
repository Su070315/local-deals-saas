import { MigrationInterface, QueryRunner } from 'typeorm';

export class AuditChainVerificationIndex1784335080000 implements MigrationInterface {
  name = 'AuditChainVerificationIndex1784335080000';
  transaction = false;

  async up(queryRunner: QueryRunner): Promise<void> {
    const useInMemoryTestSql = process.env.TYPEORM_MIGRATION_TEST === 'true';
    if (useInMemoryTestSql && process.env.NODE_ENV !== 'test') throw new Error('TYPEORM_MIGRATION_TEST 仅允许测试环境使用');
    const createIndex = useInMemoryTestSql ? 'CREATE INDEX IF NOT EXISTS' : 'CREATE INDEX CONCURRENTLY IF NOT EXISTS';
    await queryRunner.query(`${createIndex} "IDX_audit_logs_chain_version_sequence" ON "audit_logs" ("chainVersion", "chainSequence")`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX CONCURRENTLY IF EXISTS "IDX_audit_logs_chain_version_sequence"');
  }
}
