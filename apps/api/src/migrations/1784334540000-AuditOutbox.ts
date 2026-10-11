import { MigrationInterface, QueryRunner } from 'typeorm';

export class AuditOutbox1784334540000 implements MigrationInterface {
  name = 'AuditOutbox1784334540000';
  transaction = false;

  async up(queryRunner: QueryRunner): Promise<void> {
    const useInMemoryTestSql = process.env.TYPEORM_MIGRATION_TEST === 'true';
    if (useInMemoryTestSql && process.env.NODE_ENV !== 'test') throw new Error('TYPEORM_MIGRATION_TEST 仅允许测试环境使用');
    const createIndex = useInMemoryTestSql ? 'CREATE INDEX IF NOT EXISTS' : 'CREATE INDEX CONCURRENTLY IF NOT EXISTS';
    await queryRunner.query('CREATE TABLE IF NOT EXISTS "audit_outbox" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "outboxVersion" integer NOT NULL DEFAULT 1, "actorId" character varying NOT NULL, "merchantId" character varying, "action" character varying NOT NULL, "resourceType" character varying NOT NULL, "resourceId" character varying NOT NULL, "before" text, "after" text, "requestId" character varying NOT NULL DEFAULT \'\', "actorRole" character varying NOT NULL DEFAULT \'\', "ipAddress" character varying NOT NULL DEFAULT \'\', "userAgent" character varying NOT NULL DEFAULT \'\', "payloadHash" character varying(64) NOT NULL, "status" character varying NOT NULL DEFAULT \'PENDING\', "attemptCount" integer NOT NULL DEFAULT 0, "lastAttemptAt" TIMESTAMP WITH TIME ZONE, "signedAt" TIMESTAMP WITH TIME ZONE, "signedAuditLogId" uuid, "failureReason" character varying NOT NULL DEFAULT \'\', "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_audit_outbox" PRIMARY KEY ("id"))');
    await queryRunner.query(`${createIndex} "IDX_audit_outbox_status_created" ON "audit_outbox" ("status", "createdAt")`);
    await queryRunner.query(`${createIndex} "IDX_audit_outbox_status_attempt" ON "audit_outbox" ("status", "lastAttemptAt")`);
    await queryRunner.query(`${createIndex} "IDX_audit_outbox_actor" ON "audit_outbox" ("actorId")`);
    await queryRunner.query(`${createIndex} "IDX_audit_outbox_merchant" ON "audit_outbox" ("merchantId")`);
    await queryRunner.query(`${createIndex} "IDX_audit_outbox_request" ON "audit_outbox" ("requestId")`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS "audit_outbox"');
  }
}
