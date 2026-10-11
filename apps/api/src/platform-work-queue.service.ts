import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import {
  BillStatus, DealPackage, Merchant, MerchantStatus, MonthlyBill, PackageStatus, PlatformAccessProfile,
  Refund, Store, SupportTicket, SupportTicketSource, SupportTicketStatus, SupportTicketType, User, Voucher, VoucherStatus,
} from './domain/entities';
import { MerchantAccessService } from './merchant-access.service';

export type PlatformWorkQueue = {
  generatedAt: string;
  totals: { contractsExpiring: number; salesSuspended: number; draftPackages: number; billsRequiringAttention: number; failedRefunds: number; closedStoreVouchers: number; supportFirstResponseOverdue: number };
  contractsExpiring: Array<{ merchantId: string; brandName: string; contractEndsAt: Date; daysRemaining: number }>;
  salesSuspended: Array<{ merchantId: string; brandName: string; contractEndsAt: Date | null; updatedAt: Date }>;
  draftPackages: Array<{ packageId: string; merchantId: string; brandName: string; title: string; updatedAt: Date }>;
  billsRequiringAttention: Array<{ billId: string; merchantId: string; brandName: string; period: string; status: BillStatus; serviceFeeFen: number; disputeEndsAt: Date; dueAt: Date }>;
  failedRefunds: Array<{ refundId: string; voucherId: string; merchantId: string; brandName: string; amountFen: number; attemptCount: number; lastAttemptAt: Date | null; createdAt: Date }>;
  closedStoreVouchers: Array<{ voucherId: string; merchantId: string; brandName: string; code: string; storeId: string; storeName: string; faceValueFen: number; validTo: Date }>;
  supportFirstResponseOverdue: Array<{ ticketId: string; merchantId: string; brandName: string; createdAt: Date; firstResponseDueAt: Date }>;
};

@Injectable()
export class PlatformWorkQueueService {
  constructor(
    private readonly merchantAccess: MerchantAccessService,
    @InjectRepository(Merchant) private readonly merchants: Repository<Merchant>,
    @InjectRepository(DealPackage) private readonly packages: Repository<DealPackage>,
    @InjectRepository(MonthlyBill) private readonly bills: Repository<MonthlyBill>,
    @InjectRepository(Refund) private readonly refunds: Repository<Refund>,
    @InjectRepository(Voucher) private readonly vouchers: Repository<Voucher>,
    @InjectRepository(SupportTicket) private readonly supportTickets: Repository<SupportTicket>,
  ) {}

  async get(user: User): Promise<PlatformWorkQueue> {
    this.merchantAccess.requirePlatformAccess(user, '查看平台待办', [PlatformAccessProfile.OPERATIONS, PlatformAccessProfile.FINANCE]);
    const accessProfile = this.merchantAccess.profile(user);
    const canOperate = accessProfile === PlatformAccessProfile.SYSTEM_ADMIN || accessProfile === PlatformAccessProfile.OPERATIONS;
    const canManageFinance = accessProfile === PlatformAccessProfile.SYSTEM_ADMIN || accessProfile === PlatformAccessProfile.FINANCE;
    const today = this.businessDayStart();
    const contractCutoff = new Date(today);
    contractCutoff.setUTCDate(contractCutoff.getUTCDate() + 30);
    const contractsQuery = this.merchants.createQueryBuilder('merchant')
      .where('merchant.status = :status', { status: MerchantStatus.ACTIVE })
      .andWhere('merchant.contractEndsAt >= :today', { today })
      .andWhere('merchant.contractEndsAt <= :contractCutoff', { contractCutoff });
    const suspendedQuery = this.merchants.createQueryBuilder('merchant').where('merchant.status = :status', { status: MerchantStatus.SALES_SUSPENDED });
    const billStatuses = [BillStatus.DISPUTE_WINDOW, BillStatus.DISPUTED, BillStatus.CONFIRMED, BillStatus.OVERDUE];
    const supportDueQuery = this.supportTickets.createQueryBuilder('ticket')
      .where('ticket.source = :source', { source: SupportTicketSource.CUSTOMER })
      .andWhere('ticket.type = :type', { type: SupportTicketType.GENERAL })
      .andWhere('ticket.status = :status', { status: SupportTicketStatus.OPEN })
      .andWhere('ticket.firstRespondedAt IS NULL')
      .andWhere('ticket.firstResponseDueAt IS NOT NULL')
      .andWhere('ticket.firstResponseDueAt < :now', { now: new Date() });
    const closedStoreVouchersQuery = this.vouchers.createQueryBuilder('voucher')
      .innerJoin(Store, 'store', 'store.id = voucher.storeId AND store.merchantId = voucher.merchantId')
      .select('voucher.id', 'voucherId').addSelect('voucher.merchantId', 'merchantId').addSelect('voucher.code', 'code')
      .addSelect('voucher.storeId', 'storeId').addSelect('voucher.faceValueFen', 'faceValueFen')
      .addSelect('voucher.validTo', 'validTo').addSelect('store.name', 'storeName')
      .where('voucher.status = :voucherStatus', { voucherStatus: VoucherStatus.UNUSED })
      .andWhere('voucher.validTo >= :today', { today })
      .andWhere('store.openForVerification = :openForVerification', { openForVerification: false });
    const [contractsExpiring, contractsExpiringCount, salesSuspended, salesSuspendedCount, draftPackages, draftPackagesCount, billsRequiringAttention, billsRequiringAttentionCount, failedRefunds, failedRefundsCount, closedStoreVouchers, closedStoreVouchersCount, supportFirstResponseOverdue, supportFirstResponseOverdueCount] = await Promise.all([
      canOperate ? contractsQuery.clone().orderBy('merchant.contractEndsAt', 'ASC').take(20).getMany() : Promise.resolve([] as Merchant[]), canOperate ? contractsQuery.getCount() : Promise.resolve(0),
      canOperate ? suspendedQuery.clone().orderBy('merchant.updatedAt', 'DESC').take(20).getMany() : Promise.resolve([] as Merchant[]), canOperate ? suspendedQuery.getCount() : Promise.resolve(0),
      canOperate ? this.packages.find({ where: { status: PackageStatus.DRAFT }, order: { updatedAt: 'DESC' }, take: 20 }) : Promise.resolve([] as DealPackage[]), canOperate ? this.packages.countBy({ status: PackageStatus.DRAFT }) : Promise.resolve(0),
      canManageFinance ? this.bills.find({ where: { status: In(billStatuses) }, order: { dueAt: 'ASC' }, take: 20 }) : Promise.resolve([] as MonthlyBill[]), canManageFinance ? this.bills.count({ where: { status: In(billStatuses) } }) : Promise.resolve(0),
      canManageFinance ? this.refunds.find({ where: { status: 'FAILED' }, order: { createdAt: 'ASC' }, take: 20 }) : Promise.resolve([] as Refund[]), canManageFinance ? this.refunds.countBy({ status: 'FAILED' }) : Promise.resolve(0),
      canOperate || canManageFinance ? closedStoreVouchersQuery.clone().orderBy('voucher.validTo', 'ASC').addOrderBy('voucher.id', 'ASC').take(20).getRawMany<{ voucherId: string; merchantId: string; code: string; storeId: string; storeName: string; faceValueFen: string | number; validTo: Date }>() : Promise.resolve([] as Array<{ voucherId: string; merchantId: string; code: string; storeId: string; storeName: string; faceValueFen: string | number; validTo: Date }>), canOperate || canManageFinance ? closedStoreVouchersQuery.getCount() : Promise.resolve(0),
      canOperate ? supportDueQuery.clone().orderBy('ticket.firstResponseDueAt', 'ASC').take(20).getMany() : Promise.resolve([] as SupportTicket[]), canOperate ? supportDueQuery.getCount() : Promise.resolve(0),
    ]);
    const merchantIds = [...new Set([
      ...(canOperate ? contractsExpiring.map((merchant) => merchant.id) : []), ...(canOperate ? salesSuspended.map((merchant) => merchant.id) : []),
      ...(canOperate ? draftPackages.map((deal) => deal.merchantId) : []), ...(canManageFinance ? billsRequiringAttention.map((bill) => bill.merchantId) : []),
      ...(canManageFinance ? failedRefunds.map((refund) => refund.merchantId) : []), ...((canOperate || canManageFinance) ? closedStoreVouchers.map((voucher) => voucher.merchantId) : []),
      ...(canOperate ? supportFirstResponseOverdue.map((ticket) => ticket.merchantId) : []),
    ])];
    const merchantNames = new Map((merchantIds.length ? await this.merchants.findBy({ id: In(merchantIds) }) : []).map((merchant) => [merchant.id, merchant.brandName]));
    return {
      generatedAt: new Date().toISOString(),
      totals: {
        contractsExpiring: canOperate ? contractsExpiringCount : 0, salesSuspended: canOperate ? salesSuspendedCount : 0,
        draftPackages: canOperate ? draftPackagesCount : 0, billsRequiringAttention: canManageFinance ? billsRequiringAttentionCount : 0,
        failedRefunds: canManageFinance ? failedRefundsCount : 0, closedStoreVouchers: canOperate || canManageFinance ? closedStoreVouchersCount : 0,
        supportFirstResponseOverdue: canOperate ? supportFirstResponseOverdueCount : 0,
      },
      contractsExpiring: canOperate ? contractsExpiring.map((merchant) => ({ merchantId: merchant.id, brandName: merchant.brandName, contractEndsAt: merchant.contractEndsAt!, daysRemaining: Math.max(0, Math.round((this.businessDayStart(this.day(merchant.contractEndsAt!)).getTime() - today.getTime()) / 86400000)) })) : [],
      salesSuspended: canOperate ? salesSuspended.map((merchant) => ({ merchantId: merchant.id, brandName: merchant.brandName, contractEndsAt: merchant.contractEndsAt, updatedAt: merchant.updatedAt })) : [],
      draftPackages: canOperate ? draftPackages.map((deal) => ({ packageId: deal.id, merchantId: deal.merchantId, brandName: merchantNames.get(deal.merchantId) || '已删除商家', title: deal.title, updatedAt: deal.updatedAt })) : [],
      billsRequiringAttention: canManageFinance ? billsRequiringAttention.map((bill) => ({ billId: bill.id, merchantId: bill.merchantId, brandName: merchantNames.get(bill.merchantId) || '已删除商家', period: bill.period, status: bill.status, serviceFeeFen: bill.serviceFeeFen, disputeEndsAt: bill.disputeEndsAt, dueAt: bill.dueAt })) : [],
      failedRefunds: canManageFinance ? failedRefunds.map((refund) => ({ refundId: refund.id, voucherId: refund.voucherId, merchantId: refund.merchantId, brandName: merchantNames.get(refund.merchantId) || '已删除商家', amountFen: refund.amountFen, attemptCount: Number(refund.attemptCount || 0), lastAttemptAt: refund.lastAttemptAt, createdAt: refund.createdAt })) : [],
      closedStoreVouchers: canOperate || canManageFinance ? closedStoreVouchers.map((voucher) => ({ voucherId: voucher.voucherId, merchantId: voucher.merchantId, brandName: merchantNames.get(voucher.merchantId) || '已删除商家', code: voucher.code, storeId: voucher.storeId, storeName: voucher.storeName, faceValueFen: Number(voucher.faceValueFen), validTo: new Date(voucher.validTo) })) : [],
      supportFirstResponseOverdue: canOperate ? supportFirstResponseOverdue.map((ticket) => ({ ticketId: ticket.id, merchantId: ticket.merchantId, brandName: merchantNames.get(ticket.merchantId) || '已删除商家', createdAt: ticket.createdAt, firstResponseDueAt: ticket.firstResponseDueAt! })) : [],
    };
  }

  private day(date: Date | string = new Date()): string {
    const values = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(date)).filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
    return `${values.year}-${values.month}-${values.day}`;
  }

  private businessDayStart(day = this.day()): Date { return new Date(`${day}T00:00:00+08:00`); }
}
