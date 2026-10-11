import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, In, Repository } from 'typeorm';
import {
  BillPaymentConfirmationRequest,
  BillPaymentConfirmationRequestStatus,
  BillStatus,
  Merchant,
  MonthlyBill,
  PlatformAccessProfile,
  User,
} from './domain/entities';
import { AuditWriterService } from './audit-writer.service';
import { MerchantAccessService } from './merchant-access.service';
import { NotificationAudienceService } from './notifications/notification-audience.service';
import {
  assertSameBillPaymentConfirmationRetry,
  billPaymentConfirmationRequestHash,
  billPaymentConfirmationRequestListItem,
  isUniqueConstraintError,
  requiredText,
} from './billing-policy';

export type BillPaymentConfirmationRequestListItem = Omit<BillPaymentConfirmationRequest, 'idempotencyKey' | 'requestHash'>;
export type PlatformBillPaymentConfirmationRequestListItem = BillPaymentConfirmationRequestListItem & {
  merchantBrandName: string;
  billPeriod: string;
  serviceFeeFen: number;
  billStatus: BillStatus;
};

@Injectable()
export class BillPaymentConfirmationService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly auditWriter: AuditWriterService,
    private readonly merchantAccess: MerchantAccessService,
    private readonly notificationAudience: NotificationAudienceService,
    @InjectRepository(Merchant) private readonly merchants: Repository<Merchant>,
    @InjectRepository(MonthlyBill) private readonly bills: Repository<MonthlyBill>,
    @InjectRepository(BillPaymentConfirmationRequest) private readonly requests: Repository<BillPaymentConfirmationRequest>,
  ) {}

  async request(user: User, billId: string, input: { paymentReference: string; note: string }, rawIdempotencyKey?: string): Promise<BillPaymentConfirmationRequestListItem> {
    // FIX: 恢复本地人工收款确认（此前被误停用，见 2026-08-09 排查记录；平台服务费无外部渠道代收）。
    this.merchantAccess.requirePlatformAccess(user, '提交账单收款确认', [PlatformAccessProfile.FINANCE]);
    const paymentReference = requiredText(input.paymentReference, '银行流水或对账参考号', 100);
    const note = requiredText(input.note, '收款核对说明', 1000);
    const idempotencyKey = requiredText(rawIdempotencyKey, '收款确认请求标识', 128);
    if (!/^[A-Za-z0-9_-]{12,128}$/.test(idempotencyKey)) throw new BadRequestException('收款确认请求标识格式不正确');
    const requestHash = billPaymentConfirmationRequestHash({ billId, paymentReference, note });
    try {
      return await this.dataSource.transaction(async (manager) => {
        const retried = await this.requestForRetry(manager, billId, user.id, idempotencyKey);
        if (retried) {
          assertSameBillPaymentConfirmationRetry(retried, requestHash);
          return billPaymentConfirmationRequestListItem(retried);
        }
        const bill = await manager.findOne(MonthlyBill, { where: { id: billId }, lock: { mode: 'pessimistic_write' } });
        if (!bill) throw new NotFoundException('账单不存在');
        if (![BillStatus.CONFIRMED, BillStatus.OVERDUE].includes(bill.status)) throw new BadRequestException('当前账单状态不能提交收款确认');
        const pending = await manager.findOneBy(BillPaymentConfirmationRequest, { billId, status: BillPaymentConfirmationRequestStatus.PENDING_REVIEW });
        if (pending) throw new ConflictException('该账单已有待复核的收款确认请求');
        const duplicateReference = await manager.findOne(BillPaymentConfirmationRequest, {
          where: { paymentReference, status: In([BillPaymentConfirmationRequestStatus.PENDING_REVIEW, BillPaymentConfirmationRequestStatus.APPROVED]) },
          lock: { mode: 'pessimistic_write' },
        });
        if (duplicateReference) throw new ConflictException('该银行流水或对账参考号已用于其他待审或已确认收款');
        const confirmation = await manager.save(BillPaymentConfirmationRequest, {
          billId: bill.id, merchantId: bill.merchantId, requestedBy: user.id, paymentReference, note,
          status: BillPaymentConfirmationRequestStatus.PENDING_REVIEW, idempotencyKey, requestHash,
          reviewedBy: null, reviewNote: '', reviewedAt: null,
        });
        await this.auditWriter.write(user.id, bill.merchantId, 'BILL_PAYMENT_CONFIRMATION_REQUESTED', 'BillPaymentConfirmationRequest', confirmation.id, null, { billId: bill.id, paymentReference, note }, manager);
        await this.notificationAudience.platformAdmins(manager, [PlatformAccessProfile.FINANCE], {
          eventType: 'BILL_PAYMENT_CONFIRMATION_REQUESTED', templateKey: 'bill-payment-confirmation-requested',
          merchantId: bill.merchantId, resourceType: 'BillPaymentConfirmationRequest', resourceId: confirmation.id,
          payload: { billId: bill.id, requestId: confirmation.id, merchantId: bill.merchantId, period: bill.period, status: confirmation.status },
          dedupeKey: `bill-payment-confirmation:${confirmation.id}:requested`,
        });
        return billPaymentConfirmationRequestListItem(confirmation);
      });
    } catch (error) {
      const retried = await this.requestForRetry(this.dataSource.manager, billId, user.id, idempotencyKey);
      if (retried) {
        assertSameBillPaymentConfirmationRetry(retried, requestHash);
        return billPaymentConfirmationRequestListItem(retried);
      }
      if (isUniqueConstraintError(error)) throw new ConflictException('该账单已有待复核收款确认请求，请刷新后重试');
      throw error;
    }
  }

  async listForBill(user: User, billId: string): Promise<BillPaymentConfirmationRequestListItem[]> {
    this.merchantAccess.requirePlatformAccess(user, '查看账单收款确认请求', [PlatformAccessProfile.FINANCE]);
    const bill = await this.bills.findOneBy({ id: billId });
    if (!bill) throw new NotFoundException('账单不存在');
    return (await this.requests.find({ where: { billId }, order: { createdAt: 'DESC', id: 'DESC' }, take: 100 })).map(billPaymentConfirmationRequestListItem);
  }

  async listPlatformQueue(user: User): Promise<PlatformBillPaymentConfirmationRequestListItem[]> {
    this.merchantAccess.requirePlatformAccess(user, '查看平台收款复核队列', [PlatformAccessProfile.FINANCE]);
    const requests = await this.requests.find({ order: { createdAt: 'DESC', id: 'DESC' }, take: 200 });
    if (!requests.length) return [];
    const [merchants, bills] = await Promise.all([
      this.merchants.find({ where: { id: In([...new Set(requests.map((request) => request.merchantId))]) }, select: { id: true, brandName: true } }),
      this.bills.find({ where: { id: In([...new Set(requests.map((request) => request.billId))]) }, select: { id: true, period: true, serviceFeeFen: true, status: true } }),
    ]);
    const merchantNames = new Map(merchants.map((merchant) => [merchant.id, merchant.brandName]));
    const billsById = new Map(bills.map((bill) => [bill.id, bill]));
    return requests.map((request) => {
      const bill = billsById.get(request.billId);
      return { ...billPaymentConfirmationRequestListItem(request), merchantBrandName: merchantNames.get(request.merchantId) || '已归档商家', billPeriod: bill?.period || '已归档账期', serviceFeeFen: bill?.serviceFeeFen || 0, billStatus: bill?.status || BillStatus.DRAFT };
    });
  }

  async review(user: User, billId: string, requestId: string, approved: boolean, note: string): Promise<BillPaymentConfirmationRequestListItem> {
    // FIX: 恢复本地人工收款复核（与 request 恢复配套）。
    this.merchantAccess.requirePlatformAccess(user, approved ? '复核账单收款确认' : '驳回账单收款确认', [PlatformAccessProfile.FINANCE]);
    const reviewNote = requiredText(note, approved ? '收款复核结论' : '收款驳回说明', 1000);
    return this.dataSource.transaction(async (manager) => {
      const confirmation = await manager.findOne(BillPaymentConfirmationRequest, { where: { id: requestId, billId }, lock: { mode: 'pessimistic_write' } });
      if (!confirmation) throw new NotFoundException('收款确认请求不存在');
      if (confirmation.status !== BillPaymentConfirmationRequestStatus.PENDING_REVIEW) throw new ConflictException('该收款确认请求已处理');
      if (confirmation.requestedBy === user.id) throw new ForbiddenException('收款确认必须由不同财务账号复核');
      const bill = await manager.findOne(MonthlyBill, { where: { id: billId }, lock: { mode: 'pessimistic_write' } });
      if (!bill) throw new NotFoundException('账单不存在');
      if (!approved) {
        confirmation.status = BillPaymentConfirmationRequestStatus.REJECTED;
        confirmation.reviewedBy = user.id;
        confirmation.reviewNote = reviewNote;
        confirmation.reviewedAt = new Date();
        const saved = await manager.save(BillPaymentConfirmationRequest, confirmation);
        await this.auditWriter.write(user.id, bill.merchantId, 'BILL_PAYMENT_CONFIRMATION_REJECTED', 'BillPaymentConfirmationRequest', saved.id, { status: BillPaymentConfirmationRequestStatus.PENDING_REVIEW }, { status: saved.status, reviewNote }, manager);
        await this.notificationAudience.merchantAdmins(manager, bill.merchantId, {
          eventType: 'BILL_PAYMENT_CONFIRMATION_REJECTED', templateKey: 'bill-payment-confirmation-rejected',
          merchantId: bill.merchantId, resourceType: 'BillPaymentConfirmationRequest', resourceId: saved.id,
          payload: { billId: bill.id, requestId: saved.id, status: saved.status },
          dedupeKey: `bill-payment-confirmation:${saved.id}:rejected`,
        });
        return billPaymentConfirmationRequestListItem(saved);
      }
      if (![BillStatus.CONFIRMED, BillStatus.OVERDUE].includes(bill.status)) throw new ConflictException('账单状态已变化，不能确认收款');
      const before = { status: bill.status, invoiceStatus: bill.invoiceStatus, invoiceNumber: bill.invoiceNumber, accountingLockedAt: bill.accountingLockedAt, accountingLockedBy: bill.accountingLockedBy };
      bill.status = BillStatus.PAID;
      bill.accountingLockedAt = new Date();
      bill.accountingLockedBy = user.id;
      confirmation.status = BillPaymentConfirmationRequestStatus.APPROVED;
      confirmation.reviewedBy = user.id;
      confirmation.reviewNote = reviewNote;
      confirmation.reviewedAt = new Date();
      const [savedRequest, savedBill] = await Promise.all([manager.save(BillPaymentConfirmationRequest, confirmation), manager.save(MonthlyBill, bill)]);
      await this.auditWriter.write(user.id, savedBill.merchantId, 'BILL_PAYMENT_CONFIRMATION_APPROVED', 'BillPaymentConfirmationRequest', savedRequest.id, { status: BillPaymentConfirmationRequestStatus.PENDING_REVIEW }, { status: savedRequest.status, reviewNote, billStatus: savedBill.status }, manager);
      await this.auditWriter.write(user.id, savedBill.merchantId, 'BILL_PAYMENT_CONFIRMED', 'MonthlyBill', savedBill.id, before, { status: savedBill.status, invoiceStatus: savedBill.invoiceStatus, invoiceNumber: savedBill.invoiceNumber, accountingLockedAt: savedBill.accountingLockedAt, accountingLockedBy: savedBill.accountingLockedBy, paymentConfirmationRequestId: savedRequest.id, paymentReference: savedRequest.paymentReference }, manager);
      await this.notificationAudience.merchantAdmins(manager, savedBill.merchantId, {
        eventType: 'BILL_PAYMENT_CONFIRMED', templateKey: 'bill-payment-confirmed', merchantId: savedBill.merchantId,
        resourceType: 'MonthlyBill', resourceId: savedBill.id,
        payload: { billId: savedBill.id, requestId: savedRequest.id, period: savedBill.period, status: savedBill.status },
        dedupeKey: `monthly-bill:${savedBill.id}:payment-confirmed`,
      });
      return billPaymentConfirmationRequestListItem(savedRequest);
    });
  }

  private async requestForRetry(manager: EntityManager, billId: string, requestedBy: string, idempotencyKey: string): Promise<BillPaymentConfirmationRequest | null> {
    return manager.getRepository(BillPaymentConfirmationRequest).createQueryBuilder('request').addSelect(['request.idempotencyKey', 'request.requestHash']).where('request.billId = :billId AND request.requestedBy = :requestedBy AND request.idempotencyKey = :idempotencyKey', { billId, requestedBy, idempotencyKey }).getOne();
  }
}
