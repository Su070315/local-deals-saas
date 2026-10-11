import { MigrationInterface, QueryRunner } from 'typeorm';

/** Historical migration retained for already-upgraded databases. */
export class MerchantLegalSubjectUnique1784333880000 implements MigrationInterface {
  name = 'MerchantLegalSubjectUnique1784333880000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('CREATE UNIQUE INDEX IF NOT EXISTS "IDX_merchants_legal_name_unique" ON "merchants" ("legalName")');
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX IF EXISTS "IDX_merchants_legal_name_unique"');
  }
}
