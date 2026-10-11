import { MigrationInterface, QueryRunner } from 'typeorm';

export class MonthlyBillGenerationIdempotency1784335020000 implements MigrationInterface {
  name = 'MonthlyBillGenerationIdempotency1784335020000';
  transaction = false;

  async up(queryRunner: QueryRunner): Promise<void> {
    const useInMemoryTestSql = process.env.TYPEORM_MIGRATION_TEST === 'true';
    if (useInMemoryTestSql && process.env.NODE_ENV !== 'test') throw new Error('TYPEORM_MIGRATION_TEST 仅允许测试环境使用');
    const createUniqueIndex = useInMemoryTestSql ? 'CREATE UNIQUE INDEX IF NOT EXISTS' : 'CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS';
    await queryRunner.query(`CREATE TABLE IF NOT EXISTS "monthly_bill_generation_commands" (
      "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
      "period" character varying NOT NULL,
      "requestedBy" uuid NOT NULL,
      "idempotencyKey" character varying NOT NULL,
      "requestHash" character varying NOT NULL,
      "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
      CONSTRAINT "PK_monthly_bill_generation_commands" PRIMARY KEY ("id")
    )`);
    await queryRunner.query(`${createUniqueIndex} "IDX_monthly_bill_generation_command_idempotency" ON "monthly_bill_generation_commands" ("requestedBy", "idempotencyKey")`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS "monthly_bill_generation_commands"');
  }
}
