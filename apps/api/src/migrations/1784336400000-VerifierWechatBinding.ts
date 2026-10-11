import { MigrationInterface, QueryRunner } from 'typeorm';

/** users 增加微信开放平台绑定字段：核销员扫码绑定微信（openid）后可用微信扫顾客动态码核销。
 * wechat_openid 唯一索引使用部分索引（仅非空行），与实体 @Index({ unique: true, where: '"wechatOpenid" IS NOT NULL' }) 保持一致。 */
export class VerifierWechatBinding1784336400000 implements MigrationInterface {
  name = 'VerifierWechatBinding1784336400000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "wechatOpenid" varchar(64) NULL`);
    await queryRunner.query(`ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "wechatBindToken" varchar(128) NULL`);
    await queryRunner.query(`ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "wechatBindTokenExpiresAt" timestamptz NULL`);
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_users_wechatOpenid_unique" ON "users" ("wechatOpenid") WHERE "wechatOpenid" IS NOT NULL`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_users_wechatBindToken" ON "users" ("wechatBindToken")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_users_wechatBindToken"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_users_wechatOpenid_unique"`);
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN IF EXISTS "wechatBindTokenExpiresAt"`);
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN IF EXISTS "wechatBindToken"`);
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN IF EXISTS "wechatOpenid"`);
  }
}
