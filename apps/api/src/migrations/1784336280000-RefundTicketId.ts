import { MigrationInterface, QueryRunner } from 'typeorm';

/** refunds 增加 ticketId：售后异常退款/停业补偿关联工单，保证资金流可追溯审批来源。 */
export class RefundTicketId1784336280000 implements MigrationInterface {
  name = 'RefundTicketId1784336280000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "refunds" ADD COLUMN IF NOT EXISTS "ticketId" uuid NULL`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_refunds_ticketId" ON "refunds" ("ticketId")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_refunds_ticketId"`);
    await queryRunner.query(`ALTER TABLE "refunds" DROP COLUMN IF EXISTS "ticketId"`);
  }
}
