import { MigrationInterface, QueryRunner } from 'typeorm';

export class PaymentProfileProviderCredentials1784337650000 implements MigrationInterface {
  name = 'PaymentProfileProviderCredentials1784337650000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query("ALTER TABLE \"merchant_payment_profiles\" ADD COLUMN IF NOT EXISTS \"huifuSysId\" varchar(32) NOT NULL DEFAULT ''");
    await queryRunner.query("ALTER TABLE \"merchant_payment_profiles\" ADD COLUMN IF NOT EXISTS \"huifuProductId\" varchar(32) NOT NULL DEFAULT ''");
    await queryRunner.query("ALTER TABLE \"merchant_payment_profiles\" ADD COLUMN IF NOT EXISTS \"huifuPrivateKeyEnc\" text NOT NULL DEFAULT ''");
    await queryRunner.query("ALTER TABLE \"merchant_payment_profiles\" ADD COLUMN IF NOT EXISTS \"huifuMerchantPublicKey\" text NOT NULL DEFAULT ''");
    await queryRunner.query("ALTER TABLE \"merchant_payment_profiles\" ADD COLUMN IF NOT EXISTS \"huifuPublicKey\" text NOT NULL DEFAULT ''");
    await queryRunner.query("ALTER TABLE \"merchant_payment_profiles\" ADD COLUMN IF NOT EXISTS \"huifuFeeType\" varchar(2) NOT NULL DEFAULT ''");
    await queryRunner.query("ALTER TABLE \"merchant_payment_profiles\" ADD COLUMN IF NOT EXISTS \"tianqueMno\" varchar(64) NOT NULL DEFAULT ''");
    await queryRunner.query("ALTER TABLE \"merchant_payment_profiles\" ADD COLUMN IF NOT EXISTS \"tianqueOrgId\" varchar(64) NOT NULL DEFAULT ''");
    await queryRunner.query("ALTER TABLE \"merchant_payment_profiles\" ADD COLUMN IF NOT EXISTS \"tianquePrivateKeyEnc\" text NOT NULL DEFAULT ''");
    await queryRunner.query("ALTER TABLE \"merchant_payment_profiles\" ADD COLUMN IF NOT EXISTS \"tianquePublicKey\" text NOT NULL DEFAULT ''");
    await queryRunner.query("ALTER TABLE \"merchant_payment_profiles\" ADD COLUMN IF NOT EXISTS \"tianqueSignAlg\" varchar(8) NOT NULL DEFAULT 'sha256'");
    await queryRunner.query("ALTER TABLE \"merchant_payment_profiles\" ADD COLUMN IF NOT EXISTS \"wechatMchid\" varchar(64) NOT NULL DEFAULT ''");
    await queryRunner.query("ALTER TABLE \"merchant_payment_profiles\" ADD COLUMN IF NOT EXISTS \"wechatAppId\" varchar(32) NOT NULL DEFAULT ''");
    await queryRunner.query("ALTER TABLE \"merchant_payment_profiles\" ADD COLUMN IF NOT EXISTS \"wechatApiV3KeyEnc\" text NOT NULL DEFAULT ''");
    await queryRunner.query("ALTER TABLE \"merchant_payment_profiles\" ADD COLUMN IF NOT EXISTS \"wechatCertSerialNo\" varchar(64) NOT NULL DEFAULT ''");
    await queryRunner.query("ALTER TABLE \"merchant_payment_profiles\" ADD COLUMN IF NOT EXISTS \"wechatPrivateKeyEnc\" text NOT NULL DEFAULT ''");
    await queryRunner.query("ALTER TABLE \"merchant_payment_profiles\" ADD COLUMN IF NOT EXISTS \"wechatPublicKey\" text NOT NULL DEFAULT ''");
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE "merchant_payment_profiles" DROP COLUMN IF EXISTS "wechatPublicKey"');
    await queryRunner.query('ALTER TABLE "merchant_payment_profiles" DROP COLUMN IF EXISTS "wechatPrivateKeyEnc"');
    await queryRunner.query('ALTER TABLE "merchant_payment_profiles" DROP COLUMN IF EXISTS "wechatCertSerialNo"');
    await queryRunner.query('ALTER TABLE "merchant_payment_profiles" DROP COLUMN IF EXISTS "wechatApiV3KeyEnc"');
    await queryRunner.query('ALTER TABLE "merchant_payment_profiles" DROP COLUMN IF EXISTS "wechatAppId"');
    await queryRunner.query('ALTER TABLE "merchant_payment_profiles" DROP COLUMN IF EXISTS "wechatMchid"');
    await queryRunner.query('ALTER TABLE "merchant_payment_profiles" DROP COLUMN IF EXISTS "tianqueSignAlg"');
    await queryRunner.query('ALTER TABLE "merchant_payment_profiles" DROP COLUMN IF EXISTS "tianquePublicKey"');
    await queryRunner.query('ALTER TABLE "merchant_payment_profiles" DROP COLUMN IF EXISTS "tianquePrivateKeyEnc"');
    await queryRunner.query('ALTER TABLE "merchant_payment_profiles" DROP COLUMN IF EXISTS "tianqueOrgId"');
    await queryRunner.query('ALTER TABLE "merchant_payment_profiles" DROP COLUMN IF EXISTS "tianqueMno"');
    await queryRunner.query('ALTER TABLE "merchant_payment_profiles" DROP COLUMN IF EXISTS "huifuFeeType"');
    await queryRunner.query('ALTER TABLE "merchant_payment_profiles" DROP COLUMN IF EXISTS "huifuPublicKey"');
    await queryRunner.query('ALTER TABLE "merchant_payment_profiles" DROP COLUMN IF EXISTS "huifuMerchantPublicKey"');
    await queryRunner.query('ALTER TABLE "merchant_payment_profiles" DROP COLUMN IF EXISTS "huifuPrivateKeyEnc"');
    await queryRunner.query('ALTER TABLE "merchant_payment_profiles" DROP COLUMN IF EXISTS "huifuProductId"');
    await queryRunner.query('ALTER TABLE "merchant_payment_profiles" DROP COLUMN IF EXISTS "huifuSysId"');
  }
}
