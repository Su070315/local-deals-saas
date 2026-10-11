import { MigrationInterface, QueryRunner } from 'typeorm';

/** Global operational controls. Sales resume deliberately requires two operators. */
export class PlatformRuntimeControls1784335620000 implements MigrationInterface {
  name = 'PlatformRuntimeControls1784335620000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "platform_runtime_controls" (
        "key" character varying(64) NOT NULL,
        "status" character varying(32) NOT NULL DEFAULT 'ENABLED',
        "reason" character varying(500) NOT NULL DEFAULT '',
        "updatedBy" uuid,
        "resumeRequestedBy" uuid,
        "version" integer NOT NULL DEFAULT 1,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_platform_runtime_controls" PRIMARY KEY ("key"),
        CONSTRAINT "CHK_platform_runtime_controls_version" CHECK ("version" >= 0)
      )
    `);
    await queryRunner.query(`INSERT INTO "platform_runtime_controls" ("key", "status", "version") VALUES ('SALES', 'ENABLED', 1) ON CONFLICT ("key") DO NOTHING`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS "platform_runtime_controls"');
  }
}
