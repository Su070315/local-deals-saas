import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Immutable baseline for PostgreSQL deployments. Keep later schema changes in
 * new migrations; do not edit this snapshot after it has been released.
 */
export class InitialSchema1784332800000 implements MigrationInterface {
  name = 'InitialSchema1784332800000';

  async up(queryRunner: QueryRunner): Promise<void> {
    const statements = [
      'CREATE EXTENSION IF NOT EXISTS "uuid-ossp"',
      'CREATE TABLE IF NOT EXISTS "agencies" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "name" character varying NOT NULL, "active" boolean NOT NULL DEFAULT true, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "UQ_1ea16c73ecef4bab2f61c31c889" UNIQUE ("name"), CONSTRAINT "PK_8ab1f1f53f56c8255b0d7e68b28" PRIMARY KEY ("id"))',
      'CREATE TABLE IF NOT EXISTS "merchants" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "agencyId" character varying NOT NULL, "legalName" character varying NOT NULL, "brandName" character varying NOT NULL, "status" character varying NOT NULL DEFAULT \'ACTIVE\', "logoUrl" character varying NOT NULL DEFAULT \'\', "primaryColor" character varying NOT NULL DEFAULT \'#1677ff\', "servicePhone" character varying NOT NULL DEFAULT \'\', "contractNumber" character varying NOT NULL DEFAULT \'\', "contractEndsAt" date, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_4fd312ef25f8e05ad47bfe7ed25" PRIMARY KEY ("id"))',
      'CREATE INDEX IF NOT EXISTS "IDX_970ecf7b8fdf363a42130d5dbd" ON "merchants" ("agencyId")',
      'CREATE TABLE IF NOT EXISTS "merchant_registrations" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "merchantId" uuid NOT NULL, "status" character varying NOT NULL DEFAULT \'DRAFT\', "note" text NOT NULL DEFAULT \'\', "failureReason" text NOT NULL DEFAULT \'\', "updatedBy" uuid, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_ef99fdabcf215c6257daa08f2b5" PRIMARY KEY ("id"))',
      'CREATE UNIQUE INDEX IF NOT EXISTS "IDX_3a604e06f17a4307c2ccede665" ON "merchant_registrations" ("merchantId")',
      'CREATE TABLE IF NOT EXISTS "stores" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "merchantId" character varying NOT NULL, "name" character varying NOT NULL, "address" character varying NOT NULL, "phone" character varying NOT NULL DEFAULT \'\', "businessHours" character varying NOT NULL DEFAULT \'09:00-21:00\', "openForSale" boolean NOT NULL DEFAULT true, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_7aa6e7d71fa7acdd7ca43d7c9cb" PRIMARY KEY ("id"))',
      'CREATE INDEX IF NOT EXISTS "IDX_3b5114b6a41f09542b155e02c8" ON "stores" ("merchantId")',
      'CREATE TABLE IF NOT EXISTS "users" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "email" character varying NOT NULL, "name" character varying NOT NULL, "passwordHash" character varying NOT NULL, "role" character varying NOT NULL, "agencyId" uuid, "merchantId" uuid, "storeIds" text, "active" boolean NOT NULL DEFAULT true, "sessionVersion" integer NOT NULL DEFAULT \'0\', "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_a3ffb1c0c8416b9fc6f907b7433" PRIMARY KEY ("id"))',
      'CREATE UNIQUE INDEX IF NOT EXISTS "IDX_97672ac88f789774dd47f7c8be" ON "users" ("email")',
      'CREATE INDEX IF NOT EXISTS "IDX_184debc49e72b43579476cc6e7" ON "users" ("agencyId")',
      'CREATE INDEX IF NOT EXISTS "IDX_af94df2e060180b6043d5e4504" ON "users" ("merchantId")',
      'CREATE TABLE IF NOT EXISTS "auth_sessions" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "userId" uuid NOT NULL, "sessionVersion" integer NOT NULL, "ipAddress" character varying NOT NULL DEFAULT \'\', "userAgent" character varying NOT NULL DEFAULT \'\', "expiresAt" TIMESTAMP WITH TIME ZONE NOT NULL, "lastSeenAt" TIMESTAMP WITH TIME ZONE NOT NULL, "revokedAt" TIMESTAMP WITH TIME ZONE, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_641507381f32580e8479efc36cd" PRIMARY KEY ("id"))',
      'CREATE INDEX IF NOT EXISTS "IDX_925b24d7fc2f9324ce972aee02" ON "auth_sessions" ("userId")',
      'CREATE INDEX IF NOT EXISTS "IDX_7939a9f08c3bb6f5e84a93a1c4" ON "auth_sessions" ("userId", "revokedAt")',
      'CREATE TABLE IF NOT EXISTS "login_throttles" ("throttleKey" character varying(64) NOT NULL, "failureCount" integer NOT NULL DEFAULT \'0\', "resetAt" TIMESTAMP WITH TIME ZONE NOT NULL, "blockedUntil" TIMESTAMP WITH TIME ZONE, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_7715a7b4016640d1e6bd69dfaa2" PRIMARY KEY ("throttleKey"))',
      'CREATE TABLE IF NOT EXISTS "commission_rate_versions" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "merchantId" character varying NOT NULL, "rate" numeric(7,4) NOT NULL, "effectiveFrom" TIMESTAMP WITH TIME ZONE NOT NULL, "note" character varying NOT NULL DEFAULT \'\', "createdBy" character varying NOT NULL, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_1c8ab7958f893b219b002e9bcfa" PRIMARY KEY ("id"))',
      'CREATE INDEX IF NOT EXISTS "IDX_7b8d4378f980ecfef0138ce0c8" ON "commission_rate_versions" ("merchantId")',
      'CREATE UNIQUE INDEX IF NOT EXISTS "IDX_026ad24df75370bd39bb3bc801" ON "commission_rate_versions" ("merchantId", "effectiveFrom")',
      'CREATE TABLE IF NOT EXISTS "packages" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "merchantId" character varying NOT NULL, "title" character varying NOT NULL, "description" text NOT NULL DEFAULT \'\', "priceFen" integer NOT NULL, "saleLimit" integer NOT NULL DEFAULT \'0\', "soldCount" integer NOT NULL DEFAULT \'0\', "perCustomerLimit" integer NOT NULL DEFAULT \'0\', "storeIds" text NOT NULL, "validFrom" date NOT NULL, "validTo" date NOT NULL, "status" character varying NOT NULL DEFAULT \'DRAFT\', "version" integer NOT NULL DEFAULT \'1\', "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_020801f620e21f943ead9311c98" PRIMARY KEY ("id"))',
      'CREATE INDEX IF NOT EXISTS "IDX_e191e16dfdccb7b0a52e89e746" ON "packages" ("merchantId")',
      'CREATE TABLE IF NOT EXISTS "orders" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "orderNo" character varying NOT NULL, "merchantId" character varying NOT NULL, "packageId" character varying NOT NULL, "storeId" character varying NOT NULL, "customerId" character varying NOT NULL, "quantity" integer NOT NULL, "amountFen" integer NOT NULL, "unitPriceFen" integer NOT NULL, "packageTitleSnapshot" character varying NOT NULL, "packageVersionSnapshot" integer NOT NULL, "validFromSnapshot" date NOT NULL, "validToSnapshot" date NOT NULL, "commissionRateSnapshot" numeric(7,4) NOT NULL, "status" character varying NOT NULL, "paymentExpiresAt" TIMESTAMP WITH TIME ZONE NOT NULL, "paymentReference" character varying, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_710e2d4957aa5878dfe94e4ac2f" PRIMARY KEY ("id"))',
      'CREATE UNIQUE INDEX IF NOT EXISTS "IDX_9e116d4adfd60229dc662a81b0" ON "orders" ("orderNo")',
      'CREATE INDEX IF NOT EXISTS "IDX_c9e4efcabb250e585daa4c1962" ON "orders" ("merchantId")',
      'CREATE INDEX IF NOT EXISTS "IDX_cfa5a4ae37d5e487d626ccc99b" ON "orders" ("packageId")',
      'CREATE TABLE IF NOT EXISTS "vouchers" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "code" character varying NOT NULL, "orderId" character varying NOT NULL, "merchantId" character varying NOT NULL, "packageId" character varying NOT NULL, "storeId" character varying NOT NULL, "customerId" character varying NOT NULL, "faceValueFen" integer NOT NULL, "commissionRateSnapshot" numeric(7,4) NOT NULL, "status" character varying NOT NULL, "validFrom" date NOT NULL, "validTo" date NOT NULL, "verificationId" uuid, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_ed1b7dd909a696560763acdbc04" PRIMARY KEY ("id"))',
      'CREATE UNIQUE INDEX IF NOT EXISTS "IDX_efc30b2b9169e05e0e1e19d6dd" ON "vouchers" ("code")',
      'CREATE INDEX IF NOT EXISTS "IDX_d24e61c11bed3675b843d9a865" ON "vouchers" ("orderId")',
      'CREATE INDEX IF NOT EXISTS "IDX_08997427bdfa1a77812febc6e9" ON "vouchers" ("merchantId")',
      'CREATE INDEX IF NOT EXISTS "IDX_92d77a082c3f620bdc8e1fbc73" ON "vouchers" ("validTo")',
      'CREATE TABLE IF NOT EXISTS "verifications" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "voucherId" character varying NOT NULL, "merchantId" character varying NOT NULL, "storeId" character varying NOT NULL, "staffId" character varying NOT NULL, "idempotencyKey" character varying NOT NULL, "amountFen" integer NOT NULL, "verifiedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_2127ad1b143cf012280390b01d1" PRIMARY KEY ("id"))',
      'CREATE INDEX IF NOT EXISTS "IDX_15f912b577814796a16d246826" ON "verifications" ("voucherId")',
      'CREATE UNIQUE INDEX IF NOT EXISTS "IDX_0e76fa9a04b10255c205d1fa4b" ON "verifications" ("voucherId", "idempotencyKey")',
      'CREATE TABLE IF NOT EXISTS "refunds" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "voucherId" character varying NOT NULL, "orderId" character varying NOT NULL, "merchantId" character varying NOT NULL, "amountFen" integer NOT NULL, "reason" character varying NOT NULL DEFAULT \'CUSTOMER_SELF_SERVICE\', "status" character varying NOT NULL DEFAULT \'SUCCEEDED\', "paymentReference" character varying, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_5106efb01eeda7e49a78b869738" PRIMARY KEY ("id"))',
      'CREATE UNIQUE INDEX IF NOT EXISTS "IDX_4b2a0182461856dbaea34e4f8c" ON "refunds" ("voucherId")',
      'CREATE TABLE IF NOT EXISTS "settlement_ledger_entries" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "merchantId" character varying NOT NULL, "voucherId" character varying NOT NULL, "verificationId" character varying NOT NULL, "verifiedAmountFen" integer NOT NULL, "serviceFeeFen" integer NOT NULL, "rateSnapshot" numeric(7,4) NOT NULL, "entryType" character varying NOT NULL, "occurredAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_6553b37563c65629d088326299d" PRIMARY KEY ("id"))',
      'CREATE INDEX IF NOT EXISTS "IDX_cfd743370253a98bb5d670fd66" ON "settlement_ledger_entries" ("merchantId")',
      'CREATE UNIQUE INDEX IF NOT EXISTS "IDX_b7d370035160f5baaabc8abdb6" ON "settlement_ledger_entries" ("voucherId", "entryType")',
      'CREATE TABLE IF NOT EXISTS "monthly_bills" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "merchantId" character varying NOT NULL, "period" character varying NOT NULL, "verifiedAmountFen" integer NOT NULL, "serviceFeeFen" integer NOT NULL, "status" character varying NOT NULL DEFAULT \'DRAFT\', "invoiceNumber" character varying, "disputeEndsAt" TIMESTAMP WITH TIME ZONE NOT NULL, "dueAt" TIMESTAMP WITH TIME ZONE NOT NULL, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_958fff1d129ea2f46aedf55205f" PRIMARY KEY ("id"))',
      'CREATE INDEX IF NOT EXISTS "IDX_00562fcafce92d93d6872e4377" ON "monthly_bills" ("merchantId")',
      'CREATE UNIQUE INDEX IF NOT EXISTS "IDX_19cfb59595b7f316e1b35c722d" ON "monthly_bills" ("merchantId", "period")',
      'CREATE TABLE IF NOT EXISTS "support_tickets" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "merchantId" character varying NOT NULL, "customerId" character varying NOT NULL, "voucherId" uuid, "contactPhone" character varying NOT NULL DEFAULT \'\', "content" text NOT NULL, "status" character varying NOT NULL DEFAULT \'OPEN\', "resolutionNote" text NOT NULL DEFAULT \'\', "resolvedBy" uuid, "resolvedAt" TIMESTAMP WITH TIME ZONE, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_942e8d8f5df86100471d2324643" PRIMARY KEY ("id"))',
      'CREATE INDEX IF NOT EXISTS "IDX_70dd521605447126b7d4de75c4" ON "support_tickets" ("merchantId")',
      'CREATE INDEX IF NOT EXISTS "IDX_ee952666931bd353d113acdd5d" ON "support_tickets" ("customerId")',
      'CREATE INDEX IF NOT EXISTS "IDX_7fbf83b13149092ce190dec84e" ON "support_tickets" ("merchantId", "status")',
      'CREATE TABLE IF NOT EXISTS "audit_logs" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "actorId" character varying NOT NULL, "merchantId" character varying NOT NULL, "action" character varying NOT NULL, "resourceType" character varying NOT NULL, "resourceId" character varying NOT NULL, "before" text, "after" text, "requestId" character varying NOT NULL DEFAULT \'\', "actorRole" character varying NOT NULL DEFAULT \'\', "ipAddress" character varying NOT NULL DEFAULT \'\', "userAgent" character varying NOT NULL DEFAULT \'\', "createdAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_1bb179d048bbc581caa3b013439" PRIMARY KEY ("id"))',
      'CREATE INDEX IF NOT EXISTS "IDX_2dc33f7f3c22e2e7badafca1d1" ON "audit_logs" ("actorId")',
      'CREATE INDEX IF NOT EXISTS "IDX_cf9393a92feee6af80e2aa689f" ON "audit_logs" ("merchantId")',
      'CREATE INDEX IF NOT EXISTS "IDX_a3efbfd507134492f264a19b9c" ON "audit_logs" ("requestId")',
    ];
    for (const statement of statements) await queryRunner.query(statement);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    for (const table of [
      'audit_logs', 'support_tickets', 'monthly_bills', 'settlement_ledger_entries', 'refunds', 'verifications',
      'vouchers', 'orders', 'packages', 'commission_rate_versions', 'login_throttles', 'auth_sessions', 'users',
      'stores', 'merchant_registrations', 'merchants', 'agencies',
    ]) await queryRunner.query(`DROP TABLE IF EXISTS "${table}"`);
  }
}
