import { MigrationInterface, QueryRunner } from 'typeorm';

/** 2026-08-10 商家体验增强：门店头像/简介加列 + 顾客预约单表（预约真实闭环） */
export class MerchantExpansion1784337000000 implements MigrationInterface {
  name = 'MerchantExpansion1784337000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE "stores" ADD COLUMN IF NOT EXISTS "logoUrl" character varying(500)');
    await queryRunner.query('ALTER TABLE "stores" ADD COLUMN IF NOT EXISTS "description" text DEFAULT \'\'');
    await queryRunner.query(`CREATE TABLE IF NOT EXISTS "reservations" (
      "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
      "merchantId" uuid NOT NULL,
      "customerId" character varying(100) NOT NULL DEFAULT '',
      "customerName" character varying(80) NOT NULL DEFAULT '',
      "customerPhone" character varying(40) NOT NULL DEFAULT '',
      "storeId" character varying(64) NOT NULL DEFAULT '',
      "storeName" character varying(100) NOT NULL DEFAULT '',
      "date" character varying(20) NOT NULL,
      "timeSlot" character varying(20) NOT NULL,
      "peopleCount" integer NOT NULL DEFAULT 1,
      "remark" text NOT NULL DEFAULT '',
      "status" character varying(20) NOT NULL DEFAULT 'PENDING',
      "handledAt" timestamptz,
      "handledNote" text NOT NULL DEFAULT '',
      "createdAt" timestamptz NOT NULL DEFAULT now(),
      "updatedAt" timestamptz NOT NULL DEFAULT now()
    )`);
    await queryRunner.query('CREATE INDEX IF NOT EXISTS "IDX_reservations_merchant" ON "reservations" ("merchantId")');
    await queryRunner.query('CREATE INDEX IF NOT EXISTS "IDX_reservations_customer" ON "reservations" ("customerId")');
    await queryRunner.query('CREATE UNIQUE INDEX IF NOT EXISTS "UQ_reservations_id_merchant" ON "reservations" ("id", "merchantId")');
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS "reservations"');
    await queryRunner.query('ALTER TABLE "stores" DROP COLUMN IF EXISTS "description"');
    await queryRunner.query('ALTER TABLE "stores" DROP COLUMN IF EXISTS "logoUrl"');
  }
}
