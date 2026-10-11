import { MigrationInterface, QueryRunner } from 'typeorm';

export class WechatPlatform1784335980000 implements MigrationInterface {
  name = 'WechatPlatform1784335980000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TABLE IF NOT EXISTS "wechat_component_state" (
      "id" varchar(32) NOT NULL, "verifyTicketCiphertext" text NOT NULL, "ticketUpdatedAt" timestamptz,
      "accessTokenCiphertext" text NOT NULL DEFAULT '', "accessTokenExpiresAt" timestamptz,
      "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT "PK_wechat_component_state" PRIMARY KEY ("id")
    )`);
    await queryRunner.query(`CREATE TABLE IF NOT EXISTS "wechat_authorization_attempts" (
      "id" uuid NOT NULL DEFAULT uuid_generate_v4(), "merchantId" uuid NOT NULL, "requestedBy" uuid NOT NULL,
      "stateHash" varchar(64) NOT NULL, "expiresAt" timestamptz NOT NULL, "consumedAt" timestamptz,
      "createdAt" timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT "PK_wechat_authorization_attempts" PRIMARY KEY ("id"),
      CONSTRAINT "UQ_wechat_authorization_attempts_state" UNIQUE ("stateHash")
    )`);
    await queryRunner.query('CREATE INDEX IF NOT EXISTS "IDX_wechat_authorization_attempts_merchant" ON "wechat_authorization_attempts" ("merchantId")');
    await queryRunner.query(`CREATE TABLE IF NOT EXISTS "wechat_authorizers" (
      "id" uuid NOT NULL DEFAULT uuid_generate_v4(), "merchantId" uuid NOT NULL, "authorizerAppId" varchar(64) NOT NULL,
      "refreshTokenCiphertext" text NOT NULL, "permissionIds" jsonb NOT NULL DEFAULT '[]'::jsonb,
      "status" varchar NOT NULL DEFAULT 'AUTHORIZED', "authorizedAt" timestamptz NOT NULL, "revokedAt" timestamptz,
      "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT "PK_wechat_authorizers" PRIMARY KEY ("id"),
      CONSTRAINT "UQ_wechat_authorizers_merchant" UNIQUE ("merchantId"),
      CONSTRAINT "UQ_wechat_authorizers_appid" UNIQUE ("authorizerAppId")
    )`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS "wechat_authorizers"');
    await queryRunner.query('DROP TABLE IF EXISTS "wechat_authorization_attempts"');
    await queryRunner.query('DROP TABLE IF EXISTS "wechat_component_state"');
  }
}
