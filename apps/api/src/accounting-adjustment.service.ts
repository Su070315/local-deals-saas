import { BadRequestException, ConflictException, GoneException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash } from 'crypto';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { AccountingAdjustmentStatus, BillAdjustment, BillStatus, MonthlyBill, PlatformAccessProfile, SettlementLedgerEntry, User } from './domain/entities';
import { AuditWriterService } from './audit-writer.service';
import { MerchantAccessService } from './merchant-access.service';

export type BillAdjustmentInput = { verifiedAmountDeltaFen: number; serviceFeeDeltaFen: number; reasonCode: string; note: string; reversalOfId?: string | null };
export type BillAdjustmentView = Omit<BillAdjustment, 'idempotencyKey' | 'requestHash'>;
export type BillBalanceCheck = {
  billId: string; merchantId: string; period: string; balanced: boolean;
  ledgerVerifiedAmountFen: number; ledgerServiceFeeFen: number;
  adjustmentVerifiedAmountFen: number; adjustmentServiceFeeFen: number;
  expectedVerifiedAmountFen: number; expectedServiceFeeFen: number;
  differenceVerifiedAmountFen: number; differenceServiceFeeFen: number;
};

@Injectable()
export class AccountingAdjustmentService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly merchantAccess: MerchantAccessService,
    private readonly auditWriter: AuditWriterService,
    @InjectRepository(MonthlyBill) private readonly bills: Repository<MonthlyBill>,
    @InjectRepository(BillAdjustment) private readonly adjustments: Repository<BillAdjustment>,
    @InjectRepository(SettlementLedgerEntry) private readonly ledger: Repository<SettlementLedgerEntry>,
  ) {}

  async requestAdjustment(user: User, billId: string, input: BillAdjustmentInput, rawIdempotencyKey: string): Promise<BillAdjustmentView> {
    void user; void billId; void input; void rawIdempotencyKey;
    throw new GoneException('本地服务费账务调整已停用，系统只展示支付服务商同步结果。');
    /*
    this.merchantAccess.requirePlatformAccess(user, '提交账务调整', [PlatformAccessProfile.FINANCE]);
    const values = this.normalizeInput(input);
    const idempotencyKey = this.requiredKey(rawIdempotencyKey);
    const requestHash = this.requestHash(billId, values);
    try {
      return await this.dataSource.transaction(async (manager) => {
        const retried = await this.retryRecord(manager, billId, user.id, idempotencyKey);
        if (retried) { this.assertSameRequest(retried, requestHash); return this.safeAdjustment(retried); }
        const bill = await this.lockBill(manager, billId);
        this.assertAdjustable(bill);
        const adjustment = await manager.save(BillAdjustment, {
          billId: bill.id, merchantId: bill.merchantId, period: bill.period, ...values,
          status: AccountingAdjustmentStatus.PENDING_REVIEW, requestedBy: user.id, reviewedBy: null,
          reviewNote: '', reviewedAt: null, reversalOfId: values.reversalOfId || null, postedAt: null,
          idempotencyKey, requestHash,
        });
        await this.auditWriter.write(user.id, bill.merchantId, 'BILL_ADJUSTMENT_REQUESTED', 'BillAdjustment', adjustment.id, null, {
          billId: bill.id, period: bill.period, verifiedAmountDeltaFen: adjustment.verifiedAmountDeltaFen,
          serviceFeeDeltaFen: adjustment.serviceFeeDeltaFen, reasonCode: adjustment.reasonCode, reversalOfId: adjustment.reversalOfId,
        }, manager);
        return this.safeAdjustment(adjustment);
      });
    } catch (error) {
      const retried = await this.retryRecord(this.dataSource.manager, billId, user.id, idempotencyKey);
      if (retried) { this.assertSameRequest(retried, requestHash); return this.safeAdjustment(retried); }
      if (this.isUniqueConstraintError(error)) throw new ConflictException('该账务调整请求已存在，请刷新后重试');
      throw error;
    } */
  }

  async requestReversal(user: User, adjustmentId: string, note: string, rawIdempotencyKey: string): Promise<BillAdjustmentView> {
    void user; void adjustmentId; void note; void rawIdempotencyKey;
    throw new GoneException('本地服务费账务冲正已停用，系统只展示支付服务商同步结果。');
    /*
    this.merchantAccess.requirePlatformAccess(user, '提交账务冲正', [PlatformAccessProfile.FINANCE]);
    const idempotencyKey = this.requiredKey(rawIdempotencyKey);
    const normalizedNote = this.requiredText(note, '冲正说明', 1000);
    try {
      return await this.dataSource.transaction(async (manager) => {
        const original = await manager.findOne(BillAdjustment, { where: { id: adjustmentId }, lock: { mode: 'pessimistic_write' } });
        if (!original) throw new NotFoundException('账务调整不存在');
        const values = { verifiedAmountDeltaFen: -original.verifiedAmountDeltaFen, serviceFeeDeltaFen: -original.serviceFeeDeltaFen, reasonCode: 'REVERSAL', note: normalizedNote, reversalOfId: original.id };
        const requestHash = this.requestHash(original.billId, values);
        const retried = await this.retryRecord(manager, original.billId, user.id, idempotencyKey);
        if (retried) { this.assertSameRequest(retried, requestHash); return this.safeAdjustment(retried); }
        if (original.status !== AccountingAdjustmentStatus.POSTED) throw new BadRequestException('仅已入账的调整可以冲正');
        const existing = await manager.findOneBy(BillAdjustment, { reversalOfId: original.id });
        if (existing) throw new ConflictException('该账务调整已经提交过冲正');
        const bill = await this.lockBill(manager, original.billId);
        this.assertAdjustable(bill);
        const reversal = await manager.save(BillAdjustment, {
          billId: bill.id, merchantId: bill.merchantId, period: bill.period, ...values,
          status: AccountingAdjustmentStatus.PENDING_REVIEW, requestedBy: user.id, reviewedBy: null,
          reviewNote: '', reviewedAt: null, postedAt: null, idempotencyKey, requestHash,
        });
        await this.auditWriter.write(user.id, bill.merchantId, 'BILL_ADJUSTMENT_REVERSAL_REQUESTED', 'BillAdjustment', reversal.id, null, { originalAdjustmentId: original.id, note: normalizedNote }, manager);
        return this.safeAdjustment(reversal);
      });
    } catch (error) {
      const original = await this.adjustments.findOneBy({ id: adjustmentId });
      if (original) {
        const values = { verifiedAmountDeltaFen: -original.verifiedAmountDeltaFen, serviceFeeDeltaFen: -original.serviceFeeDeltaFen, reasonCode: 'REVERSAL', note: normalizedNote, reversalOfId: original.id };
        const retried = await this.retryRecord(this.dataSource.manager, original.billId, user.id, idempotencyKey);
        if (retried) { this.assertSameRequest(retried, this.requestHash(original.billId, values)); return this.safeAdjustment(retried); }
      }
      if (this.isUniqueConstraintError(error)) throw new ConflictException('该账务冲正请求已存在，请刷新后重试');
      throw error;
    } */
  }

  async listAdjustments(user: User, billId: string): Promise<BillAdjustmentView[]> {
    this.merchantAccess.requirePlatformAccess(user, '查看账务调整', [PlatformAccessProfile.FINANCE]);
    const bill = await this.bills.findOneBy({ id: billId });
    if (!bill) throw new NotFoundException('账单不存在');
    return (await this.adjustments.find({ where: { billId }, order: { createdAt: 'DESC', id: 'DESC' } })).map((item) => this.safeAdjustment(item));
  }

  async reviewAdjustment(user: User, adjustmentId: string, approved: boolean, note: string): Promise<BillAdjustmentView> {
    void user; void adjustmentId; void approved; void note;
    throw new GoneException('本地服务费账务复核已停用，系统只展示支付服务商同步结果。');
    /*
    this.merchantAccess.requirePlatformAccess(user, approved ? '复核账务调整' : '驳回账务调整', [PlatformAccessProfile.FINANCE]);
    const reviewNote = this.requiredText(note, approved ? '调整复核结论' : '调整驳回说明', 1000);
    return this.dataSource.transaction(async (manager) => {
      const adjustment = await manager.findOne(BillAdjustment, { where: { id: adjustmentId }, lock: { mode: 'pessimistic_write' } });
      if (!adjustment) throw new NotFoundException('账务调整不存在');
      if (adjustment.status !== AccountingAdjustmentStatus.PENDING_REVIEW) throw new ConflictException('该账务调整已经处理');
      if (adjustment.requestedBy === user.id) throw new ForbiddenException('账务调整必须由不同财务账号复核');
      const bill = await this.lockBill(manager, adjustment.billId);
      this.assertAdjustable(bill);
      const before = { status: adjustment.status, billStatus: bill.status, verifiedAmountFen: bill.verifiedAmountFen, serviceFeeFen: bill.serviceFeeFen, adjustmentVersion: bill.adjustmentVersion };
      adjustment.reviewedBy = user.id;
      adjustment.reviewNote = reviewNote;
      adjustment.reviewedAt = new Date();
      if (!approved) {
        adjustment.status = AccountingAdjustmentStatus.REJECTED;
        const saved = await manager.save(BillAdjustment, adjustment);
        await this.auditWriter.write(user.id, bill.merchantId, 'BILL_ADJUSTMENT_REJECTED', 'BillAdjustment', saved.id, before, { status: saved.status, reviewNote }, manager);
        return this.safeAdjustment(saved);
      }
      const nextVerified = bill.verifiedAmountFen + adjustment.verifiedAmountDeltaFen;
      const nextFee = bill.serviceFeeFen + adjustment.serviceFeeDeltaFen;
      if (nextVerified < 0 || nextFee < 0 || nextFee > nextVerified) throw new BadRequestException('调整后账单金额不平衡，不能入账');
      adjustment.status = AccountingAdjustmentStatus.POSTED;
      adjustment.postedAt = new Date();
      bill.verifiedAmountFen = nextVerified;
      bill.serviceFeeFen = nextFee;
      bill.adjustmentVersion += 1;
      const [savedAdjustment, savedBill] = await Promise.all([manager.save(BillAdjustment, adjustment), manager.save(MonthlyBill, bill)]);
      await this.auditWriter.write(user.id, bill.merchantId, 'BILL_ADJUSTMENT_POSTED', 'BillAdjustment', savedAdjustment.id, before, { status: savedAdjustment.status, reviewNote, billId: savedBill.id, billVerifiedAmountFen: savedBill.verifiedAmountFen, billServiceFeeFen: savedBill.serviceFeeFen, adjustmentVersion: savedBill.adjustmentVersion }, manager);
      await this.auditWriter.write(user.id, bill.merchantId, 'MONTHLY_BILL_ADJUSTED', 'MonthlyBill', savedBill.id, before, { verifiedAmountFen: savedBill.verifiedAmountFen, serviceFeeFen: savedBill.serviceFeeFen, adjustmentId: savedAdjustment.id, adjustmentVersion: savedBill.adjustmentVersion }, manager);
      if (savedAdjustment.reversalOfId) await manager.update(BillAdjustment, { id: savedAdjustment.reversalOfId }, { status: AccountingAdjustmentStatus.REVERSED });
      return this.safeAdjustment(savedAdjustment);
    }); */
  }

  async balanceCheck(user: User, billId: string): Promise<BillBalanceCheck> {
    this.merchantAccess.requirePlatformAccess(user, '检查账单平衡', [PlatformAccessProfile.FINANCE]);
    const bill = await this.bills.findOneBy({ id: billId });
    if (!bill) throw new NotFoundException('账单不存在');
    const { start, end } = this.billingPeriodRange(bill.period);
    const ledger = await this.ledger.createQueryBuilder('entry').select('COALESCE(SUM(entry.verifiedAmountFen), 0)', 'verified').addSelect('COALESCE(SUM(entry.serviceFeeFen), 0)', 'fee').where('entry.merchantId = :merchantId AND entry.occurredAt >= :start AND entry.occurredAt < :end', { merchantId: bill.merchantId, start, end }).getRawOne<{ verified: string; fee: string }>();
    const adjustments = await this.adjustments.createQueryBuilder('adjustment').select('COALESCE(SUM(adjustment.verifiedAmountDeltaFen), 0)', 'verified').addSelect('COALESCE(SUM(adjustment.serviceFeeDeltaFen), 0)', 'fee').where('adjustment.billId = :billId AND adjustment.status IN (:...statuses)', { billId, statuses: [AccountingAdjustmentStatus.POSTED, AccountingAdjustmentStatus.REVERSED] }).getRawOne<{ verified: string; fee: string }>();
    const ledgerVerified = Number(ledger?.verified || 0);
    const ledgerFee = Number(ledger?.fee || 0);
    const adjustmentVerified = Number(adjustments?.verified || 0);
    const adjustmentFee = Number(adjustments?.fee || 0);
    const differenceVerified = bill.verifiedAmountFen - ledgerVerified - adjustmentVerified;
    const differenceFee = bill.serviceFeeFen - ledgerFee - adjustmentFee;
    return { billId: bill.id, merchantId: bill.merchantId, period: bill.period, balanced: differenceVerified === 0 && differenceFee === 0, ledgerVerifiedAmountFen: ledgerVerified, ledgerServiceFeeFen: ledgerFee, adjustmentVerifiedAmountFen: adjustmentVerified, adjustmentServiceFeeFen: adjustmentFee, expectedVerifiedAmountFen: bill.verifiedAmountFen, expectedServiceFeeFen: bill.serviceFeeFen, differenceVerifiedAmountFen: differenceVerified, differenceServiceFeeFen: differenceFee };
  }

  private async lockBill(manager: EntityManager, billId: string): Promise<MonthlyBill> {
    const bill = await manager.findOne(MonthlyBill, { where: { id: billId }, lock: { mode: 'pessimistic_write' } });
    if (!bill) throw new NotFoundException('账单不存在');
    return bill;
  }
  private assertAdjustable(bill: MonthlyBill): void {
    if (bill.accountingLockedAt || bill.status === BillStatus.PAID) throw new ConflictException('账期已锁定，只能通过新的合规账期处理，不能直接调整');
    if (bill.status === BillStatus.DRAFT) throw new BadRequestException('草稿账单不能提交账务调整');
  }
  private normalizeInput(input: BillAdjustmentInput): BillAdjustmentInput {
    const verified = this.requiredInteger(input.verifiedAmountDeltaFen, '核销金额调整', -1_000_000_000, 1_000_000_000);
    const fee = this.requiredInteger(input.serviceFeeDeltaFen, '服务费调整', -1_000_000_000, 1_000_000_000);
    if (verified === 0 && fee === 0) throw new BadRequestException('核销金额和服务费调整不能同时为 0');
    const reasonCode = this.requiredText(input.reasonCode, '差异原因分类', 60).toUpperCase();
    if (!/^[A-Z0-9_]+$/.test(reasonCode)) throw new BadRequestException('差异原因分类只能包含大写字母、数字和下划线');
    return { verifiedAmountDeltaFen: verified, serviceFeeDeltaFen: fee, reasonCode, note: this.requiredText(input.note, '调整说明', 1000), reversalOfId: input.reversalOfId || null };
  }
  private requiredKey(value: unknown): string { const key = this.requiredText(value, '账务请求标识', 128); if (!/^[A-Za-z0-9_-]{12,128}$/.test(key)) throw new BadRequestException('账务请求标识格式不正确'); return key; }
  private requestHash(billId: string, input: BillAdjustmentInput): string { return createHash('sha256').update(JSON.stringify({ billId, ...input })).digest('hex'); }
  private async retryRecord(manager: EntityManager, billId: string, requestedBy: string, idempotencyKey: string): Promise<BillAdjustment | null> { return manager.getRepository(BillAdjustment).createQueryBuilder('adjustment').addSelect(['adjustment.idempotencyKey', 'adjustment.requestHash']).where('adjustment.billId = :billId AND adjustment.requestedBy = :requestedBy AND adjustment.idempotencyKey = :idempotencyKey', { billId, requestedBy, idempotencyKey }).getOne(); }
  private assertSameRequest(record: BillAdjustment, requestHash: string): void { if (record.requestHash !== requestHash) throw new ConflictException('账务请求标识已用于其他内容，请刷新后重试'); }
  private safeAdjustment(adjustment: BillAdjustment): BillAdjustmentView { const { idempotencyKey: _idempotencyKey, requestHash: _requestHash, ...safe } = adjustment; return safe; }
  private requiredText(value: unknown, label: string, maxLength: number): string { if (typeof value !== 'string') throw new BadRequestException(`${label}格式不正确`); const normalized = value.trim(); if (!normalized || normalized.length > maxLength) throw new BadRequestException(`${label}不能为空且不能超过 ${maxLength} 个字符`); return normalized; }
  private requiredInteger(value: unknown, label: string, min: number, max: number): number { const number = Number(value); if (!Number.isSafeInteger(number) || number < min || number > max) throw new BadRequestException(`${label}必须为 ${min} 至 ${max} 的整数`); return number; }
  private billingPeriodRange(period: string): { start: Date; end: Date } { const [year, month] = period.split('-').map(Number); const nextYear = month === 12 ? year + 1 : year; const nextMonth = month === 12 ? 1 : month + 1; return { start: new Date(`${period}-01T00:00:00+08:00`), end: new Date(`${nextYear}-${String(nextMonth).padStart(2, '0')}-01T00:00:00+08:00`) }; }
  private isUniqueConstraintError(error: unknown): boolean { return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === '23505'; }
}
