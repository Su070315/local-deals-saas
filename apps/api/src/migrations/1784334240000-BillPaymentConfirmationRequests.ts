import { MigrationInterface, QueryRunner } from 'typeorm';

/** Adds independent review for manual confirmation of merchant service-fee receipts. */
export class BillPaymentConfirmationRequests1784334240000 implements MigrationInterface {
  name = 'BillPaymentConfirmationRequests1784334240000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TABLE IF NOT EXISTS "bill_payment_confirmation_requests" (
      "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
      "billId" uuid NOT NULL,
      "merchantId" uuid NOT NULL,
      "requestedBy" uuid NOT NULL,
      "paymentReference" character varying NOT NULL,
      "note" text NOT NULL,
      "status" character varying NOT NULL,
      "idempotencyKey" character varying NOT NULL,
      "requestHash" character varying NOT NULL,
      "reviewedBy" uuid,
      "reviewNote" text NOT NULL DEFAULT '',
      "reviewedAt" TIMESTAMP WITH TIME ZONE,
      "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
      "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
      CONSTRAINT "PK_bill_payment_confirmation_requests" PRIMARY KEY ("id")
    )`);
    await queryRunner.query('CREATE UNIQUE INDEX IF NOT EXISTS "IDX_bill_payment_confirmation_idempotency" ON "bill_payment_confirmation_requests" ("billId", "requestedBy", "idempotencyKey")');
    await queryRunner.query('CREATE UNIQUE INDEX IF NOT EXISTS "IDX_bill_payment_confirmation_pending" ON "bill_payment_confirmation_requests" ("billId") WHERE "status" = \'PENDING_REVIEW\'');
    await queryRunner.query('CREATE UNIQUE INDEX IF NOT EXISTS "IDX_bill_payment_confirmation_reference_active" ON "bill_payment_confirmation_requests" ("paymentReference") WHERE "status" IN (\'PENDING_REVIEW\', \'APPROVED\')');
    await queryRunner.query('CREATE INDEX IF NOT EXISTS "IDX_bill_payment_confirmation_status_created" ON "bill_payment_confirmation_requests" ("status", "createdAt")');
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS "bill_payment_confirmation_requests"');
  }
}
