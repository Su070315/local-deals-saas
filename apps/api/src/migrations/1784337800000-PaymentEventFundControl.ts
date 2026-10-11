import { MigrationInterface, QueryRunner } from 'typeorm';

/** Expand-only facts from Huifu/WeChat fund-control notifications. */
export class PaymentEventFundControl1784337800000 implements MigrationInterface {
  name = 'PaymentEventFundControl1784337800000';
  transaction = false;

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE "payment_events" ADD COLUMN IF NOT EXISTS "huifuFundControlStatus" varchar(16)');
    await queryRunner.query('ALTER TABLE "payment_events" ADD COLUMN IF NOT EXISTS "huifuFundFrozenAt" timestamptz');
    await queryRunner.query('ALTER TABLE "payment_events" ADD COLUMN IF NOT EXISTS "huifuFundUnfrozenAt" timestamptz');
    await queryRunner.query('ALTER TABLE "payment_events" ADD COLUMN IF NOT EXISTS "huifuFundUnfrozenAmountFen" bigint');
    const useInMemoryTestSql = process.env.TYPEORM_MIGRATION_TEST === 'true';
    if (useInMemoryTestSql && process.env.NODE_ENV !== 'test') throw new Error('TYPEORM_MIGRATION_TEST 仅允许测试环境使用');
    const createIndex = useInMemoryTestSql ? 'CREATE INDEX IF NOT EXISTS' : 'CREATE INDEX CONCURRENTLY IF NOT EXISTS';
    await queryRunner.query(`${createIndex} "IDX_payment_events_huifu_fund_control" ON "payment_events" ("huifuFundControlStatus", "occurredAt")`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX CONCURRENTLY IF EXISTS "IDX_payment_events_huifu_fund_control"');
    await queryRunner.query('ALTER TABLE "payment_events" DROP COLUMN IF EXISTS "huifuFundUnfrozenAmountFen"');
    await queryRunner.query('ALTER TABLE "payment_events" DROP COLUMN IF EXISTS "huifuFundUnfrozenAt"');
    await queryRunner.query('ALTER TABLE "payment_events" DROP COLUMN IF EXISTS "huifuFundFrozenAt"');
    await queryRunner.query('ALTER TABLE "payment_events" DROP COLUMN IF EXISTS "huifuFundControlStatus"');
  }
}
