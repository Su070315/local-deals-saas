import { MigrationInterface, QueryRunner } from 'typeorm';

export class ReservationIdempotency1784337600000 implements MigrationInterface {
  name = 'ReservationIdempotency1784337600000';
  transaction = false;

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE "reservations" ADD COLUMN IF NOT EXISTS "idempotencyKey" varchar(128)');
    await queryRunner.query('ALTER TABLE "reservations" ADD COLUMN IF NOT EXISTS "requestHash" varchar(64)');
    const useInMemoryTestSql = process.env.TYPEORM_MIGRATION_TEST === 'true';
    if (useInMemoryTestSql && process.env.NODE_ENV !== 'test') throw new Error('TYPEORM_MIGRATION_TEST 仅允许测试环境使用');
    // pg-mem-test-only: the embedded migration runner cannot parse CONCURRENTLY.
    const createIndex = useInMemoryTestSql ? 'CREATE UNIQUE INDEX IF NOT EXISTS' : 'CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS';
    await queryRunner.query(`${createIndex} "IDX_reservations_customer_idempotency" ON "reservations" ("merchantId", "customerId", "idempotencyKey")`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX CONCURRENTLY IF EXISTS "IDX_reservations_customer_idempotency"');
    await queryRunner.query('ALTER TABLE "reservations" DROP COLUMN IF EXISTS "requestHash"');
    await queryRunner.query('ALTER TABLE "reservations" DROP COLUMN IF EXISTS "idempotencyKey"');
  }
}
