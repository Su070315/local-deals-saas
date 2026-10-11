import { MigrationInterface, QueryRunner } from 'typeorm';

/** Positive refund reversal entries kept outside the positive-only settlement ledger. */
export class SettlementLedgerReversals1784338200000 implements MigrationInterface {
  name = 'SettlementLedgerReversals1784338200000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TABLE IF NOT EXISTS "settlement_ledger_reversals" (
      "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
      "merchantId" uuid NOT NULL,
      "voucherId" uuid NOT NULL,
      "verificationId" uuid NOT NULL,
      "refundId" uuid NOT NULL,
      "reversalAmountFen" bigint NOT NULL,
      "reversalServiceFeeFen" bigint NOT NULL,
      "rateSnapshot" numeric(7,4) NOT NULL,
      "reason" character varying NOT NULL DEFAULT 'REFUND',
      "occurredAt" TIMESTAMP NOT NULL DEFAULT now(),
      CONSTRAINT "PK_settlement_ledger_reversals" PRIMARY KEY ("id"),
      CONSTRAINT "UQ_settlement_ledger_reversals_refund" UNIQUE ("refundId"),
      CONSTRAINT "CHK_settlement_ledger_reversals_amounts" CHECK ("reversalAmountFen" > 0 AND "reversalServiceFeeFen" >= 0 AND "reversalServiceFeeFen" <= "reversalAmountFen")
    )`);
    await queryRunner.query('CREATE INDEX IF NOT EXISTS "IDX_reversal_merchant_occurred" ON "settlement_ledger_reversals" ("merchantId", "occurredAt")');
    await queryRunner.query('CREATE INDEX IF NOT EXISTS "IDX_reversal_voucher" ON "settlement_ledger_reversals" ("voucherId")');
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS "settlement_ledger_reversals"');
  }
}
