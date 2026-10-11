import { MigrationInterface, QueryRunner } from 'typeorm';

export class MerchantStatusCommandIdempotency1784334900000 implements MigrationInterface {
  name = 'MerchantStatusCommandIdempotency1784334900000';
  transaction = false;

  async up(queryRunner: QueryRunner): Promise<void> {
    const useInMemoryTestSql = process.env.TYPEORM_MIGRATION_TEST === 'true';
    if (useInMemoryTestSql && process.env.NODE_ENV !== 'test') throw new Error('TYPEORM_MIGRATION_TEST 仅允许测试环境使用');
    const createIndex = useInMemoryTestSql ? 'CREATE INDEX IF NOT EXISTS' : 'CREATE INDEX CONCURRENTLY IF NOT EXISTS';
    const createUniqueIndex = useInMemoryTestSql ? 'CREATE UNIQUE INDEX IF NOT EXISTS' : 'CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS';
    await queryRunner.query(`CREATE TABLE IF NOT EXISTS "merchant_status_change_commands" (
      "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
      "merchantId" uuid NOT NULL,
      "requestedBy" uuid NOT NULL,
      "expectedStatus" character varying NOT NULL,
      "targetStatus" character varying NOT NULL,
      "idempotencyKey" character varying NOT NULL,
      "requestHash" character varying NOT NULL,
      "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
      CONSTRAINT "PK_merchant_status_change_commands" PRIMARY KEY ("id")
    )`);
    await queryRunner.query(`${createIndex} "IDX_merchant_status_change_command_merchant" ON "merchant_status_change_commands" ("merchantId")`);
    await queryRunner.query(`${createUniqueIndex} "IDX_merchant_status_change_command_idempotency" ON "merchant_status_change_commands" ("merchantId", "requestedBy", "idempotencyKey")`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS "merchant_status_change_commands"');
  }
}
