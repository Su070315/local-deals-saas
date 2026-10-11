import { MigrationInterface, QueryRunner } from 'typeorm';

export class MerchantOperations1784335920000 implements MigrationInterface {
  name = 'MerchantOperations1784335920000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TABLE IF NOT EXISTS "inventory_batches" (
      "id" uuid NOT NULL DEFAULT uuid_generate_v4(), "merchantId" uuid NOT NULL, "packageId" uuid, "storeId" uuid,
      "skuCode" varchar(64) NOT NULL, "productName" varchar(120) NOT NULL, "quantity" integer NOT NULL DEFAULT 0,
      "reservedQuantity" integer NOT NULL DEFAULT 0, "unitCostFen" integer NOT NULL DEFAULT 0, "productionDate" date,
      "expiresAt" timestamptz, "status" varchar(24) NOT NULL DEFAULT 'NORMAL', "note" varchar(500) NOT NULL DEFAULT '',
      "version" integer NOT NULL DEFAULT 1, "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT "PK_inventory_batches" PRIMARY KEY ("id"), CONSTRAINT "FK_inventory_batches_merchant" FOREIGN KEY ("merchantId") REFERENCES "merchants"("id") ON DELETE RESTRICT
    )`);
    await queryRunner.query('CREATE INDEX IF NOT EXISTS "IDX_inventory_batches_merchantId" ON "inventory_batches" ("merchantId")');
    await queryRunner.query('CREATE INDEX IF NOT EXISTS "IDX_inventory_batches_merchant_status" ON "inventory_batches" ("merchantId", "status")');
    await queryRunner.query(`CREATE TABLE IF NOT EXISTS "inventory_documents" (
      "id" uuid NOT NULL DEFAULT uuid_generate_v4(), "merchantId" uuid NOT NULL, "documentNo" varchar(40) NOT NULL,
      "type" varchar(24) NOT NULL, "storeId" uuid, "sourceStoreId" uuid, "targetStoreId" uuid,
      "counterparty" varchar(120) NOT NULL DEFAULT '', "items" text NOT NULL, "totalQuantity" integer NOT NULL DEFAULT 0,
      "totalAmountFen" integer NOT NULL DEFAULT 0, "occurredAt" timestamptz NOT NULL, "status" varchar(24) NOT NULL DEFAULT 'DRAFT',
      "note" varchar(500) NOT NULL DEFAULT '', "createdBy" uuid NOT NULL, "confirmedBy" uuid, "confirmedAt" timestamptz,
      "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT "PK_inventory_documents" PRIMARY KEY ("id"),
      CONSTRAINT "FK_inventory_documents_merchant" FOREIGN KEY ("merchantId") REFERENCES "merchants"("id") ON DELETE RESTRICT,
      CONSTRAINT "UQ_inventory_documents_merchant_number" UNIQUE ("merchantId", "documentNo")
    )`);
    await queryRunner.query('CREATE INDEX IF NOT EXISTS "IDX_inventory_documents_merchant_type_status" ON "inventory_documents" ("merchantId", "type", "status")');
    await queryRunner.query(`CREATE TABLE IF NOT EXISTS "member_profiles" (
      "id" uuid NOT NULL DEFAULT uuid_generate_v4(), "merchantId" uuid NOT NULL, "externalCustomerId" varchar(100) NOT NULL,
      "name" varchar(80) NOT NULL, "phoneMasked" varchar(32) NOT NULL DEFAULT '', "level" varchar(40) NOT NULL DEFAULT '普通会员',
      "tags" text, "balanceFen" integer NOT NULL DEFAULT 0, "points" integer NOT NULL DEFAULT 0, "orderCount" integer NOT NULL DEFAULT 0,
      "totalSpendFen" integer NOT NULL DEFAULT 0, "status" varchar(24) NOT NULL DEFAULT 'ACTIVE', "lastActiveAt" timestamptz,
      "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT "PK_member_profiles" PRIMARY KEY ("id"), CONSTRAINT "FK_member_profiles_merchant" FOREIGN KEY ("merchantId") REFERENCES "merchants"("id") ON DELETE RESTRICT
    )`);
    await queryRunner.query('CREATE INDEX IF NOT EXISTS "IDX_member_profiles_merchantId" ON "member_profiles" ("merchantId")');
    await queryRunner.query('CREATE UNIQUE INDEX IF NOT EXISTS "UQ_member_profiles_merchant_external" ON "member_profiles" ("merchantId", "externalCustomerId")');
    await queryRunner.query(`CREATE TABLE IF NOT EXISTS "marketing_campaigns" (
      "id" uuid NOT NULL DEFAULT uuid_generate_v4(), "merchantId" uuid NOT NULL, "name" varchar(100) NOT NULL,
      "type" varchar(40) NOT NULL, "scope" varchar(40) NOT NULL DEFAULT 'ALL_PRODUCTS', "rules" text,
      "startsAt" timestamptz, "endsAt" timestamptz, "status" varchar(24) NOT NULL DEFAULT 'DRAFT', "redemptions" integer NOT NULL DEFAULT 0,
      "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT "PK_marketing_campaigns" PRIMARY KEY ("id"), CONSTRAINT "FK_marketing_campaigns_merchant" FOREIGN KEY ("merchantId") REFERENCES "merchants"("id") ON DELETE RESTRICT
    )`);
    await queryRunner.query('CREATE INDEX IF NOT EXISTS "IDX_marketing_campaigns_merchantId" ON "marketing_campaigns" ("merchantId")');
    await queryRunner.query('CREATE INDEX IF NOT EXISTS "IDX_marketing_campaigns_merchant_status" ON "marketing_campaigns" ("merchantId", "status")');
    await queryRunner.query(`CREATE TABLE IF NOT EXISTS "distribution_promoters" (
      "id" uuid NOT NULL DEFAULT uuid_generate_v4(), "merchantId" uuid NOT NULL, "name" varchar(80) NOT NULL,
      "phoneMasked" varchar(32) NOT NULL DEFAULT '', "commissionRate" numeric(7,4) NOT NULL DEFAULT 0,
      "salesFen" integer NOT NULL DEFAULT 0, "commissionFen" integer NOT NULL DEFAULT 0, "status" varchar(24) NOT NULL DEFAULT 'PENDING',
      "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT "PK_distribution_promoters" PRIMARY KEY ("id"), CONSTRAINT "FK_distribution_promoters_merchant" FOREIGN KEY ("merchantId") REFERENCES "merchants"("id") ON DELETE RESTRICT
    )`);
    await queryRunner.query('CREATE INDEX IF NOT EXISTS "IDX_distribution_promoters_merchantId" ON "distribution_promoters" ("merchantId")');
    await queryRunner.query('CREATE INDEX IF NOT EXISTS "IDX_distribution_promoters_merchant_status" ON "distribution_promoters" ("merchantId", "status")');
    await queryRunner.query(`CREATE TABLE IF NOT EXISTS "merchant_operational_ledger" (
      "id" uuid NOT NULL DEFAULT uuid_generate_v4(), "merchantId" uuid NOT NULL, "category" varchar(40) NOT NULL,
      "referenceNo" varchar(48) NOT NULL, "subjectName" varchar(100) NOT NULL, "amountFen" integer NOT NULL,
      "status" varchar(24) NOT NULL DEFAULT 'PENDING', "occurredAt" timestamptz NOT NULL, "note" varchar(500) NOT NULL DEFAULT '',
      "metadata" text, "createdBy" uuid NOT NULL, "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT "PK_merchant_operational_ledger" PRIMARY KEY ("id"),
      CONSTRAINT "FK_merchant_operational_ledger_merchant" FOREIGN KEY ("merchantId") REFERENCES "merchants"("id") ON DELETE RESTRICT,
      CONSTRAINT "UQ_merchant_operational_ledger_reference" UNIQUE ("merchantId", "referenceNo")
    )`);
    await queryRunner.query('CREATE INDEX IF NOT EXISTS "IDX_merchant_operational_ledger_scope" ON "merchant_operational_ledger" ("merchantId", "category", "status")');
    await queryRunner.query(`CREATE TABLE IF NOT EXISTS "merchant_business_settings" (
      "id" uuid NOT NULL DEFAULT uuid_generate_v4(), "merchantId" uuid NOT NULL, "type" varchar(40) NOT NULL,
      "name" varchar(100) NOT NULL, "description" varchar(300) NOT NULL DEFAULT '', "config" text,
      "status" varchar(24) NOT NULL DEFAULT 'ACTIVE', "sortOrder" integer NOT NULL DEFAULT 0,
      "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT "PK_merchant_business_settings" PRIMARY KEY ("id"), CONSTRAINT "FK_merchant_business_settings_merchant" FOREIGN KEY ("merchantId") REFERENCES "merchants"("id") ON DELETE RESTRICT
    )`);
    await queryRunner.query('CREATE INDEX IF NOT EXISTS "IDX_merchant_business_settings_merchantId" ON "merchant_business_settings" ("merchantId")');
    await queryRunner.query('CREATE INDEX IF NOT EXISTS "IDX_merchant_business_settings_scope" ON "merchant_business_settings" ("merchantId", "type", "status")');
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS "merchant_business_settings"');
    await queryRunner.query('DROP TABLE IF EXISTS "merchant_operational_ledger"');
    await queryRunner.query('DROP TABLE IF EXISTS "distribution_promoters"');
    await queryRunner.query('DROP TABLE IF EXISTS "marketing_campaigns"');
    await queryRunner.query('DROP TABLE IF EXISTS "member_profiles"');
    await queryRunner.query('DROP TABLE IF EXISTS "inventory_documents"');
    await queryRunner.query('DROP TABLE IF EXISTS "inventory_batches"');
  }
}
