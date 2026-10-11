import { MigrationInterface, QueryRunner } from 'typeorm';

export class GlobalAuditScope1784333220000 implements MigrationInterface {
  name = 'GlobalAuditScope1784333220000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE "audit_logs" ALTER COLUMN "merchantId" DROP NOT NULL');
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DELETE FROM "audit_logs" WHERE "merchantId" IS NULL');
    await queryRunner.query('ALTER TABLE "audit_logs" ALTER COLUMN "merchantId" SET NOT NULL');
  }
}
