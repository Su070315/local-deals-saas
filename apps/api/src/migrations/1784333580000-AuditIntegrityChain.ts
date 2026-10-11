import { MigrationInterface, QueryRunner } from 'typeorm';

const GENESIS_HASH = '0000000000000000000000000000000000000000000000000000000000000000';

export class AuditIntegrityChain1784333580000 implements MigrationInterface {
  name = 'AuditIntegrityChain1784333580000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE "audit_logs" ADD COLUMN IF NOT EXISTS "chainVersion" integer NOT NULL DEFAULT 0');
    await queryRunner.query('ALTER TABLE "audit_logs" ADD COLUMN IF NOT EXISTS "chainSequence" bigint');
    await queryRunner.query('ALTER TABLE "audit_logs" ADD COLUMN IF NOT EXISTS "previousHash" character varying NOT NULL DEFAULT \'\'');
    await queryRunner.query('ALTER TABLE "audit_logs" ADD COLUMN IF NOT EXISTS "recordHash" character varying NOT NULL DEFAULT \'\'');
    await queryRunner.query('CREATE UNIQUE INDEX IF NOT EXISTS "IDX_audit_logs_chain_sequence" ON "audit_logs" ("chainSequence") WHERE "chainSequence" IS NOT NULL');
    await queryRunner.query('CREATE TABLE IF NOT EXISTS "audit_chain_state" ("id" character varying(32) NOT NULL, "lastSequence" bigint NOT NULL DEFAULT 0, "lastHash" character varying(64) NOT NULL, "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_audit_chain_state" PRIMARY KEY ("id"))');
    await queryRunner.query(`INSERT INTO "audit_chain_state" ("id", "lastSequence", "lastHash") VALUES ('global', 0, '${GENESIS_HASH}') ON CONFLICT ("id") DO NOTHING`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX IF EXISTS "IDX_audit_logs_chain_sequence"');
    await queryRunner.query('DROP TABLE IF EXISTS "audit_chain_state"');
    await queryRunner.query('ALTER TABLE "audit_logs" DROP COLUMN IF EXISTS "recordHash"');
    await queryRunner.query('ALTER TABLE "audit_logs" DROP COLUMN IF EXISTS "previousHash"');
    await queryRunner.query('ALTER TABLE "audit_logs" DROP COLUMN IF EXISTS "chainSequence"');
    await queryRunner.query('ALTER TABLE "audit_logs" DROP COLUMN IF EXISTS "chainVersion"');
  }
}
