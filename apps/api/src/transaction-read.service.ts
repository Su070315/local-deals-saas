import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository, SelectQueryBuilder } from 'typeorm';
import {
  Order, OrderStatus, PaymentEvent, PlatformAccessProfile, Refund, SupportTicket, User, UserRole, Verification, Voucher, VoucherStatus,
} from './domain/entities';
import { MerchantQueryScopeService } from './merchant-query-scope.service';
import type {
  OrderListItem, OrderListQuery, Paginated, TransactionListQuery, VerificationListItem, VoucherListItem,
} from './app-service.core-types';

@Injectable()
export class TransactionReadService {
  constructor(
    private readonly merchantScope: MerchantQueryScopeService,
    @InjectRepository(Order) private readonly orders: Repository<Order>,
    @InjectRepository(PaymentEvent) private readonly paymentEvents: Repository<PaymentEvent>,
    @InjectRepository(Voucher) private readonly vouchers: Repository<Voucher>,
    @InjectRepository(Refund) private readonly refunds: Repository<Refund>,
    @InjectRepository(Verification) private readonly verifications: Repository<Verification>,
    @InjectRepository(SupportTicket) private readonly supportTickets: Repository<SupportTicket>,
  ) {}

  async listOrders(user: User, query: OrderListQuery = {}): Promise<Paginated<OrderListItem> & { statusCounts: Record<OrderStatus, number> }> {
    if (user.role === UserRole.STORE_STAFF) throw new ForbiddenException('核销员不可查看订单');
    const { page, pageSize, offset } = this.pageRequest(query);
    const scope = await this.merchantScope.resolve(user, query.merchantId, [PlatformAccessProfile.OPERATIONS, PlatformAccessProfile.FINANCE]);
    const recordsQuery = this.orderFilters(this.merchantScope.apply(scope, this.orders.createQueryBuilder('order'), 'order'), query, true).orderBy('order.createdAt', 'DESC').addOrderBy('order.id', 'DESC').skip(offset).take(pageSize);
    const totalQuery = this.orderFilters(this.merchantScope.apply(scope, this.orders.createQueryBuilder('order'), 'order'), query, true);
    const countsQuery = this.orderFilters(this.merchantScope.apply(scope, this.orders.createQueryBuilder('order'), 'order'), query, false).select('order.status', 'status').addSelect('COUNT(*)', 'count').groupBy('order.status');
    const [records, total, rawCounts] = await Promise.all([recordsQuery.getMany(), totalQuery.getCount(), countsQuery.getRawMany<{ status: OrderStatus; count: string }>()]);
    const statusCounts = Object.fromEntries(Object.values(OrderStatus).map((status) => [status, 0])) as Record<OrderStatus, number>;
    rawCounts.forEach((row) => { if (Object.values(OrderStatus).includes(row.status)) statusCounts[row.status] = Number(row.count) || 0; });
    return { items: records.map((record) => this.orderListItem(record)), page, pageSize, total, statusCounts };
  }

  async listVouchers(user: User, query: TransactionListQuery = {}): Promise<Paginated<VoucherListItem>> {
    if (user.role === UserRole.STORE_STAFF) throw new ForbiddenException('核销员不可查看券列表');
    const { page, pageSize, offset } = this.pageRequest(query);
    const scope = await this.merchantScope.resolve(user, query.merchantId, [PlatformAccessProfile.OPERATIONS, PlatformAccessProfile.FINANCE]);
    const recordsQuery = this.merchantScope.apply(scope, this.vouchers.createQueryBuilder('voucher').orderBy('voucher.createdAt', 'DESC').addOrderBy('voucher.id', 'DESC').skip(offset).take(pageSize), 'voucher');
    const totalQuery = this.merchantScope.apply(scope, this.vouchers.createQueryBuilder('voucher'), 'voucher');
    const [records, total] = await Promise.all([recordsQuery.getMany(), totalQuery.getCount()]);
    const refunds = records.length ? await this.refunds.findBy({ voucherId: In(records.map((record) => record.id)) }) : [];
    const refundsByVoucherId = new Map(refunds.map((refund) => [refund.voucherId, refund.status]));
    return { items: records.map((record) => this.voucherListItem(record, refundsByVoucherId.get(record.id) || null)), page, pageSize, total };
  }

  async listPaymentTransactions(user: User, query: TransactionListQuery = {}) {
    if (user.role === UserRole.STORE_STAFF) throw new ForbiddenException('核销员不可查看支付流水');
    const { page, pageSize, offset } = this.pageRequest(query);
    const scope = await this.merchantScope.resolve(user, query.merchantId, [PlatformAccessProfile.OPERATIONS, PlatformAccessProfile.FINANCE]);
    const recordsQuery = this.merchantScope.apply(scope, this.paymentEvents.createQueryBuilder('event').orderBy('event.occurredAt', 'DESC').addOrderBy('event.id', 'DESC').skip(offset).take(pageSize), 'event');
    const totalQuery = this.merchantScope.apply(scope, this.paymentEvents.createQueryBuilder('event'), 'event');
    const [records, total] = await Promise.all([recordsQuery.getMany(), totalQuery.getCount()]);
    const orderNos = await this.orderNumberMap(records.map((record) => record.orderId));
    return {
      items: records.map((record) => ({
        id: record.id, orderId: record.orderId, orderNo: orderNos.get(record.orderId) || '-', provider: record.provider,
        eventType: record.eventType, amountFen: record.amountFen, occurredAt: record.occurredAt,
        receivedAt: record.receivedAt, status: record.status, processingNote: record.processingNote,
      })),
      page, pageSize, total,
    };
  }

  async listRefundTransactions(user: User, query: TransactionListQuery = {}) {
    if (user.role === UserRole.STORE_STAFF) throw new ForbiddenException('核销员不可查看退款流水');
    const { page, pageSize, offset } = this.pageRequest(query);
    const scope = await this.merchantScope.resolve(user, query.merchantId, [PlatformAccessProfile.OPERATIONS, PlatformAccessProfile.FINANCE]);
    const recordsQuery = this.merchantScope.apply(scope, this.refunds.createQueryBuilder('refund').orderBy('refund.createdAt', 'DESC').addOrderBy('refund.id', 'DESC').skip(offset).take(pageSize), 'refund');
    const totalQuery = this.merchantScope.apply(scope, this.refunds.createQueryBuilder('refund'), 'refund');
    const [records, total] = await Promise.all([recordsQuery.getMany(), totalQuery.getCount()]);
    const orderNos = await this.orderNumberMap(records.map((record) => record.orderId));
    // 关联券状态 + 订单状态 + 售后工单（异常退款/停业补偿可追溯审批来源）
    const [vouchers, orders, tickets] = await Promise.all([
      records.length ? this.vouchers.findBy({ id: In(records.map((record) => record.voucherId)) }) : [],
      records.length ? this.orders.find({ where: { id: In(records.map((record) => record.orderId)) }, select: { id: true, status: true } }) : [],
      records.length ? this.supportTickets.findBy({ id: In(records.map((record) => record.ticketId).filter((id): id is string => Boolean(id))) }) : [],
    ]);
    const voucherStatusById = new Map(vouchers.map((voucher): [string, VoucherStatus] => [voucher.id, voucher.status]));
    const orderStatusById = new Map(orders.map((order): [string, OrderStatus] => [order.id, order.status]));
    const ticketNoById = new Map(tickets.map((ticket): [string, string] => [ticket.id, ticket.content.slice(0, 40)]));
    return {
      items: records.map((record) => ({
        id: record.id, orderId: record.orderId, orderNo: orderNos.get(record.orderId) || '-', voucherId: record.voucherId,
        amountFen: record.amountFen, reason: record.reason, status: record.status, lastAttemptAt: record.lastAttemptAt,
        attemptCount: record.attemptCount, createdAt: record.createdAt,
        ticketId: record.ticketId, ticketPreview: record.ticketId ? ticketNoById.get(record.ticketId) || '-' : null,
        voucherStatus: voucherStatusById.get(record.voucherId) || null, orderStatus: orderStatusById.get(record.orderId) || null,
      })),
      page, pageSize, total,
    };
  }

  async listVerifications(user: User, query: TransactionListQuery = {}): Promise<Paginated<VerificationListItem>> {
    const { page, pageSize, offset } = this.pageRequest(query);
    const scope = await this.merchantScope.resolve(user, query.merchantId, [PlatformAccessProfile.OPERATIONS, PlatformAccessProfile.FINANCE]);
    if (user.role === UserRole.STORE_STAFF) {
      const storeIds = user.storeIds || [];
      if (!storeIds.length) return { items: [], page, pageSize, total: 0 };
      const recordsQuery = this.merchantScope.apply(scope, this.verifications.createQueryBuilder('verification').where('verification.storeId IN (:...storeIds) AND verification.staffId = :staffId', { storeIds, staffId: user.id }).orderBy('verification.verifiedAt', 'DESC').addOrderBy('verification.id', 'DESC').skip(offset).take(pageSize), 'verification');
      const totalQuery = this.merchantScope.apply(scope, this.verifications.createQueryBuilder('verification').where('verification.storeId IN (:...storeIds) AND verification.staffId = :staffId', { storeIds, staffId: user.id }), 'verification');
      const [records, total] = await Promise.all([recordsQuery.getMany(), totalQuery.getCount()]);
      return { items: records.map((record) => this.verificationListItem(record)), page, pageSize, total };
    }
    const recordsQuery = this.merchantScope.apply(scope, this.verifications.createQueryBuilder('verification').orderBy('verification.verifiedAt', 'DESC').addOrderBy('verification.id', 'DESC').skip(offset).take(pageSize), 'verification');
    const totalQuery = this.merchantScope.apply(scope, this.verifications.createQueryBuilder('verification'), 'verification');
    const [records, total] = await Promise.all([recordsQuery.getMany(), totalQuery.getCount()]);
    return { items: records.map((record) => this.verificationListItem(record)), page, pageSize, total };
  }

  private pageRequest(query: TransactionListQuery): { page: number; pageSize: number; offset: number } {
    const page = this.requiredInteger(query.page ?? 1, '页码', 1, 10_000);
    const pageSize = this.requiredInteger(query.pageSize ?? 25, '每页条数', 1, 100);
    const offset = (page - 1) * pageSize;
    if (offset >= 100_000) throw new BadRequestException('运营列表仅支持浏览最近 100,000 行，请使用受控导出获取更早明细');
    return { page, pageSize, offset };
  }

  private requiredInteger(value: unknown, label: string, min: number, max: number): number {
    const number = Number(value);
    if (!Number.isInteger(number) || number < min || number > max) throw new BadRequestException(`${label}必须为 ${min} 至 ${max} 的整数`);
    return number;
  }

  private orderListItem(order: Order): OrderListItem {
    const { customerId: _customerId, idempotencyKey: _idempotencyKey, paymentReference: _paymentReference, commissionRateSnapshot: _commissionRateSnapshot, ...safe } = order;
    return safe;
  }

  private orderFilters(queryBuilder: SelectQueryBuilder<Order>, query: OrderListQuery, includeStatus: boolean): SelectQueryBuilder<Order> {
    const keyword = String(query.keyword || '').trim().toLowerCase();
    if (includeStatus && query.status) queryBuilder.andWhere('order.status = :status', { status: query.status });
    if (keyword) queryBuilder.andWhere('(LOWER(order.orderNo) LIKE :keyword OR LOWER(order.packageTitleSnapshot) LIKE :keyword)', { keyword: `%${keyword}%` });
    if (query.from) queryBuilder.andWhere('order.createdAt >= :from', { from: new Date(`${query.from}T00:00:00+08:00`) });
    if (query.to) {
      const exclusiveEnd = new Date(`${query.to}T00:00:00+08:00`);
      exclusiveEnd.setUTCDate(exclusiveEnd.getUTCDate() + 1);
      queryBuilder.andWhere('order.createdAt < :to', { to: exclusiveEnd });
    }
    return queryBuilder;
  }

  private voucherListItem(voucher: Voucher, refundStatus: string | null): VoucherListItem {
    const { customerId: _customerId, commissionRateSnapshot: _commissionRateSnapshot, ...safe } = voucher;
    const status = voucher.status === VoucherStatus.UNUSED && this.day(voucher.validTo) < this.day() ? VoucherStatus.EXPIRED : voucher.status;
    return { ...safe, status, refundStatus };
  }

  private verificationListItem(verification: Verification): VerificationListItem {
    const { idempotencyKey: _idempotencyKey, ...safe } = verification;
    return safe;
  }

  private async orderNumberMap(orderIds: string[]): Promise<Map<string, string>> {
    const uniqueIds = [...new Set(orderIds)];
    if (!uniqueIds.length) return new Map();
    const orders = await this.orders.find({ select: { id: true, orderNo: true }, where: { id: In(uniqueIds) } });
    return new Map(orders.map((order) => [order.id, order.orderNo]));
  }

  private day(date: Date | string = new Date()): string {
    const values = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(date)).filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
    return `${values.year}-${values.month}-${values.day}`;
  }
}
