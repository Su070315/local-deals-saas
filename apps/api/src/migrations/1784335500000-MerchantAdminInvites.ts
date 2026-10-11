import { MigrationInterface, QueryRunner } from 'typeorm';

/** One-time merchant administrator invitations with no plaintext credential storage. */
export class MerchantAdminInvites1784335500000 implements MigrationInterface {
  name = 'MerchantAdminInvites1784335500000';
  transaction = false;

  async up(queryRunner: QueryRunner): Promise<void> {
    const inMemory = process.env.TYPEORM_MIGRATION_TEST === 'true';
    if (inMemory && process.env.NODE_ENV !== 'test') throw new Error('TYPEORM_MIGRATION_TEST 仅允许测试环境使用');
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "merchant_admin_invites" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "merchantId" uuid NOT NULL,
        "agencyId" uuid NOT NULL,
        "requestedBy" uuid NOT NULL,
        "email" character varying NOT NULL,
        "name" character varying NOT NULL,
        "tokenHash" character varying NOT NULL,
        "tokenCiphertext" text NOT NULL,
        "idempotencyKey" character varying NOT NULL,
        "requestHash" character varying NOT NULL,
        "expiresAt" TIMESTAMP WITH TIME ZONE NOT NULL,
        "consumedAt" TIMESTAMP WITH TIME ZONE,
        "consumedUserId" uuid,
        "revokedAt" TIMESTAMP WITH TIME ZONE,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_merchant_admin_invites" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_merchant_admin_invites_request" UNIQUE ("requestedBy", "idempotencyKey"),
        CONSTRAINT "UQ_merchant_admin_invites_token" UNIQUE ("tokenHash"),
        CONSTRAINT "FK_merchant_admin_invites_merchant" FOREIGN KEY ("merchantId") REFERENCES "merchants" ("id") ON DELETE CASCADE,
        CONSTRAINT "FK_merchant_admin_invites_agency" FOREIGN KEY ("agencyId") REFERENCES "agencies" ("id") ON DELETE CASCADE
      )
    `);
    if (!inMemory) {
      await queryRunner.query('CREATE INDEX CONCURRENTLY IF NOT EXISTS "IDX_merchant_admin_invites_merchant_created" ON "merchant_admin_invites" ("merchantId", "createdAt")');
      await queryRunner.query('CREATE INDEX CONCURRENTLY IF NOT EXISTS "IDX_merchant_admin_invites_expires" ON "merchant_admin_invites" ("expiresAt")');
    }
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS "merchant_admin_invites"');
  }
}
