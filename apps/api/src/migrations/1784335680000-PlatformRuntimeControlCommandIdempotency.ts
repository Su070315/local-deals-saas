import { MigrationInterface, QueryRunner } from 'typeorm';

/** Retry-safe command records for platform runtime controls. */
export class PlatformRuntimeControlCommandIdempotency1784335680000 implements MigrationInterface {
  name = 'PlatformRuntimeControlCommandIdempotency1784335680000';
  transaction = false;

  async up(queryRunner: QueryRunner): Promise<void> {
    const useInMemoryTestSql = process.env.TYPEORM_MIGRATION_TEST === 'true';
    if (useInMemoryTestSql && process.env.NODE_ENV !== 'test') throw new Error('TYPEORM_MIGRATION_TEST 仅允许测试环境使用');
    // pg-mem-test-only: the embedded migration harness cannot parse CONCURRENTLY.
    const createIndex = useInMemoryTestSql ? 'CREATE INDEX IF NOT EXISTS' : 'CREATE INDEX CONCURRENTLY IF NOT EXISTS';
    const createUniqueIndex = useInMemoryTestSql ? 'CREATE UNIQUE INDEX IF NOT EXISTS' : 'CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS';
    await queryRunner.query(`CREATE TABLE IF NOT EXISTS "platform_runtime_control_commands" (
      "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
      "controlKey" character varying(64) NOT NULL,
      "requestedBy" uuid NOT NULL,
      "action" character varying(32) NOT NULL,
      "expectedVersion" integer NOT NULL,
      "idempotencyKey" character varying(128) NOT NULL,
      "requestHash" character varying(64) NOT NULL,
      "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
      CONSTRAINT "PK_platform_runtime_control_commands" PRIMARY KEY ("id")
    )`);
    await queryRunner.query(`${createIndex} "IDX_platform_runtime_control_command_control" ON "platform_runtime_control_commands" ("controlKey")`);
    await queryRunner.query(`${createUniqueIndex} "UQ_platform_runtime_control_command_idempotency" ON "platform_runtime_control_commands" ("controlKey", "requestedBy", "idempotencyKey")`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS "platform_runtime_control_commands"');
  }
}
