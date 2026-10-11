import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Separates offline agency cooperation authorization from transaction fees.
 * Existing agencies deliberately start with zero publishing quota so a live
 * operator must review and authorize them instead of silently granting access.
 */
export class AgencyCooperationAuthorization1784335860000 implements MigrationInterface {
  name = 'AgencyCooperationAuthorization1784335860000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query("ALTER TABLE \"agencies\" ADD COLUMN IF NOT EXISTS \"cooperationPlan\" character varying NOT NULL DEFAULT 'PER_PUBLISH'");
    await queryRunner.query('ALTER TABLE "agencies" ADD COLUMN IF NOT EXISTS "publicationQuotaRemaining" integer NOT NULL DEFAULT 0');
    await queryRunner.query('ALTER TABLE "agencies" ADD COLUMN IF NOT EXISTS "cooperationStartsAt" date');
    await queryRunner.query('ALTER TABLE "agencies" ADD COLUMN IF NOT EXISTS "cooperationEndsAt" date');
    await queryRunner.query('ALTER TABLE "agencies" ADD COLUMN IF NOT EXISTS "cooperationReference" character varying NOT NULL DEFAULT \'\'');
    await queryRunner.query("ALTER TABLE \"merchant_registrations\" ADD COLUMN IF NOT EXISTS \"publicationEntitlementStatus\" character varying NOT NULL DEFAULT 'NONE'");
    await queryRunner.query('ALTER TABLE "merchant_registrations" ADD COLUMN IF NOT EXISTS "publicationEntitlementPlan" character varying');
    await queryRunner.query('ALTER TABLE "merchant_registrations" ADD COLUMN IF NOT EXISTS "publicationEntitlementReservedAt" TIMESTAMP WITH TIME ZONE');
    await queryRunner.query('ALTER TABLE "merchant_registrations" ADD COLUMN IF NOT EXISTS "publicationEntitlementConsumedAt" TIMESTAMP WITH TIME ZONE');
    await queryRunner.query('ALTER TABLE "agencies" ADD CONSTRAINT "CHK_agencies_publication_quota" CHECK ("publicationQuotaRemaining" >= 0)');
  }

  async down(): Promise<void> {
    throw new Error('代理合作授权迁移不支持自动回退；请先撤销或迁移已产生的合作授权记录');
  }
}
