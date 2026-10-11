import { MigrationInterface, QueryRunner } from 'typeorm';

export class ExportJobs1784333760000 implements MigrationInterface {
  name = 'ExportJobs1784333760000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('CREATE TABLE IF NOT EXISTS "export_jobs" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "requestedBy" uuid NOT NULL, "requestedRole" character varying NOT NULL, "kind" character varying NOT NULL, "merchantScope" text NOT NULL, "requestedMerchantId" uuid, "fromDay" date NOT NULL, "toDay" date NOT NULL, "status" character varying NOT NULL DEFAULT \'PENDING\', "recordCount" integer NOT NULL DEFAULT 0, "encryptedArtifact" text, "artifactSha256" character varying NOT NULL DEFAULT \'\', "downloadCount" integer NOT NULL DEFAULT 0, "lastDownloadedAt" TIMESTAMP WITH TIME ZONE, "attemptCount" integer NOT NULL DEFAULT 0, "lastAttemptAt" TIMESTAMP WITH TIME ZONE, "failureReason" character varying NOT NULL DEFAULT \'\', "revokedAt" TIMESTAMP WITH TIME ZONE, "expiresAt" TIMESTAMP WITH TIME ZONE NOT NULL, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_export_jobs" PRIMARY KEY ("id"))');
    await queryRunner.query('CREATE INDEX IF NOT EXISTS "IDX_export_jobs_requested_created" ON "export_jobs" ("requestedBy", "createdAt")');
    await queryRunner.query('CREATE INDEX IF NOT EXISTS "IDX_export_jobs_status_expires" ON "export_jobs" ("status", "expiresAt")');
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS "export_jobs"');
  }
}
