import { MigrationInterface, QueryRunner } from 'typeorm';

export class WechatMiniprogramReleases1784336140000 implements MigrationInterface {
  name = 'WechatMiniprogramReleases1784336140000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TABLE IF NOT EXISTS "wechat_miniprogram_releases" (
      "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
      "merchantId" uuid NOT NULL,
      "authorizerAppId" varchar(64) NOT NULL,
      "templateId" integer NOT NULL,
      "userVersion" varchar(64) NOT NULL,
      "userDesc" varchar(240) NOT NULL DEFAULT '',
      "extJson" jsonb NOT NULL DEFAULT '{}'::jsonb,
      "status" varchar NOT NULL DEFAULT 'DRAFT',
      "auditId" integer,
      "trialQrUrl" text NOT NULL DEFAULT '',
      "errorMessage" text NOT NULL DEFAULT '',
      "requestedBy" uuid NOT NULL,
      "createdAt" timestamptz NOT NULL DEFAULT now(),
      "updatedAt" timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT "PK_wechat_miniprogram_releases" PRIMARY KEY ("id")
    )`);
    await queryRunner.query('CREATE INDEX IF NOT EXISTS "IDX_wechat_miniprogram_releases_merchant" ON "wechat_miniprogram_releases" ("merchantId")');
    await queryRunner.query('CREATE INDEX IF NOT EXISTS "IDX_wechat_miniprogram_releases_authorizer" ON "wechat_miniprogram_releases" ("authorizerAppId")');
    await queryRunner.query('CREATE INDEX IF NOT EXISTS "IDX_wechat_miniprogram_releases_status" ON "wechat_miniprogram_releases" ("status")');

    await queryRunner.query(`CREATE TABLE IF NOT EXISTS "wechat_miniprogram_release_jobs" (
      "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
      "merchantId" uuid NOT NULL,
      "releaseId" uuid NOT NULL,
      "type" varchar NOT NULL,
      "status" varchar NOT NULL,
      "payload" jsonb NOT NULL DEFAULT '{}'::jsonb,
      "result" jsonb NOT NULL DEFAULT '{}'::jsonb,
      "errorMessage" text NOT NULL DEFAULT '',
      "requestedBy" uuid NOT NULL,
      "createdAt" timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT "PK_wechat_miniprogram_release_jobs" PRIMARY KEY ("id")
    )`);
    await queryRunner.query('CREATE INDEX IF NOT EXISTS "IDX_wechat_miniprogram_release_jobs_merchant" ON "wechat_miniprogram_release_jobs" ("merchantId")');
    await queryRunner.query('CREATE INDEX IF NOT EXISTS "IDX_wechat_miniprogram_release_jobs_release" ON "wechat_miniprogram_release_jobs" ("releaseId")');
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS "wechat_miniprogram_release_jobs"');
    await queryRunner.query('DROP TABLE IF EXISTS "wechat_miniprogram_releases"');
  }
}
