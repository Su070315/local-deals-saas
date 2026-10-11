import { MigrationInterface, QueryRunner } from 'typeorm';

export class OpenExceptionRefundUniqueness1784333040000 implements MigrationInterface {
  name = 'OpenExceptionRefundUniqueness1784333040000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE UNIQUE INDEX "IDX_open_exception_refund_per_voucher" ON "support_tickets" ("merchantId", "voucherId") WHERE "status" = 'OPEN' AND "source" = 'MERCHANT' AND "type" = 'EXCEPTION_REFUND'`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX "public"."IDX_open_exception_refund_per_voucher"');
  }
}
