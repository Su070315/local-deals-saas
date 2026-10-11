import { MigrationInterface, QueryRunner } from 'typeorm';

export class SupportTicketIdempotency1784334840000 implements MigrationInterface {
  name = 'SupportTicketIdempotency1784334840000';
  transaction = false;

  async up(queryRunner: QueryRunner): Promise<void> {
    const useInMemoryTestSql = process.env.TYPEORM_MIGRATION_TEST === 'true';
    if (useInMemoryTestSql && process.env.NODE_ENV !== 'test') throw new Error('TYPEORM_MIGRATION_TEST 仅允许测试环境使用');
    const createIndex = useInMemoryTestSql ? 'CREATE UNIQUE INDEX IF NOT EXISTS' : 'CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS';
    await queryRunner.query('ALTER TABLE "support_tickets" ADD COLUMN IF NOT EXISTS "idempotencyKey" character varying');
    await queryRunner.query('ALTER TABLE "support_tickets" ADD COLUMN IF NOT EXISTS "requestHash" character varying');
    await queryRunner.query(`${createIndex} "IDX_support_tickets_customer_idempotency" ON "support_tickets" ("customerId", "idempotencyKey") WHERE "customerId" IS NOT NULL AND "idempotencyKey" IS NOT NULL`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX CONCURRENTLY IF EXISTS "IDX_support_tickets_customer_idempotency"');
    await queryRunner.query('ALTER TABLE "support_tickets" DROP COLUMN IF EXISTS "requestHash"');
    await queryRunner.query('ALTER TABLE "support_tickets" DROP COLUMN IF EXISTS "idempotencyKey"');
  }
}
