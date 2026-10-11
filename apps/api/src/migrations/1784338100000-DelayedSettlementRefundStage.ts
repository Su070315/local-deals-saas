import { MigrationInterface, QueryRunner } from 'typeorm';

/** 为确认后两阶段退款增加持久化阶段；expand-only，不触碰既有退款记录。 */
export class DelayedSettlementRefundStage1784338100000 implements MigrationInterface {
  name = 'DelayedSettlementRefundStage1784338100000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE "refunds" ADD COLUMN IF NOT EXISTS "paymentStage" character varying NOT NULL DEFAULT \'DIRECT\'');
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE "refunds" DROP COLUMN IF EXISTS "paymentStage"');
  }
}
