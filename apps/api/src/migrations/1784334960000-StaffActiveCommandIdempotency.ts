import { MigrationInterface, QueryRunner } from 'typeorm';

export class StaffActiveCommandIdempotency1784334960000 implements MigrationInterface {
  name = 'StaffActiveCommandIdempotency1784334960000';
  transaction = false;

  async up(queryRunner: QueryRunner): Promise<void> {
    const useInMemoryTestSql = process.env.TYPEORM_MIGRATION_TEST === 'true';
    if (useInMemoryTestSql && process.env.NODE_ENV !== 'test') throw new Error('TYPEORM_MIGRATION_TEST 仅允许测试环境使用');
    const createIndex = useInMemoryTestSql ? 'CREATE INDEX IF NOT EXISTS' : 'CREATE INDEX CONCURRENTLY IF NOT EXISTS';
    const createUniqueIndex = useInMemoryTestSql ? 'CREATE UNIQUE INDEX IF NOT EXISTS' : 'CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS';
    await queryRunner.query(`CREATE TABLE IF NOT EXISTS "staff_active_commands" (
      "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
      "merchantId" uuid NOT NULL,
      "staffId" uuid NOT NULL,
      "requestedBy" uuid NOT NULL,
      "active" boolean NOT NULL,
      "idempotencyKey" character varying NOT NULL,
      "requestHash" character varying NOT NULL,
      "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
      CONSTRAINT "PK_staff_active_commands" PRIMARY KEY ("id")
    )`);
    await queryRunner.query(`${createIndex} "IDX_staff_active_command_staff" ON "staff_active_commands" ("merchantId", "staffId")`);
    await queryRunner.query(`${createUniqueIndex} "IDX_staff_active_command_idempotency" ON "staff_active_commands" ("merchantId", "staffId", "requestedBy", "idempotencyKey")`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS "staff_active_commands"');
  }
}
