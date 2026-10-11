import { MigrationInterface, QueryRunner } from 'typeorm';

/** Stores only the timestamp of recent password re-verification, never the password itself. */
export class AuthSessionStepUp1784334360000 implements MigrationInterface {
  name = 'AuthSessionStepUp1784334360000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE "auth_sessions" ADD COLUMN IF NOT EXISTS "stepUpVerifiedAt" TIMESTAMP WITH TIME ZONE');
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE "auth_sessions" DROP COLUMN IF EXISTS "stepUpVerifiedAt"');
  }
}
