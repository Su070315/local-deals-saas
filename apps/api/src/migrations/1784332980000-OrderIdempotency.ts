import { MigrationInterface, QueryRunner } from 'typeorm';

export class OrderIdempotency1784332980000 implements MigrationInterface {
  name = 'OrderIdempotency1784332980000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE "orders" ADD COLUMN "idempotencyKey" character varying');
    await queryRunner.query('CREATE UNIQUE INDEX "IDX_orders_customer_idempotency" ON "orders" ("customerId", "idempotencyKey")');
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX "public"."IDX_orders_customer_idempotency"');
    await queryRunner.query('ALTER TABLE "orders" DROP COLUMN "idempotencyKey"');
  }
}
