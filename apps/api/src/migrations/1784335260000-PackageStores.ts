import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Introduces a relational package-to-store mapping while keeping the legacy
 * packages.storeIds JSON column for a compatibility window. The composite
 * foreign keys make it impossible to attach a package to a store belonging to
 * another merchant, even if an application bug bypasses service validation.
 */
export class PackageStores1784335260000 implements MigrationInterface {
  name = 'PackageStores1784335260000';
  transaction = false;

  async up(queryRunner: QueryRunner): Promise<void> {
    const useInMemoryTestSql = process.env.TYPEORM_MIGRATION_TEST === 'true';
    if (useInMemoryTestSql && process.env.NODE_ENV !== 'test') throw new Error('TYPEORM_MIGRATION_TEST 仅允许测试环境使用');

    // Composite parent keys are required by the merchant-scoped foreign keys.
    if (!useInMemoryTestSql) {
      await queryRunner.query('CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "UQ_packages_id_merchant" ON "packages" ("id", "merchantId")');
      await queryRunner.query('CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "UQ_stores_id_merchant" ON "stores" ("id", "merchantId")');
    }
    // pg-mem currently cannot create a composite foreign key against a
    // composite unique index and reports a misleading type-mismatch error.
    // The in-memory path keeps simple existence FKs; PostgreSQL receives the
    // merchant-scoped composite constraints that provide the real invariant.
    const foreignKeys = useInMemoryTestSql
      ? 'CONSTRAINT "FK_package_stores_package" FOREIGN KEY ("packageId") REFERENCES "packages" ("id") ON DELETE CASCADE, CONSTRAINT "FK_package_stores_store" FOREIGN KEY ("storeId") REFERENCES "stores" ("id") ON DELETE CASCADE'
      : 'CONSTRAINT "FK_package_stores_package_merchant" FOREIGN KEY ("packageId", "merchantId") REFERENCES "packages" ("id", "merchantId") ON DELETE CASCADE, CONSTRAINT "FK_package_stores_store_merchant" FOREIGN KEY ("storeId", "merchantId") REFERENCES "stores" ("id", "merchantId") ON DELETE CASCADE';
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "package_stores" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "packageId" uuid NOT NULL,
        "storeId" uuid NOT NULL,
        "merchantId" uuid NOT NULL,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_package_stores" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_package_stores_package_store" UNIQUE ("packageId", "storeId"),
        ${foreignKeys}
      )
    `);
    if (!useInMemoryTestSql) {
      await queryRunner.query('CREATE INDEX CONCURRENTLY IF NOT EXISTS "IDX_package_stores_merchant_package" ON "package_stores" ("merchantId", "packageId")');
      await queryRunner.query('CREATE INDEX CONCURRENTLY IF NOT EXISTS "IDX_package_stores_merchant_store" ON "package_stores" ("merchantId", "storeId")');
    }

    // Backfill the compatibility column in application-sized batches. A bad
    // legacy reference aborts the migration instead of silently dropping a
    // store from a live package.
    const packages: Array<{ id: string; merchantId: string; storeIds: string }> = await queryRunner.query('SELECT "id", "merchantId", "storeIds" FROM "packages"');
    for (const deal of packages) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(deal.storeIds || '[]');
      } catch {
        throw new Error(`套餐 ${deal.id} 的 storeIds 不是有效 JSON，无法安全迁移`);
      }
      if (!Array.isArray(parsed) || parsed.some((storeId) => typeof storeId !== 'string' || !/^[0-9a-f-]{36}$/i.test(storeId))) {
        throw new Error(`套餐 ${deal.id} 的 storeIds 包含无效门店标识，无法安全迁移`);
      }
      for (const storeId of [...new Set(parsed)]) {
        await queryRunner.query(
          'INSERT INTO "package_stores" ("packageId", "storeId", "merchantId") VALUES ($1, $2, $3) ON CONFLICT ("packageId", "storeId") DO NOTHING',
          [deal.id, storeId, deal.merchantId],
        );
      }
    }
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    const useInMemoryTestSql = process.env.TYPEORM_MIGRATION_TEST === 'true';
    const dropIndex = useInMemoryTestSql ? 'DROP INDEX IF EXISTS' : 'DROP INDEX CONCURRENTLY IF EXISTS';
    await queryRunner.query('DROP TABLE IF EXISTS "package_stores"');
    await queryRunner.query(`${dropIndex} "UQ_stores_id_merchant"`);
    await queryRunner.query(`${dropIndex} "UQ_packages_id_merchant"`);
  }
}
