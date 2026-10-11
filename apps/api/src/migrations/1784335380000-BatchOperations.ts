import { MigrationInterface, QueryRunner } from 'typeorm';

/** Durable, idempotent batch commands with per-item outcomes. */
export class BatchOperations1784335380000 implements MigrationInterface {
  name = 'BatchOperations1784335380000';
  transaction = false;

  async up(queryRunner: QueryRunner): Promise<void> {
    const inMemory = process.env.TYPEORM_MIGRATION_TEST === 'true';
    if (inMemory && process.env.NODE_ENV !== 'test') throw new Error('TYPEORM_MIGRATION_TEST 仅允许测试环境使用');
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "batch_operations" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "kind" character varying NOT NULL,
        "merchantId" uuid NOT NULL,
        "requestedBy" uuid NOT NULL,
        "status" character varying NOT NULL DEFAULT 'PENDING',
        "payload" text NOT NULL DEFAULT '{}',
        "totalCount" integer NOT NULL,
        "succeededCount" integer NOT NULL DEFAULT 0,
        "failedCount" integer NOT NULL DEFAULT 0,
        "results" text,
        "error" text NOT NULL DEFAULT '',
        "startedAt" TIMESTAMP WITH TIME ZONE,
        "completedAt" TIMESTAMP WITH TIME ZONE,
        "idempotencyKey" character varying NOT NULL,
        "requestHash" character varying NOT NULL,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_batch_operations" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_batch_operations_request" UNIQUE ("requestedBy", "idempotencyKey"),
        CONSTRAINT "FK_batch_operations_merchant" FOREIGN KEY ("merchantId") REFERENCES "merchants" ("id") ON DELETE CASCADE
      )
    `);
    if (!inMemory) {
      await queryRunner.query('CREATE INDEX CONCURRENTLY IF NOT EXISTS "IDX_batch_operations_status_created" ON "batch_operations" ("status", "createdAt")');
      await queryRunner.query('CREATE INDEX CONCURRENTLY IF NOT EXISTS "IDX_batch_operations_merchant" ON "batch_operations" ("merchantId")');
    }
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS "batch_operations"');
  }
}
