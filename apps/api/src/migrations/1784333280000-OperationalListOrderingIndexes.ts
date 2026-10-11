import { MigrationInterface, QueryRunner } from 'typeorm';

export class OperationalListOrderingIndexes1784333280000 implements MigrationInterface {
  name = 'OperationalListOrderingIndexes1784333280000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('CREATE INDEX IF NOT EXISTS "IDX_orders_merchant_created_id" ON "orders" ("merchantId", "createdAt" DESC, "id" DESC)');
    await queryRunner.query('CREATE INDEX IF NOT EXISTS "IDX_vouchers_merchant_created_id" ON "vouchers" ("merchantId", "createdAt" DESC, "id" DESC)');
    await queryRunner.query('CREATE INDEX IF NOT EXISTS "IDX_verifications_merchant_verified_id" ON "verifications" ("merchantId", "verifiedAt" DESC, "id" DESC)');
    await queryRunner.query('CREATE INDEX IF NOT EXISTS "IDX_verifications_staff_store_verified_id" ON "verifications" ("merchantId", "staffId", "storeId", "verifiedAt" DESC, "id" DESC)');
    await queryRunner.query('CREATE INDEX IF NOT EXISTS "IDX_support_tickets_merchant_created_id" ON "support_tickets" ("merchantId", "createdAt" DESC, "id" DESC)');
    await queryRunner.query('CREATE INDEX IF NOT EXISTS "IDX_audit_logs_merchant_created_id" ON "audit_logs" ("merchantId", "createdAt" DESC, "id" DESC)');
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX IF EXISTS "IDX_audit_logs_merchant_created_id"');
    await queryRunner.query('DROP INDEX IF EXISTS "IDX_support_tickets_merchant_created_id"');
    await queryRunner.query('DROP INDEX IF EXISTS "IDX_verifications_staff_store_verified_id"');
    await queryRunner.query('DROP INDEX IF EXISTS "IDX_verifications_merchant_verified_id"');
    await queryRunner.query('DROP INDEX IF EXISTS "IDX_vouchers_merchant_created_id"');
    await queryRunner.query('DROP INDEX IF EXISTS "IDX_orders_merchant_created_id"');
  }
}
