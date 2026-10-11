import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ObjectLiteral, Repository } from 'typeorm';
import { DealPackage, Order, OrderStatus, PlatformAccessProfile, Refund, SettlementLedgerEntry, Store, User, UserRole, Verification, Voucher, VoucherStatus } from './domain/entities';
import { usesEmbeddedDatabase } from './runtime-config';
import { MerchantQueryScope, MerchantQueryScopeService } from './merchant-query-scope.service';

export type ReportSummary = { paidAmountFen: number; refundedAmountFen: number; netAmountFen: number; verifiedAmountFen: number; serviceFeeFen: number; orderCount: number; voucherCount: number };
export type ReportAnalytics = {
  range: { from: string; to: string };
  summary: ReportSummary & { payingCustomerCount: number; repeatCustomerCount: number; verificationRate: number; refundRate: number };
  daily: Array<{ day: string; paidAmountFen: number; refundedAmountFen: number; netAmountFen: number; verifiedAmountFen: number; serviceFeeFen: number; orderCount: number; verificationCount: number }>;
  stores: Array<{ storeId: string; storeName: string; orderCount: number; paidAmountFen: number; verificationCount: number; verifiedAmountFen: number; refundAmountFen: number }>;
  packages: Array<{ packageId: string; title: string; orderCount: number; paidAmountFen: number; voucherCount: number; verificationCount: number; verifiedAmountFen: number; refundAmountFen: number }>;
  alerts: Array<{ code: string; severity: 'INFO' | 'WARNING'; title: string; detail: string }>;
};

type ReportRange = { from: Date; toExclusive: Date; fromDay: string; toDay: string };

export function reportBusinessDaySql(column: string, embedded = usesEmbeddedDatabase()): string {
  if (!/^[a-z]+\.[A-Za-z][A-Za-z0-9]*$/.test(column)) throw new Error('报表日期列标识无效');
  return embedded
    ? `to_char(${column}, 'YYYY-MM-DD')`
    : `to_char(${column} AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM-DD')`;
}

@Injectable()
export class ReportingService {
  constructor(
    private readonly merchantScope: MerchantQueryScopeService,
    @InjectRepository(Order) private readonly orders: Repository<Order>,
    @InjectRepository(Voucher) private readonly vouchers: Repository<Voucher>,
    @InjectRepository(Verification) private readonly verifications: Repository<Verification>,
    @InjectRepository(Refund) private readonly refunds: Repository<Refund>,
    @InjectRepository(SettlementLedgerEntry) private readonly ledger: Repository<SettlementLedgerEntry>,
    @InjectRepository(Store) private readonly stores: Repository<Store>,
    @InjectRepository(DealPackage) private readonly packages: Repository<DealPackage>,
  ) {}

  async summary(user: User, merchantId?: string): Promise<ReportSummary> {
    const scope = await this.scope(user, merchantId);
    if (scope.kind === 'none') return { paidAmountFen: 0, refundedAmountFen: 0, netAmountFen: 0, verifiedAmountFen: 0, serviceFeeFen: 0, orderCount: 0, voucherCount: 0 };
    const paidStates = [OrderStatus.PAID, OrderStatus.REFUNDED];
    const [paid, refunded, ledger, orders, vouchers] = await Promise.all([
      this.merchantScope.apply(scope, this.orders.createQueryBuilder('order').select('COALESCE(SUM(order.amountFen),0)', 'total').where('order.status IN (:...states)', { states: paidStates }), 'order').getRawOne<{ total: string }>(),
      this.merchantScope.apply(scope, this.refunds.createQueryBuilder('refund').select('COALESCE(SUM(refund.amountFen),0)', 'total').where('refund.status = :status', { status: 'SUCCEEDED' }), 'refund').getRawOne<{ total: string }>(),
      this.merchantScope.apply(scope, this.ledger.createQueryBuilder('entry').select('COALESCE(SUM(entry.verifiedAmountFen),0)', 'amount').addSelect('COALESCE(SUM(entry.serviceFeeFen),0)', 'fee'), 'entry').getRawOne<{ amount: string; fee: string }>(),
      // 口径与金额一致：订单数只统计已支付/已退款订单（排除 PENDING_PAYMENT/CLOSED 从未支付单）
      this.merchantScope.apply(scope, this.orders.createQueryBuilder('order'), 'order').where('order.status IN (:...states)', { states: paidStates }).getCount(),
      // 券数只统计真实售出券（券仅在支付成功时生成，排除数据迁移/脏数据兜底）
      this.merchantScope.apply(scope, this.vouchers.createQueryBuilder('voucher'), 'voucher').where('voucher.status IN (:...states)', { states: [VoucherStatus.UNUSED, VoucherStatus.USED, VoucherStatus.REFUND_PENDING, VoucherStatus.REFUNDED, VoucherStatus.EXPIRED] }).getCount(),
    ]);
    const paidAmountFen = this.number(paid?.total);
    const refundedAmountFen = this.number(refunded?.total);
    // #6：净营业额不截 0——当日退款>支付时如实反映负净额（掩盖负净额会隐藏退款压力）
    return { paidAmountFen, refundedAmountFen, netAmountFen: paidAmountFen - refundedAmountFen, verifiedAmountFen: this.number(ledger?.amount), serviceFeeFen: this.number(ledger?.fee), orderCount: orders, voucherCount: vouchers };
  }

  /**
   * 经营报表分析（口径说明）：
   * - 支付金额/订单数/券数：按订单**下单时间**（order.createdAt）归日，统计 PAID/REFUNDED；
   * - 退款金额：按退款**申请时间**（refund.createdAt）归日；
   * - 核销金额：按核销时间（verification.verifiedAt）归日；
   * - 净营业额 = 支付金额 − 退款金额（#6 允许为负，如实反映当日退款压力）；
   * - 注意：跨日退款时，支付日的净额不追溯扣减（每日净额 = 当日支付 − 当日退款，属标准财务口径）。
   */
  async analytics(user: User, merchantId: string | undefined, from?: string, to?: string): Promise<ReportAnalytics> {
    const scope = await this.scope(user, merchantId);
    const range = this.normalizeRange(from, to);
    if (scope.kind === 'none') return this.emptyAnalytics(range);
    const paidStates = [OrderStatus.PAID, OrderStatus.REFUNDED];
    const orderDay = reportBusinessDaySql('order.createdAt');
    const ledgerDay = reportBusinessDaySql('entry.occurredAt');
    const refundDay = reportBusinessDaySql('refund.createdAt');
    const verificationDay = reportBusinessDaySql('verification.verifiedAt');
    const [dailyOrders, dailyLedger, dailyRefunds, dailyVerifications, storeOrders, storeLedger, storeRefunds, packageOrders, packageVouchers, packageLedger, packageRefunds, customerCounts, voucherCount, verificationCount, refundCount] = await Promise.all([
      this.scoped(scope, this.orders, 'order').select(orderDay, 'day').addSelect('COUNT(*)', 'count').addSelect('COALESCE(SUM(order.amountFen),0)', 'amount').andWhere('order.status IN (:...paidStates) AND order.createdAt >= :from AND order.createdAt < :toExclusive', { paidStates, ...range }).groupBy(orderDay).getRawMany<{ day: string; count: string; amount: string }>(),
      this.scoped(scope, this.ledger, 'entry').select(ledgerDay, 'day').addSelect('COALESCE(SUM(entry.verifiedAmountFen),0)', 'amount').addSelect('COALESCE(SUM(entry.serviceFeeFen),0)', 'fee').andWhere('entry.occurredAt >= :from AND entry.occurredAt < :toExclusive', range).groupBy(ledgerDay).getRawMany<{ day: string; amount: string; fee: string }>(),
      this.scoped(scope, this.refunds, 'refund').select(refundDay, 'day').addSelect('COALESCE(SUM(refund.amountFen),0)', 'amount').andWhere('refund.status = :status AND refund.createdAt >= :from AND refund.createdAt < :toExclusive', { status: 'SUCCEEDED', ...range }).groupBy(refundDay).getRawMany<{ day: string; amount: string }>(),
      this.scoped(scope, this.verifications, 'verification').select(verificationDay, 'day').addSelect('COUNT(*)', 'count').andWhere('verification.verifiedAt >= :from AND verification.verifiedAt < :toExclusive', range).groupBy(verificationDay).getRawMany<{ day: string; count: string }>(),
      this.scoped(scope, this.orders, 'order').select('order.storeId', 'storeId').addSelect('COUNT(*)', 'count').addSelect('COALESCE(SUM(order.amountFen),0)', 'amount').andWhere('order.status IN (:...paidStates) AND order.createdAt >= :from AND order.createdAt < :toExclusive', { paidStates, ...range }).groupBy('order.storeId').getRawMany<{ storeId: string; count: string; amount: string }>(),
      this.scoped(scope, this.verifications, 'verification').select('verification.storeId', 'storeId').addSelect('COUNT(*)', 'count').addSelect('COALESCE(SUM(verification.amountFen),0)', 'amount').andWhere('verification.verifiedAt >= :from AND verification.verifiedAt < :toExclusive', range).groupBy('verification.storeId').getRawMany<{ storeId: string; count: string; amount: string }>(),
      // #14 口径说明：门店维度退款按券的**当前 storeId** 归属（转店后归入新门店），核销台账按核销时门店——两者基准不同属已知口径漂移，报表层不追溯修正
      this.scoped(scope, this.refunds, 'refund').select('voucher.storeId', 'storeId').addSelect('COALESCE(SUM(refund.amountFen),0)', 'amount').innerJoin(Voucher, 'voucher', 'voucher.id = refund.voucherId AND voucher.merchantId = refund.merchantId').andWhere('refund.status = :status AND refund.createdAt >= :from AND refund.createdAt < :toExclusive', { status: 'SUCCEEDED', ...range }).groupBy('voucher.storeId').getRawMany<{ storeId: string; amount: string }>(),
      this.scoped(scope, this.orders, 'order').select('order.packageId', 'packageId').addSelect('COUNT(*)', 'count').addSelect('COALESCE(SUM(order.amountFen),0)', 'amount').andWhere('order.status IN (:...paidStates) AND order.createdAt >= :from AND order.createdAt < :toExclusive', { paidStates, ...range }).groupBy('order.packageId').getRawMany<{ packageId: string; count: string; amount: string }>(),
      this.scoped(scope, this.vouchers, 'voucher').select('voucher.packageId', 'packageId').addSelect('COUNT(*)', 'count').andWhere('voucher.createdAt >= :from AND voucher.createdAt < :toExclusive', range).groupBy('voucher.packageId').getRawMany<{ packageId: string; count: string }>(),
      this.scoped(scope, this.ledger, 'entry').select('voucher.packageId', 'packageId').addSelect('COUNT(*)', 'count').addSelect('COALESCE(SUM(entry.verifiedAmountFen),0)', 'amount').innerJoin(Voucher, 'voucher', 'voucher.id = entry.voucherId AND voucher.merchantId = entry.merchantId').andWhere('entry.occurredAt >= :from AND entry.occurredAt < :toExclusive', range).groupBy('voucher.packageId').getRawMany<{ packageId: string; count: string; amount: string }>(),
      this.scoped(scope, this.refunds, 'refund').select('voucher.packageId', 'packageId').addSelect('COALESCE(SUM(refund.amountFen),0)', 'amount').innerJoin(Voucher, 'voucher', 'voucher.id = refund.voucherId AND voucher.merchantId = refund.merchantId').andWhere('refund.status = :status AND refund.createdAt >= :from AND refund.createdAt < :toExclusive', { status: 'SUCCEEDED', ...range }).groupBy('voucher.packageId').getRawMany<{ packageId: string; amount: string }>(),
      this.scoped(scope, this.orders, 'order').select('order.customerId', 'customerId').addSelect('COUNT(*)', 'count').andWhere('order.status IN (:...paidStates) AND order.createdAt >= :from AND order.createdAt < :toExclusive', { paidStates, ...range }).groupBy('order.customerId').getRawMany<{ customerId: string; count: string }>(),
      this.scoped(scope, this.vouchers, 'voucher').andWhere('voucher.createdAt >= :from AND voucher.createdAt < :toExclusive', range).getCount(),
      this.scoped(scope, this.vouchers, 'voucher').andWhere('voucher.status = :status AND voucher.createdAt >= :from AND voucher.createdAt < :toExclusive', { status: VoucherStatus.USED, ...range }).getCount(),
      this.scoped(scope, this.vouchers, 'voucher').andWhere('voucher.status = :status AND voucher.createdAt >= :from AND voucher.createdAt < :toExclusive', { status: VoucherStatus.REFUNDED, ...range }).getCount(),
    ]);
    const [stores, packages] = await Promise.all([
      this.scoped(scope, this.stores, 'store').select(['store.id', 'store.name']).getMany(),
      this.scoped(scope, this.packages, 'deal').select(['deal.id', 'deal.title']).getMany(),
    ]);
    const storeNames = new Map(stores.map((store) => [store.id, store.name]));
    const packageNames = new Map(packages.map((deal) => [deal.id, deal.title]));
    const daily = this.dailyRows(range, dailyOrders, dailyLedger, dailyRefunds, dailyVerifications);
    const storeOrderMap = new Map(storeOrders.map((row) => [row.storeId, row]));
    const storeLedgerMap = new Map(storeLedger.map((row) => [row.storeId, row]));
    const storeRefundMap = new Map(storeRefunds.map((row) => [row.storeId, row]));
    const storeRows = [...new Set([...storeOrderMap.keys(), ...storeLedgerMap.keys(), ...storeRefundMap.keys()])].map((storeId) => ({ storeId, storeName: storeNames.get(storeId) || '已归档门店', orderCount: this.number(storeOrderMap.get(storeId)?.count), paidAmountFen: this.number(storeOrderMap.get(storeId)?.amount), verificationCount: this.number(storeLedgerMap.get(storeId)?.count), verifiedAmountFen: this.number(storeLedgerMap.get(storeId)?.amount), refundAmountFen: this.number(storeRefundMap.get(storeId)?.amount) })).sort((a, b) => b.paidAmountFen - a.paidAmountFen);
    const packageOrderMap = new Map(packageOrders.map((row) => [row.packageId, row]));
    const packageVoucherMap = new Map(packageVouchers.map((row) => [row.packageId, row]));
    const packageLedgerMap = new Map(packageLedger.map((row) => [row.packageId, row]));
    const packageRefundMap = new Map(packageRefunds.map((row) => [row.packageId, row]));
    const packageRows = [...new Set([...packageOrderMap.keys(), ...packageVoucherMap.keys(), ...packageLedgerMap.keys(), ...packageRefundMap.keys()])].map((packageId) => ({ packageId, title: packageNames.get(packageId) || '已归档套餐', orderCount: this.number(packageOrderMap.get(packageId)?.count), paidAmountFen: this.number(packageOrderMap.get(packageId)?.amount), voucherCount: this.number(packageVoucherMap.get(packageId)?.count), verificationCount: this.number(packageLedgerMap.get(packageId)?.count), verifiedAmountFen: this.number(packageLedgerMap.get(packageId)?.amount), refundAmountFen: this.number(packageRefundMap.get(packageId)?.amount) })).sort((a, b) => b.paidAmountFen - a.paidAmountFen);
    const paidAmountFen = daily.reduce((sum, row) => sum + row.paidAmountFen, 0);
    const refundedAmountFen = daily.reduce((sum, row) => sum + row.refundedAmountFen, 0);
    const verifiedAmountFen = daily.reduce((sum, row) => sum + row.verifiedAmountFen, 0);
    const serviceFeeFen = daily.reduce((sum, row) => sum + row.serviceFeeFen, 0);
    const payingCustomerCount = customerCounts.length;
    const repeatCustomerCount = customerCounts.filter((row) => Number(row.count) > 1).length;
    const verificationRate = voucherCount ? Number((verificationCount / voucherCount).toFixed(4)) : 0;
    const refundRate = voucherCount ? Number((refundCount / voucherCount).toFixed(4)) : 0;
    const alerts: ReportAnalytics['alerts'] = [];
    if (voucherCount >= 10 && verificationRate < 0.2) alerts.push({ code: 'LOW_VERIFICATION_RATE', severity: 'WARNING', title: '核销率偏低', detail: `当前区间核销率为 ${(verificationRate * 100).toFixed(1)}%，建议检查套餐规则、门店营业和顾客提醒。` });
    if (voucherCount >= 10 && refundRate > 0.2) alerts.push({ code: 'HIGH_REFUND_RATE', severity: 'WARNING', title: '退款率偏高', detail: `当前区间退款率为 ${(refundRate * 100).toFixed(1)}%，建议检查商品描述、价格和履约门店。` });
    return { range: { from: range.fromDay, to: range.toDay }, summary: { paidAmountFen, refundedAmountFen, netAmountFen: paidAmountFen - refundedAmountFen, verifiedAmountFen, serviceFeeFen, orderCount: daily.reduce((sum, row) => sum + row.orderCount, 0), voucherCount, payingCustomerCount, repeatCustomerCount, verificationRate, refundRate }, daily, stores: storeRows, packages: packageRows, alerts };
  }

  private async scope(user: User, merchantId?: string): Promise<MerchantQueryScope> {
    if (user.role === UserRole.STORE_STAFF) throw new ForbiddenException('核销员不可查看经营报表');
    return this.merchantScope.resolve(user, merchantId, [PlatformAccessProfile.OPERATIONS, PlatformAccessProfile.FINANCE]);
  }

  private scoped<T extends ObjectLiteral>(scope: MerchantQueryScope, repository: Repository<T>, alias: string) {
    return this.merchantScope.apply(scope, repository.createQueryBuilder(alias), alias);
  }

  private normalizeRange(from?: string, to?: string): ReportRange {
    const today = this.day();
    const endDay = to || today;
    const startDay = from || this.day(new Date(Date.now() - 29 * 86400000));
    if (!/^\d{4}-\d{2}-\d{2}$/.test(startDay) || !/^\d{4}-\d{2}-\d{2}$/.test(endDay)) throw new BadRequestException('报表日期必须为 YYYY-MM-DD');
    const start = new Date(`${startDay}T00:00:00+08:00`);
    const end = new Date(`${endDay}T00:00:00+08:00`);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || this.day(start) !== startDay || this.day(end) !== endDay) throw new BadRequestException('报表日期不存在');
    if (start > end) throw new BadRequestException('报表开始日期不能晚于结束日期');
    const days = Math.floor((end.getTime() - start.getTime()) / 86400000) + 1;
    if (days > 366) throw new BadRequestException('报表时间范围不能超过 366 天');
    return { from: start, toExclusive: new Date(end.getTime() + 86400000), fromDay: startDay, toDay: endDay };
  }

  private dailyRows(range: ReportRange, orders: Array<{ day: string; count: string; amount: string }>, ledger: Array<{ day: string; amount: string; fee: string }>, refunds: Array<{ day: string; amount: string }>, verifications: Array<{ day: string; count: string }>): ReportAnalytics['daily'] {
    const orderMap = new Map(orders.map((row) => [row.day, row]));
    const ledgerMap = new Map(ledger.map((row) => [row.day, row]));
    const refundMap = new Map(refunds.map((row) => [row.day, row]));
    const verificationMap = new Map(verifications.map((row) => [row.day, row]));
    const rows: ReportAnalytics['daily'] = [];
    const cursor = new Date(range.from);
    while (cursor < range.toExclusive) {
      const day = this.day(cursor);
      rows.push({ day, paidAmountFen: this.number(orderMap.get(day)?.amount), refundedAmountFen: this.number(refundMap.get(day)?.amount), netAmountFen: this.number(orderMap.get(day)?.amount) - this.number(refundMap.get(day)?.amount), verifiedAmountFen: this.number(ledgerMap.get(day)?.amount), serviceFeeFen: this.number(ledgerMap.get(day)?.fee), orderCount: this.number(orderMap.get(day)?.count), verificationCount: this.number(verificationMap.get(day)?.count) });
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
    return rows;
  }

  private emptyAnalytics(range: ReportRange): ReportAnalytics { return { range: { from: range.fromDay, to: range.toDay }, summary: { paidAmountFen: 0, refundedAmountFen: 0, netAmountFen: 0, verifiedAmountFen: 0, serviceFeeFen: 0, orderCount: 0, voucherCount: 0, payingCustomerCount: 0, repeatCustomerCount: 0, verificationRate: 0, refundRate: 0 }, daily: [], stores: [], packages: [], alerts: [] }; }
  private number(value: string | number | null | undefined): number { const result = Number(value || 0); return Number.isFinite(result) ? result : 0; }
  private day(date: Date | string = new Date()): string { const values = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(date)).filter((part) => part.type !== 'literal').map((part) => [part.type, part.value])); return `${values.year}-${values.month}-${values.day}`; }
}
