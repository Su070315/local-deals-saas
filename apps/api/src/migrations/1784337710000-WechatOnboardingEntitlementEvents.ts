import { MigrationInterface, QueryRunner } from 'typeorm';

export class WechatOnboardingEntitlementEvents1784337710000 implements MigrationInterface {
  name = 'WechatOnboardingEntitlementEvents1784337710000';
  transaction = false;

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TABLE IF NOT EXISTS "wechat_onboarding_entitlement_events" (
      "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
      "merchantId" uuid NOT NULL,
      "eventType" varchar(64) NOT NULL,
      "payload" jsonb NOT NULL DEFAULT '{}'::jsonb,
      "createdAt" timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT "PK_wechat_onboarding_entitlement_events" PRIMARY KEY ("id"),
      CONSTRAINT "UQ_wechat_onboarding_entitlement_merchant_event" UNIQUE ("merchantId", "eventType")
    )`);
    const useInMemoryTestSql = process.env.TYPEORM_MIGRATION_TEST === 'true';
    if (useInMemoryTestSql && process.env.NODE_ENV !== 'test') throw new Error('TYPEORM_MIGRATION_TEST 仅允许测试环境使用');
    const createIndex = useInMemoryTestSql ? 'CREATE INDEX IF NOT EXISTS' : 'CREATE INDEX CONCURRENTLY IF NOT EXISTS';
    await queryRunner.query(`${createIndex} "IDX_wechat_onboarding_entitlement_merchant" ON "wechat_onboarding_entitlement_events" ("merchantId")`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS "wechat_onboarding_entitlement_events"');
  }
}
