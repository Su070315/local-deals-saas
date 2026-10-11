import { MigrationInterface, QueryRunner } from 'typeorm';

export class WechatFactDrivenOnboarding1784337700000 implements MigrationInterface {
  name = 'WechatFactDrivenOnboarding1784337700000';
  transaction = false;

  async up(queryRunner: QueryRunner): Promise<void> {
    const useInMemoryTestSql = process.env.TYPEORM_MIGRATION_TEST === 'true';
    if (useInMemoryTestSql && process.env.NODE_ENV !== 'test') throw new Error('TYPEORM_MIGRATION_TEST 仅允许测试环境使用');
    const createIndex = useInMemoryTestSql ? 'CREATE INDEX IF NOT EXISTS' : 'CREATE INDEX CONCURRENTLY IF NOT EXISTS';
    await queryRunner.query(`CREATE TABLE IF NOT EXISTS "wechat_onboardings" (
      "id" uuid NOT NULL DEFAULT uuid_generate_v4(), "merchantId" uuid NOT NULL,
      "status" varchar NOT NULL DEFAULT 'ACTION_REQUIRED', "syncStatus" varchar NOT NULL DEFAULT 'UNKNOWN',
      "evidenceUpdatedAt" timestamptz, "lastSyncAt" timestamptz, "lastSyncError" text NOT NULL DEFAULT '',
      "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT "PK_wechat_onboardings" PRIMARY KEY ("id"), CONSTRAINT "UQ_wechat_onboardings_merchant" UNIQUE ("merchantId")
    )`);
    await queryRunner.query(`CREATE TABLE IF NOT EXISTS "wechat_onboarding_steps" (
      "id" uuid NOT NULL DEFAULT uuid_generate_v4(), "merchantId" uuid NOT NULL, "key" varchar(32) NOT NULL,
      "status" varchar NOT NULL DEFAULT 'ACTION_REQUIRED', "evidence" jsonb NOT NULL DEFAULT '{}'::jsonb,
      "evidenceUpdatedAt" timestamptz, "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT "PK_wechat_onboarding_steps" PRIMARY KEY ("id"), CONSTRAINT "UQ_wechat_onboarding_steps_merchant_key" UNIQUE ("merchantId", "key")
    )`);
    await queryRunner.query(`${createIndex} "IDX_wechat_onboarding_steps_merchant" ON "wechat_onboarding_steps" ("merchantId")`);
    await queryRunner.query(`CREATE TABLE IF NOT EXISTS "wechat_callback_events" (
      "id" uuid NOT NULL DEFAULT uuid_generate_v4(), "fingerprint" varchar(64) NOT NULL, "merchantId" uuid,
      "authorizerAppId" varchar(64), "eventType" varchar(64) NOT NULL, "payload" jsonb NOT NULL DEFAULT '{}'::jsonb,
      "status" varchar NOT NULL DEFAULT 'RECEIVED', "processedAt" timestamptz, "errorMessage" text NOT NULL DEFAULT '',
      "createdAt" timestamptz NOT NULL DEFAULT now(), CONSTRAINT "PK_wechat_callback_events" PRIMARY KEY ("id"),
      CONSTRAINT "UQ_wechat_callback_events_fingerprint" UNIQUE ("fingerprint")
    )`);
    await queryRunner.query(`${createIndex} "IDX_wechat_callback_events_merchant" ON "wechat_callback_events" ("merchantId")`);
    await queryRunner.query(`${createIndex} "IDX_wechat_callback_events_authorizer" ON "wechat_callback_events" ("authorizerAppId")`);
    await queryRunner.query(`CREATE TABLE IF NOT EXISTS "wechat_sync_tasks" (
      "id" uuid NOT NULL DEFAULT uuid_generate_v4(), "merchantId" uuid, "callbackEventId" uuid NOT NULL,
      "type" varchar(64) NOT NULL, "payload" jsonb NOT NULL DEFAULT '{}'::jsonb, "status" varchar NOT NULL DEFAULT 'PENDING',
      "attempts" integer NOT NULL DEFAULT 0, "availableAt" timestamptz NOT NULL DEFAULT now(), "startedAt" timestamptz,
      "finishedAt" timestamptz, "lastError" text NOT NULL DEFAULT '', "createdAt" timestamptz NOT NULL DEFAULT now(),
      "updatedAt" timestamptz NOT NULL DEFAULT now(), CONSTRAINT "PK_wechat_sync_tasks" PRIMARY KEY ("id"),
      CONSTRAINT "UQ_wechat_sync_tasks_event_type" UNIQUE ("callbackEventId", "type")
    )`);
    await queryRunner.query(`${createIndex} "IDX_wechat_sync_tasks_merchant" ON "wechat_sync_tasks" ("merchantId")`);
    await queryRunner.query(`${createIndex} "IDX_wechat_sync_tasks_pending" ON "wechat_sync_tasks" ("status", "availableAt")`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS "wechat_sync_tasks"');
    await queryRunner.query('DROP TABLE IF EXISTS "wechat_callback_events"');
    await queryRunner.query('DROP TABLE IF EXISTS "wechat_onboarding_steps"');
    await queryRunner.query('DROP TABLE IF EXISTS "wechat_onboardings"');
  }
}
