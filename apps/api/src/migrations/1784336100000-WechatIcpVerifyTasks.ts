import { MigrationInterface, QueryRunner } from 'typeorm';

export class WechatIcpVerifyTasks1784336100000 implements MigrationInterface {
  name = 'WechatIcpVerifyTasks1784336100000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE "wechat_authorizers" ADD COLUMN IF NOT EXISTS "accessTokenCiphertext" text NOT NULL DEFAULT \'\'');
    await queryRunner.query('ALTER TABLE "wechat_authorizers" ADD COLUMN IF NOT EXISTS "accessTokenExpiresAt" timestamptz');
    await queryRunner.query(`CREATE TABLE IF NOT EXISTS "wechat_icp_verify_tasks" (
      "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
      "merchantId" uuid NOT NULL,
      "requestedBy" uuid NOT NULL,
      "taskId" varchar(128) NOT NULL,
      "alongWithAuth" boolean NOT NULL DEFAULT false,
      "verifyUrl" text NOT NULL DEFAULT '',
      "status" varchar NOT NULL DEFAULT 'PENDING',
      "isFinish" boolean NOT NULL DEFAULT false,
      "faceStatus" integer,
      "alongWithAuthResult" integer,
      "lastMessage" text NOT NULL DEFAULT '',
      "lastCheckedAt" timestamptz,
      "createdAt" timestamptz NOT NULL DEFAULT now(),
      "updatedAt" timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT "PK_wechat_icp_verify_tasks" PRIMARY KEY ("id"),
      CONSTRAINT "UQ_wechat_icp_verify_tasks_task" UNIQUE ("taskId")
    )`);
    await queryRunner.query('CREATE INDEX IF NOT EXISTS "IDX_wechat_icp_verify_tasks_merchant" ON "wechat_icp_verify_tasks" ("merchantId")');
    await queryRunner.query('CREATE INDEX IF NOT EXISTS "IDX_wechat_icp_verify_tasks_requested_by" ON "wechat_icp_verify_tasks" ("requestedBy")');
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS "wechat_icp_verify_tasks"');
    await queryRunner.query('ALTER TABLE "wechat_authorizers" DROP COLUMN IF EXISTS "accessTokenExpiresAt"');
    await queryRunner.query('ALTER TABLE "wechat_authorizers" DROP COLUMN IF EXISTS "accessTokenCiphertext"');
  }
}
