import { MigrationInterface, QueryRunner } from 'typeorm';

export class CustomerProfiles1784336180000 implements MigrationInterface {
  name = 'CustomerProfiles1784336180000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TABLE IF NOT EXISTS "customer_profiles" (
      "openidHash" varchar(64) NOT NULL,
      "phoneCiphertext" text NOT NULL DEFAULT '',
      "phoneMasked" varchar(32) NOT NULL DEFAULT '',
      "phoneAuthorizedAt" timestamptz,
      "createdAt" timestamptz NOT NULL DEFAULT now(),
      "updatedAt" timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT "PK_customer_profiles" PRIMARY KEY ("openidHash")
    )`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS "customer_profiles"');
  }
}
