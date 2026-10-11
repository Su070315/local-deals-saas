import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, In, LessThan, Repository } from 'typeorm';
import {
  BillDispute,
  BillDisputeStatus,
  BillPaymentConfirmationRequest,
  BillStatus,
  InvoiceStatus,
  MonthlyBill,
  MonthlyBillGenerationCommand,
  PlatformAccessProfile,
  SettlementLedgerEntry,
  SettlementLedgerReversal,
  User,
  UserRole,
} from './domain/entities';
import { AuditWriterService } from './audit-writer.service';
import { MerchantAccessService } from './merchant-access.service';
import { MerchantQueryScopeService } from './merchant-query-scope.service';
import { NotificationAudienceService } from './notifications/notification-audience.service';
import {
  assertSameMonthlyBillGenerationCommand,
  billDisputeListItem,
  billingPeriodRange,
  billPaymentConfirmationRequestListItem,
  billPaymentDueAt,
  isUniqueConstraintError,
  monthlyBillGenerationRequestHash,
  optionalText,
  requiredText,
  shanghaiDay,
} from './billing-policy';
import { BILL_DISPUTE_WINDOW_MS } from './billing-policy';
import type { BillPaymentConfirmationRequestListItem } from './bill-payment-confirmation.service';

export type BillDisputeListItem = Pick<BillDispute, 'id' | 'billId' | 'status' | 'content' | 'resolutionNote' | 'createdAt' | 'resolvedAt'>;
type RestrictedBillPaymentConfirmationRequestListItem = Pick<BillPaymentConfirmationRequest, 'id' | 'status' | 'createdAt' | 'reviewedAt' | 'updatedAt'>;
export type MonthlyBillListItem = MonthlyBill & { dispute: BillDisputeListItem | null; paymentConfirmationRequest: BillPaymentConfirmationRequestListItem | RestrictedBillPaymentConfirmationRequestListItem | null };
export type BillLifecycleProgress = { confirmed: number; overdue: number; suspendedForOverdueBills: number };

/** FIX: 恢复月结账单生成所需的自定义异常（原定义随停用被删除，同账期并发生成时用于等待轮询） */
class BillGenerationInProgressError extends Error {}

@Injectable()
export class BillingService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly auditWriter: AuditWriterService,
    private readonly merchantAccess: MerchantAccessService,
    private readonly merchantScope: MerchantQueryScopeService,
    private readonly notificationAudience: NotificationAudienceService,
    @InjectRepository(SettlementLedgerEntry) private readonly ledger: Repository<SettlementLedgerEntry>,
    @InjectRepository(SettlementLedgerReversal) private readonly reversals: Repository<SettlementLedgerReversal>,
    @InjectRepository(MonthlyBill) private readonly bills: Repository<MonthlyBill>,
    @InjectRepository(BillPaymentConfirmationRequest) private readonly paymentConfirmationRequests: Repository<BillPaymentConfirmationRequest>,
    @InjectRepository(BillDispute) private readonly disputes: Repository<BillDispute>,
  ) {}

  async generateBills(user: User, period: string, rawIdempotencyKey?: string): Promise<MonthlyBill[]> {
    // FIX: 恢复本地服务费月结账单生成（此前被误停用：GoneException「收钱吧」文案与系统实际不符，
    // 费率/账单均无外部渠道同步，本地月结是唯一收入归集口径，见 2026-08-09 排查记录）。
    this.merchantAccess.requirePlatformAccess(user, '生成月结账单', [PlatformAccessProfile.FINANCE]);
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) throw new BadRequestException('账期格式为 YYYY-MM');
    if (period >= shanghaiDay().slice(0, 7)) throw new BadRequestException('仅可生成已结束账期的月结账单');
    const idempotencyKey = rawIdempotencyKey === undefined ? null : requiredText(rawIdempotencyKey, '月结生成请求标识', 128);
    if (idempotencyKey && !/^[A-Za-z0-9_-]{12,128}$/.test(idempotencyKey)) throw new BadRequestException('月结生成请求标识格式不正确');
    const requestHash = idempotencyKey ? monthlyBillGenerationRequestHash(period) : null;
    const { start, end } = billingPeriodRange(period);
    try {
      return await this.dataSource.transaction(async (manager) => {
        if (idempotencyKey && requestHash) {
          const retried = await this.monthlyBillGenerationCommandForRetry(manager, user.id, idempotencyKey);
          if (retried) {
            assertSameMonthlyBillGenerationCommand(retried, requestHash);
            const existing = await this.monthlyBillsForPeriod(manager, period);
            if (existing.length) return existing;
            throw new BillGenerationInProgressError();
          }
          await manager.save(MonthlyBillGenerationCommand, { period, requestedBy: user.id, idempotencyKey, requestHash });
        }
        const records = await manager.createQueryBuilder(SettlementLedgerEntry, 'ledger')
          .select('ledger.merchantId', 'merchantId')
          .addSelect('SUM(ledger.verifiedAmountFen)', 'amount')
          .addSelect('SUM(ledger.serviceFeeFen)', 'fee')
          .where('ledger.occurredAt >= :start AND ledger.occurredAt < :end', { start, end })
          .andWhere("ledger.entryType IN ('VERIFIED', 'CONFIRMED', 'REFUND')")
          .andWhere("ledger.entryType <> 'VERIFIED' OR NOT EXISTS (SELECT 1 FROM settlement_ledger_entries confirmed WHERE confirmed.\"voucherId\" = ledger.\"voucherId\" AND confirmed.\"entryType\" = 'CONFIRMED')")
          .groupBy('ledger.merchantId')
          .getRawMany<{ merchantId: string; amount: string; fee: string }>();
        const bills: MonthlyBill[] = [];
        const [year, month] = period.split('-').map(Number);
        const dueMonthIndex = month + 1;
        const dueYear = year + Math.floor((dueMonthIndex - 1) / 12);
        const dueMonth = ((dueMonthIndex - 1) % 12) + 1;
        const scheduledDueAt = new Date(`${dueYear}-${String(dueMonth).padStart(2, '0')}-15T23:59:59+08:00`);
        const disputeEndsAt = new Date(Date.now() + BILL_DISPUTE_WINDOW_MS);
        const dueAt = billPaymentDueAt(scheduledDueAt, disputeEndsAt);
        for (const record of records) {
          const candidate = {
            merchantId: record.merchantId,
            period,
            verifiedAmountFen: Number(record.amount),
            serviceFeeFen: Number(record.fee),
            status: BillStatus.DISPUTE_WINDOW,
            invoiceStatus: InvoiceStatus.PENDING,
            invoiceNumber: null,
            disputeEndsAt,
            dueAt,
          };
          const inserted = await manager.createQueryBuilder().insert().into(MonthlyBill).values(candidate).orIgnore().returning(['id']).execute();
          const billId = inserted.identifiers[0]?.id as string | undefined;
          const bill = billId
            ? await manager.findOneByOrFail(MonthlyBill, { id: billId })
            : await manager.findOneByOrFail(MonthlyBill, { merchantId: record.merchantId, period });
          if (billId) {
            await this.auditWriter.write(user.id, bill.merchantId, 'MONTHLY_BILL_GENERATED', 'MonthlyBill', bill.id, null, { period: bill.period, verifiedAmountFen: bill.verifiedAmountFen, serviceFeeFen: bill.serviceFeeFen }, manager);
            await this.notificationAudience.merchantAdmins(manager, bill.merchantId, {
              eventType: 'MONTHLY_BILL_GENERATED',
              templateKey: 'monthly-bill-generated',
              merchantId: bill.merchantId,
              resourceType: 'MonthlyBill',
              resourceId: bill.id,
              payload: { billId: bill.id, merchantId: bill.merchantId, period: bill.period, verifiedAmountFen: bill.verifiedAmountFen, serviceFeeFen: bill.serviceFeeFen, disputeEndsAt: bill.disputeEndsAt, dueAt: bill.dueAt },
              dedupeKey: `monthly-bill:${bill.id}:generated`,
            });
          }
          bills.push(bill);
        }
        return bills;
      });
    } catch (error) {
      if (error instanceof BillGenerationInProgressError) return this.waitForMonthlyBills(period);
      if (!idempotencyKey || !requestHash || !isUniqueConstraintError(error)) throw error;
      const retried = await this.waitForMonthlyBillGenerationCommand(user.id, idempotencyKey);
      if (!retried) throw error;
      assertSameMonthlyBillGenerationCommand(retried, requestHash);
      return this.waitForMonthlyBills(period);
    }
  }

  async listBills(user: User, merchantId?: string): Promise<MonthlyBillListItem[]> {
    if (user.role === UserRole.STORE_STAFF) throw new ForbiddenException('核销员不可查看月结账单');
    const scope = await this.merchantScope.resolve(user, merchantId, [PlatformAccessProfile.FINANCE]);
    const records = await this.merchantScope.apply(scope, this.bills.createQueryBuilder('bill').orderBy('bill.period', 'DESC'), 'bill').getMany();
    if (!records.length) return [];
    const billIds = records.map((bill) => bill.id);
    const [disputes, paymentConfirmationRequests] = await Promise.all([
      this.disputes.findBy({ billId: In(billIds) }),
      this.paymentConfirmationRequests.find({ where: { billId: In(billIds) }, order: { createdAt: 'DESC', id: 'DESC' } }),
    ]);
    const disputesByBillId = new Map(disputes.map((dispute) => [dispute.billId, dispute]));
    const paymentConfirmationByBillId = new Map<string, BillPaymentConfirmationRequest>();
    for (const request of paymentConfirmationRequests) if (!paymentConfirmationByBillId.has(request.billId)) paymentConfirmationByBillId.set(request.billId, request);
    return records.map((bill) => ({
      ...bill,
      dispute: disputesByBillId.has(bill.id) ? billDisputeListItem(disputesByBillId.get(bill.id)!) : null,
      paymentConfirmationRequest: paymentConfirmationByBillId.has(bill.id) ? this.billPaymentConfirmationRequestListItemForUser(user, paymentConfirmationByBillId.get(bill.id)!) : null,
    }));
  }

  async createBillDispute(user: User, billId: string, content: string): Promise<BillDisputeListItem> {
    if (user.role !== UserRole.MERCHANT_ADMIN) throw new ForbiddenException('仅商家管理员可提交账单申诉');
    const statement = requiredText(content, '申诉说明', 1000);
    try {
      return await this.dataSource.transaction(async (manager) => {
        const bill = await manager.findOne(MonthlyBill, { where: { id: billId }, lock: { mode: 'pessimistic_write' } });
        if (!bill || bill.merchantId !== user.merchantId) throw new NotFoundException('账单不存在');
        if (bill.status !== BillStatus.DISPUTE_WINDOW || new Date(bill.disputeEndsAt) < new Date()) throw new BadRequestException('当前账单不在可申诉期限内');
        const existing = await manager.findOneBy(BillDispute, { billId });
        if (existing) throw new BadRequestException('该账单已有申诉记录');
        const dispute = await manager.save(BillDispute, {
          billId: bill.id,
          merchantId: bill.merchantId,
          submittedBy: user.id,
          content: statement,
          status: BillDisputeStatus.OPEN,
          resolutionNote: '',
          resolvedBy: null,
          resolvedAt: null,
        });
        const before = { status: bill.status, disputeEndsAt: bill.disputeEndsAt };
        bill.status = BillStatus.DISPUTED;
        await manager.save(MonthlyBill, bill);
        await this.auditWriter.write(user.id, bill.merchantId, 'BILL_DISPUTE_SUBMITTED', 'MonthlyBill', bill.id, before, { status: bill.status, disputeId: dispute.id }, manager);
        await this.notificationAudience.platformAdmins(manager, [PlatformAccessProfile.FINANCE], {
          eventType: 'BILL_DISPUTE_SUBMITTED',
          templateKey: 'bill-dispute-submitted',
          merchantId: bill.merchantId,
          resourceType: 'BillDispute',
          resourceId: dispute.id,
          payload: { billId: bill.id, disputeId: dispute.id, merchantId: bill.merchantId, period: bill.period },
          dedupeKey: `bill-dispute:${dispute.id}:submitted`,
        });
        return billDisputeListItem(dispute);
      });
    } catch (error) {
      if (!isUniqueConstraintError(error)) throw error;
      throw new BadRequestException('该账单已有申诉记录');
    }
  }

  async resolveBillDispute(user: User, billId: string, note: string): Promise<BillDisputeListItem> {
    this.merchantAccess.requirePlatformAccess(user, '处理账单申诉', [PlatformAccessProfile.FINANCE]);
    const resolutionNote = requiredText(note, '处理结论', 1000);
    return this.dataSource.transaction(async (manager) => {
      const bill = await manager.findOne(MonthlyBill, { where: { id: billId }, lock: { mode: 'pessimistic_write' } });
      if (!bill) throw new NotFoundException('账单不存在');
      if (bill.status !== BillStatus.DISPUTED) throw new BadRequestException('当前账单没有待处理申诉');
      const dispute = await manager.findOne(BillDispute, { where: { billId }, lock: { mode: 'pessimistic_write' } });
      if (!dispute || dispute.status !== BillDisputeStatus.OPEN) throw new ConflictException('账单申诉状态不一致，请联系平台处理');
      const resolvedAt = new Date();
      const before = { billStatus: bill.status, disputeStatus: dispute.status, dueAt: bill.dueAt };
      dispute.status = BillDisputeStatus.RESOLVED;
      dispute.resolutionNote = resolutionNote;
      dispute.resolvedBy = user.id;
      dispute.resolvedAt = resolvedAt;
      bill.status = BillStatus.CONFIRMED;
      bill.dueAt = billPaymentDueAt(bill.dueAt, resolvedAt);
      await manager.save(BillDispute, dispute);
      await manager.save(MonthlyBill, bill);
      await this.auditWriter.write(user.id, bill.merchantId, 'BILL_DISPUTE_RESOLVED', 'MonthlyBill', bill.id, before, { billStatus: bill.status, disputeStatus: dispute.status, dueAt: bill.dueAt, disputeId: dispute.id }, manager);
      await this.notificationAudience.merchantAdmins(manager, bill.merchantId, {
        eventType: 'BILL_DISPUTE_RESOLVED',
        templateKey: 'bill-dispute-resolved',
        merchantId: bill.merchantId,
        resourceType: 'BillDispute',
        resourceId: dispute.id,
        payload: { billId: bill.id, disputeId: dispute.id, billStatus: bill.status, dueAt: bill.dueAt },
        dedupeKey: `bill-dispute:${dispute.id}:resolved`,
      });
      return billDisputeListItem(dispute);
    });
  }

  async advanceBills(): Promise<BillLifecycleProgress> {
    return this.dataSource.transaction(async (manager) => {
      const now = new Date();
      const confirmed = await manager.find(MonthlyBill, { where: { status: BillStatus.DISPUTE_WINDOW, disputeEndsAt: LessThan(now) }, lock: { mode: 'pessimistic_write' } });
      for (const bill of confirmed) {
        bill.status = BillStatus.CONFIRMED;
        await manager.save(MonthlyBill, bill);
        await this.auditWriter.write('system', bill.merchantId, 'BILL_DISPUTE_WINDOW_CLOSED', 'MonthlyBill', bill.id, { status: BillStatus.DISPUTE_WINDOW }, { status: BillStatus.CONFIRMED }, manager);
        await this.notificationAudience.merchantAdmins(manager, bill.merchantId, {
          eventType: 'BILL_CONFIRMED',
          templateKey: 'bill-confirmed',
          merchantId: bill.merchantId,
          resourceType: 'MonthlyBill',
          resourceId: bill.id,
          payload: { billId: bill.id, period: bill.period, status: bill.status, dueAt: bill.dueAt },
          dedupeKey: `monthly-bill:${bill.id}:confirmed`,
        });
      }
      const overdue = await manager.find(MonthlyBill, { where: { status: BillStatus.CONFIRMED, dueAt: LessThan(now) }, lock: { mode: 'pessimistic_write' } });
      for (const bill of overdue) {
        bill.status = BillStatus.OVERDUE;
        await manager.save(MonthlyBill, bill);
        await this.auditWriter.write('system', bill.merchantId, 'BILL_OVERDUE', 'MonthlyBill', bill.id, { status: BillStatus.CONFIRMED }, { status: BillStatus.OVERDUE }, manager);
        await this.notificationAudience.merchantAdmins(manager, bill.merchantId, {
          eventType: 'BILL_OVERDUE',
          templateKey: 'bill-overdue',
          merchantId: bill.merchantId,
          resourceType: 'MonthlyBill',
          resourceId: bill.id,
          payload: { billId: bill.id, period: bill.period, status: bill.status, dueAt: bill.dueAt },
          dedupeKey: `monthly-bill:${bill.id}:overdue`,
        });
      }
      // A bill is operational evidence only. SaaS/agency cooperation fees are
      // settled offline, so an overdue record must not silently pause a
      // merchant's customer-facing sales or existing voucher fulfilment.
      return { confirmed: confirmed.length, overdue: overdue.length, suspendedForOverdueBills: 0 };
    });
  }

  async updateBillInvoice(user: User, billId: string, invoiceStatus: InvoiceStatus, invoiceNumber?: string): Promise<MonthlyBill> {
    // FIX: 恢复本地开票记录维护（与月结账单恢复配套，此前误停用）。
    this.merchantAccess.requirePlatformAccess(user, '维护开票记录', [PlatformAccessProfile.FINANCE]);
    return this.dataSource.transaction(async (manager) => {
      const bill = await manager.findOne(MonthlyBill, { where: { id: billId }, lock: { mode: 'pessimistic_write' } });
      if (!bill) throw new NotFoundException('账单不存在');
      if (bill.status !== BillStatus.PAID) throw new BadRequestException('确认收款后才能维护开票记录');
      const requestedNumber = invoiceNumber === undefined ? bill.invoiceNumber : optionalText(invoiceNumber, '发票号码', 100) || null;
      if (invoiceStatus === InvoiceStatus.ISSUED && !requestedNumber) throw new BadRequestException('标记已开票时必须填写发票号码');
      const before = { invoiceStatus: bill.invoiceStatus, invoiceNumber: bill.invoiceNumber };
      bill.invoiceStatus = invoiceStatus;
      bill.invoiceNumber = invoiceStatus === InvoiceStatus.ISSUED ? requestedNumber : null;
      const saved = await manager.save(MonthlyBill, bill);
      await this.auditWriter.write(user.id, saved.merchantId, 'BILL_INVOICE_UPDATED', 'MonthlyBill', saved.id, before, { invoiceStatus: saved.invoiceStatus, invoiceNumber: saved.invoiceNumber }, manager);
      return saved;
    });
  }

  private billPaymentConfirmationRequestListItemForUser(user: User, request: BillPaymentConfirmationRequest): BillPaymentConfirmationRequestListItem | RestrictedBillPaymentConfirmationRequestListItem {
    const platformProfile = user.role === UserRole.PLATFORM_ADMIN ? this.merchantAccess.profile(user) : null;
    if (platformProfile === PlatformAccessProfile.SYSTEM_ADMIN || platformProfile === PlatformAccessProfile.FINANCE) return billPaymentConfirmationRequestListItem(request);
    return { id: request.id, status: request.status, createdAt: request.createdAt, reviewedAt: request.reviewedAt, updatedAt: request.updatedAt };
  }
  private async monthlyBillGenerationCommandForRetry(manager: EntityManager, requestedBy: string, idempotencyKey: string): Promise<MonthlyBillGenerationCommand | null> {
    return manager.getRepository(MonthlyBillGenerationCommand).createQueryBuilder('command').addSelect(['command.idempotencyKey', 'command.requestHash']).where('command.requestedBy = :requestedBy AND command.idempotencyKey = :idempotencyKey', { requestedBy, idempotencyKey }).getOne();
  }
  private monthlyBillsForPeriod(manager: EntityManager, period: string): Promise<MonthlyBill[]> { return manager.find(MonthlyBill, { where: { period }, order: { merchantId: 'ASC', id: 'ASC' } }); }
  private async waitForMonthlyBillGenerationCommand(requestedBy: string, idempotencyKey: string): Promise<MonthlyBillGenerationCommand | null> {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const command = await this.monthlyBillGenerationCommandForRetry(this.dataSource.manager, requestedBy, idempotencyKey);
      if (command) return command;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    return null;
  }
  private async waitForMonthlyBills(period: string): Promise<MonthlyBill[]> {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const bills = await this.monthlyBillsForPeriod(this.dataSource.manager, period);
      if (bills.length) return bills;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    return this.monthlyBillsForPeriod(this.dataSource.manager, period);
  }
}
