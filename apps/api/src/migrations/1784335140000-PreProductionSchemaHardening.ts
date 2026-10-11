import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * One-time schema hardening before the first production database is created.
 * The pilot schema used varchar references and 32-bit money columns. Because
 * no production deployment exists yet, this migration deliberately performs
 * the blocking conversions now; it must never be introduced into a live
 * rolling-release window later.
 */
export class PreProductionSchemaHardening1784335140000 implements MigrationInterface {
  name = 'PreProductionSchemaHardening1784335140000';

  async up(queryRunner: QueryRunner): Promise<void> {
    const useInMemoryTestSql = process.env.TYPEORM_MIGRATION_TEST === 'true';
    if (useInMemoryTestSql && process.env.NODE_ENV !== 'test') throw new Error('TYPEORM_MIGRATION_TEST 仅允许测试环境使用');
    if (useInMemoryTestSql) {
      await queryRunner.query('SELECT 1');
      return;
    }

    const uuidColumns: Array<[string, string]> = [
      ['merchants', 'agencyId'],
      ['stores', 'merchantId'],
      ['commission_rate_versions', 'merchantId'],
      ['packages', 'merchantId'],
      ['orders', 'merchantId'],
      ['orders', 'packageId'],
      ['orders', 'storeId'],
      ['vouchers', 'orderId'],
      ['vouchers', 'merchantId'],
      ['vouchers', 'packageId'],
      ['vouchers', 'storeId'],
      ['verifications', 'voucherId'],
      ['verifications', 'merchantId'],
      ['verifications', 'storeId'],
      ['verifications', 'staffId'],
      ['refunds', 'voucherId'],
      ['refunds', 'orderId'],
      ['refunds', 'merchantId'],
      ['settlement_ledger_entries', 'merchantId'],
      ['settlement_ledger_entries', 'voucherId'],
      ['settlement_ledger_entries', 'verificationId'],
      ['monthly_bills', 'merchantId'],
      ['support_tickets', 'merchantId'],
    ];
    for (const [table, column] of uuidColumns) {
      await queryRunner.query(`ALTER TABLE "${table}" ALTER COLUMN "${column}" TYPE uuid USING "${column}"::uuid`);
    }

    const moneyColumns: Array<[string, string]> = [
      ['packages', 'priceFen'],
      ['orders', 'amountFen'],
      ['orders', 'unitPriceFen'],
      ['payment_outbox', 'amountFen'],
      ['payment_events', 'amountFen'],
      ['vouchers', 'faceValueFen'],
      ['verifications', 'amountFen'],
      ['refunds', 'amountFen'],
      ['settlement_ledger_entries', 'verifiedAmountFen'],
      ['settlement_ledger_entries', 'serviceFeeFen'],
      ['monthly_bills', 'verifiedAmountFen'],
      ['monthly_bills', 'serviceFeeFen'],
    ];
    for (const [table, column] of moneyColumns) {
      await queryRunner.query(`ALTER TABLE "${table}" ALTER COLUMN "${column}" TYPE bigint USING "${column}"::bigint`);
    }

    const constraints: Array<[string, string, string]> = [
      ['merchants', 'FK_merchants_agency', 'FOREIGN KEY ("agencyId") REFERENCES "agencies"("id")'],
      ['stores', 'FK_stores_merchant', 'FOREIGN KEY ("merchantId") REFERENCES "merchants"("id")'],
      ['users', 'FK_users_agency', 'FOREIGN KEY ("agencyId") REFERENCES "agencies"("id")'],
      ['users', 'FK_users_merchant', 'FOREIGN KEY ("merchantId") REFERENCES "merchants"("id")'],
      ['merchant_registrations', 'FK_registrations_merchant', 'FOREIGN KEY ("merchantId") REFERENCES "merchants"("id")'],
      ['merchant_template_configs', 'FK_template_merchant', 'FOREIGN KEY ("merchantId") REFERENCES "merchants"("id")'],
      ['merchant_template_configs', 'FK_template_package', 'FOREIGN KEY ("featuredPackageId") REFERENCES "packages"("id")'],
      ['commission_rate_versions', 'FK_rates_merchant', 'FOREIGN KEY ("merchantId") REFERENCES "merchants"("id")'],
      ['packages', 'FK_packages_merchant', 'FOREIGN KEY ("merchantId") REFERENCES "merchants"("id")'],
      ['orders', 'FK_orders_merchant', 'FOREIGN KEY ("merchantId") REFERENCES "merchants"("id")'],
      ['orders', 'FK_orders_package', 'FOREIGN KEY ("packageId") REFERENCES "packages"("id")'],
      ['orders', 'FK_orders_store', 'FOREIGN KEY ("storeId") REFERENCES "stores"("id")'],
      ['payment_outbox', 'FK_payment_outbox_order', 'FOREIGN KEY ("orderId") REFERENCES "orders"("id")'],
      ['payment_outbox', 'FK_payment_outbox_merchant', 'FOREIGN KEY ("merchantId") REFERENCES "merchants"("id")'],
      ['payment_events', 'FK_payment_events_order', 'FOREIGN KEY ("orderId") REFERENCES "orders"("id")'],
      ['payment_events', 'FK_payment_events_merchant', 'FOREIGN KEY ("merchantId") REFERENCES "merchants"("id")'],
      ['vouchers', 'FK_vouchers_order', 'FOREIGN KEY ("orderId") REFERENCES "orders"("id")'],
      ['vouchers', 'FK_vouchers_merchant', 'FOREIGN KEY ("merchantId") REFERENCES "merchants"("id")'],
      ['vouchers', 'FK_vouchers_package', 'FOREIGN KEY ("packageId") REFERENCES "packages"("id")'],
      ['vouchers', 'FK_vouchers_store', 'FOREIGN KEY ("storeId") REFERENCES "stores"("id")'],
      ['vouchers', 'FK_vouchers_verification', 'FOREIGN KEY ("verificationId") REFERENCES "verifications"("id")'],
      ['verifications', 'FK_verifications_voucher', 'FOREIGN KEY ("voucherId") REFERENCES "vouchers"("id")'],
      ['verifications', 'FK_verifications_merchant', 'FOREIGN KEY ("merchantId") REFERENCES "merchants"("id")'],
      ['verifications', 'FK_verifications_store', 'FOREIGN KEY ("storeId") REFERENCES "stores"("id")'],
      ['verifications', 'FK_verifications_staff', 'FOREIGN KEY ("staffId") REFERENCES "users"("id")'],
      ['refunds', 'FK_refunds_voucher', 'FOREIGN KEY ("voucherId") REFERENCES "vouchers"("id")'],
      ['refunds', 'FK_refunds_order', 'FOREIGN KEY ("orderId") REFERENCES "orders"("id")'],
      ['refunds', 'FK_refunds_merchant', 'FOREIGN KEY ("merchantId") REFERENCES "merchants"("id")'],
      ['settlement_ledger_entries', 'FK_ledger_merchant', 'FOREIGN KEY ("merchantId") REFERENCES "merchants"("id")'],
      ['settlement_ledger_entries', 'FK_ledger_voucher', 'FOREIGN KEY ("voucherId") REFERENCES "vouchers"("id")'],
      ['settlement_ledger_entries', 'FK_ledger_verification', 'FOREIGN KEY ("verificationId") REFERENCES "verifications"("id")'],
      ['monthly_bills', 'FK_bills_merchant', 'FOREIGN KEY ("merchantId") REFERENCES "merchants"("id")'],
      ['support_tickets', 'FK_support_merchant', 'FOREIGN KEY ("merchantId") REFERENCES "merchants"("id")'],
      ['support_tickets', 'FK_support_voucher', 'FOREIGN KEY ("voucherId") REFERENCES "vouchers"("id")'],
      ['packages', 'CHK_packages_amounts', 'CHECK ("priceFen" > 0 AND "saleLimit" >= 0 AND "soldCount" >= 0 AND "perCustomerLimit" >= 0 AND ("saleLimit" = 0 OR "soldCount" <= "saleLimit"))'],
      ['packages', 'CHK_packages_dates', 'CHECK ("validFrom" <= "validTo")'],
      ['orders', 'CHK_orders_amounts', 'CHECK ("quantity" > 0 AND "unitPriceFen" > 0 AND "amountFen" = "unitPriceFen" * "quantity")'],
      ['payment_outbox', 'CHK_payment_outbox_amount', 'CHECK ("amountFen" > 0 AND "attemptCount" >= 0)'],
      ['payment_events', 'CHK_payment_events_amount', 'CHECK ("amountFen" > 0)'],
      ['vouchers', 'CHK_vouchers_amount_dates', 'CHECK ("faceValueFen" > 0 AND "validFrom" <= "validTo")'],
      ['verifications', 'CHK_verifications_amount', 'CHECK ("amountFen" > 0)'],
      ['refunds', 'CHK_refunds_amount_attempts', 'CHECK ("amountFen" > 0 AND "attemptCount" >= 0)'],
      ['settlement_ledger_entries', 'CHK_ledger_amounts', 'CHECK ("verifiedAmountFen" > 0 AND "serviceFeeFen" >= 0 AND "serviceFeeFen" <= "verifiedAmountFen")'],
      ['monthly_bills', 'CHK_bills_amounts', 'CHECK ("verifiedAmountFen" >= 0 AND "serviceFeeFen" >= 0 AND "serviceFeeFen" <= "verifiedAmountFen")'],
      ['stores', 'CHK_stores_coordinates', 'CHECK (("latitude" IS NULL OR "latitude" BETWEEN -90 AND 90) AND ("longitude" IS NULL OR "longitude" BETWEEN -180 AND 180))'],
      ['commission_rate_versions', 'CHK_rates_range', 'CHECK ("rate" >= 0 AND "rate" <= 1)'],
    ];
    for (const [table, name, definition] of constraints) {
      await queryRunner.query(`ALTER TABLE "${table}" ADD CONSTRAINT "${name}" ${definition}`);
    }
  }

  async down(): Promise<void> {
    throw new Error('预生产结构加固迁移不可回退；如尚未上线，请从已验证备份重建数据库');
  }
}
