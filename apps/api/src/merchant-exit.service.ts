import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, In, LessThanOrEqual, MoreThanOrEqual, Not, Repository } from 'typeorm';
import {
  BillStatus, Merchant, MerchantExitCase, MerchantExitCaseStatus, MerchantRegistration, MerchantStatus, MonthlyBill, Order, OrderStatus,
  PlatformAccessProfile, Refund, SupportTicket, SupportTicketStatus, User, UserRole, Voucher, VoucherStatus,
} from './domain/entities';
import { AuditWriterService } from './audit-writer.service';
import { MerchantAccessService } from './merchant-access.service';
import { AgencyCooperationService } from './agency-cooperation.service';
import { WechatOnboardingEntitlementEventType } from './domain/wechat-onboarding-entitlement.entities';

export type MerchantExitReadiness = {
  merchantId: string;
  status: MerchantStatus;
  readyToClose: boolean;
  blockers: { pendingOrders: number; activeVouchers: number; unresolvedRefunds: number; openSupportTickets: number; unsettledBills: number };
};
export type MerchantExitCaseView = Pick<MerchantExitCase, 'id' | 'merchantId' | 'status' | 'salesPausedAt' | 'fulfillmentStartedAt' | 'exportReadyAt' | 'dataExportConfirmedAt' | 'authorizationRevocationAcknowledgedAt' | 'closedAt' | 'purgeEligibleAt' | 'createdAt' | 'updatedAt'> & {
  dataExportConfirmed: boolean;
  authorizationRevocationAcknowledged: boolean;
  retentionPolicyReference?: string;
  retentionUntil?: Date | null;
};

@Injectable()
export class MerchantExitService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly auditWriter: AuditWriterService,
    private readonly merchantAccess: MerchantAccessService,
    private readonly agencyCooperation: AgencyCooperationService,
    @InjectRepository(MerchantExitCase) private readonly exitCases: Repository<MerchantExitCase>,
  ) {}

  async prepareStatusTransition(manager: EntityManager, user: User, merchant: Merchant, targetStatus: MerchantStatus, statusChanged: boolean, statusReason: string): Promise<MerchantExitCase | null> {
    if (merchant.status === MerchantStatus.CLOSED && targetStatus !== MerchantStatus.CLOSED) throw new BadRequestException('已退出经营的商家不可直接恢复销售，请按新商家流程重新开通');
    if (targetStatus === MerchantStatus.CLOSED && merchant.status !== MerchantStatus.EXITING) throw new BadRequestException('请先发起离场收尾；商家完成既有履约、售后和结算后才能正式关闭');
    if (merchant.status === MerchantStatus.EXITING && targetStatus !== MerchantStatus.CLOSED) throw new BadRequestException('商家正在离场收尾，只能在满足关闭条件后正式关闭');
    let exitCase: MerchantExitCase | null = null;
    if (targetStatus === MerchantStatus.EXITING && statusChanged) {
      exitCase = await manager.findOne(MerchantExitCase, { where: { merchantId: merchant.id }, lock: { mode: 'pessimistic_write' } });
      if (!exitCase) {
        exitCase = await manager.save(MerchantExitCase, this.newExitCase(merchant.id, user.id, statusReason, MerchantExitCaseStatus.SALE_PAUSED));
        await this.auditWriter.write(user.id, merchant.id, 'MERCHANT_EXIT_REQUESTED', 'MerchantExitCase', exitCase.id, null, { status: MerchantExitCaseStatus.EXIT_REQUESTED, reasonProvided: true, createdByStatusTransition: true }, manager);
      } else if (exitCase.status === MerchantExitCaseStatus.EXIT_REQUESTED) {
        exitCase.status = MerchantExitCaseStatus.SALE_PAUSED;
        exitCase.salesPausedAt = new Date();
        exitCase = await manager.save(MerchantExitCase, exitCase);
      } else throw new ConflictException('离场案件已进入后续阶段，不能重复停售');
      await this.auditWriter.write(user.id, merchant.id, 'MERCHANT_EXIT_SALES_PAUSED', 'MerchantExitCase', exitCase.id, { status: MerchantExitCaseStatus.EXIT_REQUESTED }, { status: MerchantExitCaseStatus.SALE_PAUSED, salesPaused: true }, manager);
    }
    if (targetStatus === MerchantStatus.CLOSED) {
      const readiness = await this.readinessFor(manager, merchant.id, merchant.status);
      if (!readiness.readyToClose) throw new BadRequestException(this.blockerMessage(readiness));
      exitCase = await this.caseForMerchant(manager, merchant.id, true);
      if (exitCase.status !== MerchantExitCaseStatus.EXPORT_READY) throw new BadRequestException('离场案件尚未完成履约并进入数据交付阶段');
      if (!exitCase.dataExportConfirmedAt) throw new BadRequestException('商家尚未确认已完成一次性数据导出');
      if (!exitCase.authorizationRevocationAcknowledgedAt) throw new BadRequestException('商家尚未确认小程序授权撤销事项');
    }
    return exitCase;
  }

  async completeStatusTransition(manager: EntityManager, user: User, merchantId: string, targetStatus: MerchantStatus, exitCase: MerchantExitCase | null): Promise<void> {
    if (targetStatus !== MerchantStatus.CLOSED || !exitCase) return;
    exitCase.status = MerchantExitCaseStatus.CLOSED;
    exitCase.closedAt = new Date();
    exitCase.closedBy = user.id;
    const saved = await manager.save(MerchantExitCase, exitCase);
    const merchant = await manager.findOneByOrFail(Merchant, { id: merchantId });
    const registration = await manager.findOne(MerchantRegistration, { where: { merchantId }, lock: { mode: 'pessimistic_write' } });
    await this.agencyCooperation.applyOnboardingEntitlementEvent(
      manager,
      merchant,
      registration,
      WechatOnboardingEntitlementEventType.TERMINATED,
    );
    await this.auditWriter.write(user.id, merchantId, 'MERCHANT_EXIT_CLOSED', 'MerchantExitCase', saved.id, { status: MerchantExitCaseStatus.EXPORT_READY }, { status: saved.status, retentionReviewRequired: true }, manager);
  }

  async request(user: User, merchantId: string, reason: string): Promise<MerchantExitCaseView> {
    const merchant = await this.merchantAccess.getForUser(user, merchantId, [PlatformAccessProfile.OPERATIONS]);
    const requestedReason = this.requiredText(reason, '退出申请说明', 1000);
    const allowed = user.role === UserRole.MERCHANT_ADMIN || (user.role === UserRole.PLATFORM_ADMIN && (this.merchantAccess.requirePlatformAccess(user, '代为提交商家退出申请', [PlatformAccessProfile.OPERATIONS]) === undefined));
    if (!allowed) throw new ForbiddenException('仅商家管理员或平台运营可提交退出申请');
    if (merchant.status === MerchantStatus.CLOSED) throw new BadRequestException('商家已完成关闭，不能再次提交退出申请');
    try {
      return await this.dataSource.transaction(async (manager) => {
        const existing = await manager.findOne(MerchantExitCase, { where: { merchantId }, lock: { mode: 'pessimistic_write' } });
        if (existing) throw new ConflictException('该商家已有离场案件，不能重复提交');
        const exitCase = await manager.save(MerchantExitCase, this.newExitCase(merchantId, user.id, requestedReason, MerchantExitCaseStatus.EXIT_REQUESTED));
        await this.auditWriter.write(user.id, merchantId, 'MERCHANT_EXIT_REQUESTED', 'MerchantExitCase', exitCase.id, null, { status: exitCase.status, reasonProvided: true }, manager);
        return this.view(user, exitCase);
      });
    } catch (error) {
      if (this.isUniqueConstraintError(error)) throw new ConflictException('该商家已有离场案件，不能重复提交');
      throw error;
    }
  }

  async get(user: User, merchantId: string): Promise<MerchantExitCaseView | null> {
    await this.merchantAccess.getForUser(user, merchantId, [PlatformAccessProfile.OPERATIONS, PlatformAccessProfile.COMPLIANCE]);
    if (user.role === UserRole.STORE_STAFF) throw new ForbiddenException('核销员不可查看离场案件');
    const exitCase = await this.exitCases.findOneBy({ merchantId });
    return exitCase ? this.view(user, exitCase) : null;
  }

  async startFulfillment(user: User, merchantId: string, note: string): Promise<MerchantExitCaseView> {
    this.merchantAccess.requirePlatformAccess(user, '启动商家离场履约', [PlatformAccessProfile.OPERATIONS]);
    const transitionNote = this.requiredText(note, '履约启动说明', 1000);
    return this.dataSource.transaction(async (manager) => {
      const merchant = await manager.findOne(Merchant, { where: { id: merchantId }, lock: { mode: 'pessimistic_write' } });
      if (!merchant) throw new NotFoundException('商家不存在');
      if (merchant.status !== MerchantStatus.EXITING) throw new BadRequestException('商家尚未停售进入离场状态');
      const exitCase = await this.caseForMerchant(manager, merchantId, true);
      if (exitCase.status !== MerchantExitCaseStatus.SALE_PAUSED) throw new BadRequestException('离场案件当前不能启动履约阶段');
      exitCase.status = MerchantExitCaseStatus.FULFILLING;
      exitCase.fulfillmentStartedAt = new Date();
      exitCase.fulfillmentStartedBy = user.id;
      const saved = await manager.save(MerchantExitCase, exitCase);
      await this.auditWriter.write(user.id, merchantId, 'MERCHANT_EXIT_FULFILLMENT_STARTED', 'MerchantExitCase', saved.id, { status: MerchantExitCaseStatus.SALE_PAUSED }, { status: saved.status, note: transitionNote }, manager);
      return this.view(user, saved);
    });
  }

  async prepareExport(user: User, merchantId: string, note: string): Promise<MerchantExitCaseView> {
    this.merchantAccess.requirePlatformAccess(user, '确认离场数据交付准备', [PlatformAccessProfile.COMPLIANCE]);
    const transitionNote = this.requiredText(note, '数据交付准备说明', 1000);
    return this.dataSource.transaction(async (manager) => {
      const merchant = await manager.findOne(Merchant, { where: { id: merchantId }, lock: { mode: 'pessimistic_write' } });
      if (!merchant) throw new NotFoundException('商家不存在');
      const exitCase = await this.caseForMerchant(manager, merchantId, true);
      if (merchant.status !== MerchantStatus.EXITING || exitCase.status !== MerchantExitCaseStatus.FULFILLING) throw new BadRequestException('离场案件尚未完成履约阶段');
      const readiness = await this.readinessFor(manager, merchantId, merchant.status);
      if (!readiness.readyToClose) throw new BadRequestException(this.blockerMessage(readiness));
      exitCase.status = MerchantExitCaseStatus.EXPORT_READY;
      exitCase.exportReadyAt = new Date();
      const saved = await manager.save(MerchantExitCase, exitCase);
      await this.auditWriter.write(user.id, merchantId, 'MERCHANT_EXIT_EXPORT_READY', 'MerchantExitCase', saved.id, { status: MerchantExitCaseStatus.FULFILLING }, { status: saved.status, note: transitionNote }, manager);
      return this.view(user, saved);
    });
  }

  async confirmDataExport(user: User, merchantId: string, note: string): Promise<MerchantExitCaseView> {
    if (user.role !== UserRole.MERCHANT_ADMIN || user.merchantId !== merchantId) throw new ForbiddenException('仅商家管理员可确认已交付数据');
    const confirmationNote = this.requiredText(note, '数据交付确认说明', 1000);
    return this.dataSource.transaction(async (manager) => {
      const exitCase = await this.caseForMerchant(manager, merchantId, true);
      if (exitCase.status !== MerchantExitCaseStatus.EXPORT_READY) throw new BadRequestException('当前离场阶段不能确认数据交付');
      if (exitCase.dataExportConfirmedAt) return this.view(user, exitCase);
      exitCase.dataExportConfirmedAt = new Date(); exitCase.dataExportConfirmedBy = user.id; exitCase.dataExportConfirmationNote = confirmationNote;
      const saved = await manager.save(MerchantExitCase, exitCase);
      await this.auditWriter.write(user.id, merchantId, 'MERCHANT_EXIT_DATA_EXPORT_CONFIRMED', 'MerchantExitCase', saved.id, null, { confirmed: true }, manager);
      return this.view(user, saved);
    });
  }

  async acknowledgeAuthorizationRevocation(user: User, merchantId: string, note: string): Promise<MerchantExitCaseView> {
    if (user.role !== UserRole.MERCHANT_ADMIN || user.merchantId !== merchantId) throw new ForbiddenException('仅商家管理员可确认小程序授权撤销事项');
    const acknowledgementNote = this.requiredText(note, '授权撤销确认说明', 1000);
    return this.dataSource.transaction(async (manager) => {
      const exitCase = await this.caseForMerchant(manager, merchantId, true);
      if (exitCase.status !== MerchantExitCaseStatus.EXPORT_READY) throw new BadRequestException('当前离场阶段不能确认授权撤销事项');
      if (exitCase.authorizationRevocationAcknowledgedAt) return this.view(user, exitCase);
      exitCase.authorizationRevocationAcknowledgedAt = new Date(); exitCase.authorizationRevocationAcknowledgedBy = user.id; exitCase.authorizationRevocationNote = acknowledgementNote;
      const saved = await manager.save(MerchantExitCase, exitCase);
      await this.auditWriter.write(user.id, merchantId, 'MERCHANT_EXIT_AUTHORIZATION_REVOCATION_ACKNOWLEDGED', 'MerchantExitCase', saved.id, null, { acknowledged: true }, manager);
      return this.view(user, saved);
    });
  }

  async reviewRetention(user: User, merchantId: string, input: { retentionPolicyReference: string; retentionUntil: string; note: string }): Promise<MerchantExitCaseView> {
    this.merchantAccess.requirePlatformAccess(user, '复核商家离场留存期', [PlatformAccessProfile.COMPLIANCE]);
    const reference = this.requiredText(input.retentionPolicyReference, '留存政策引用', 120);
    const retentionUntil = this.requiredDate(input.retentionUntil, '留存截止日');
    const reviewNote = this.requiredText(input.note, '留存复核说明', 1000);
    return this.dataSource.transaction(async (manager) => {
      const exitCase = await this.caseForMerchant(manager, merchantId, true);
      if (exitCase.status !== MerchantExitCaseStatus.CLOSED) throw new BadRequestException('仅已关闭的离场案件可进入留存复核');
      exitCase.retentionPolicyReference = reference; exitCase.retentionUntil = retentionUntil; exitCase.retentionReviewNote = reviewNote; exitCase.retentionReviewedBy = user.id;
      const eligibleNow = this.day(retentionUntil) <= this.day();
      if (eligibleNow) { exitCase.status = MerchantExitCaseStatus.PURGE_ELIGIBLE; exitCase.purgeEligibleAt = new Date(); }
      const saved = await manager.save(MerchantExitCase, exitCase);
      await this.auditWriter.write(user.id, merchantId, eligibleNow ? 'MERCHANT_EXIT_PURGE_ELIGIBLE' : 'MERCHANT_EXIT_RETENTION_REVIEWED', 'MerchantExitCase', saved.id, null, { retentionPolicyReference: reference, retentionUntil: this.day(retentionUntil), purgeEligible: eligibleNow }, manager);
      return this.view(user, saved);
    });
  }

  async advanceRetention(): Promise<number> {
    return this.dataSource.transaction(async (manager) => {
      const candidates = await manager.find(MerchantExitCase, { where: { status: MerchantExitCaseStatus.CLOSED, retentionUntil: LessThanOrEqual(this.businessDayStart()) }, lock: { mode: 'pessimistic_write' } });
      for (const exitCase of candidates) {
        exitCase.status = MerchantExitCaseStatus.PURGE_ELIGIBLE; exitCase.purgeEligibleAt = new Date();
        await manager.save(MerchantExitCase, exitCase);
        await this.auditWriter.write('system', exitCase.merchantId, 'MERCHANT_EXIT_PURGE_ELIGIBLE', 'MerchantExitCase', exitCase.id, { status: MerchantExitCaseStatus.CLOSED }, { status: exitCase.status, retentionUntil: exitCase.retentionUntil ? this.day(exitCase.retentionUntil) : null }, manager);
      }
      return candidates.length;
    });
  }

  async readiness(user: User, merchantId: string): Promise<MerchantExitReadiness> {
    this.merchantAccess.requirePlatformAccess(user, '查看商家离场检查', [PlatformAccessProfile.OPERATIONS, PlatformAccessProfile.COMPLIANCE]);
    const merchant = await this.merchantAccess.getForUser(user, merchantId, [PlatformAccessProfile.OPERATIONS, PlatformAccessProfile.COMPLIANCE]);
    return this.readinessFor(this.dataSource.manager, merchant.id, merchant.status);
  }

  private async readinessFor(manager: EntityManager, merchantId: string, status: MerchantStatus): Promise<MerchantExitReadiness> {
    const today = this.businessDayStart();
    const [pendingOrders, activeVouchers, unresolvedRefunds, openSupportTickets, unsettledBills] = await Promise.all([
      manager.countBy(Order, { merchantId, status: OrderStatus.PENDING_PAYMENT }),
      manager.countBy(Voucher, [{ merchantId, status: VoucherStatus.UNUSED, validTo: MoreThanOrEqual(today) }, { merchantId, status: VoucherStatus.REFUND_PENDING }]),
      manager.countBy(Refund, { merchantId, status: In(['PROCESSING', 'FAILED']) }),
      manager.countBy(SupportTicket, { merchantId, status: SupportTicketStatus.OPEN }),
      // A5 说明：月结账单生成/收款接口已下线（billing.generateBills GoneException），不再产生新账单；
      // 存量非 PAID 账单仍视为离场阻断项（未结清不放行）——当前无存量账单时该值恒 0，不阻塞正常退出
      manager.countBy(MonthlyBill, { merchantId, status: Not(BillStatus.PAID) }),
    ]);
    const blockers = { pendingOrders, activeVouchers, unresolvedRefunds, openSupportTickets, unsettledBills };
    return { merchantId, status, readyToClose: Object.values(blockers).every((count) => count === 0), blockers };
  }

  private blockerMessage(readiness: MerchantExitReadiness): string {
    const labels = { pendingOrders: '待支付订单', activeVouchers: '待履约或退款中的券', unresolvedRefunds: '待确认退款', openSupportTickets: '未结售后', unsettledBills: '未结月结账单' };
    const units = { pendingOrders: '笔', activeVouchers: '张', unresolvedRefunds: '笔', openSupportTickets: '件', unsettledBills: '张' };
    const entries = Object.entries(readiness.blockers).filter(([, count]) => count > 0).map(([key, count]) => `${labels[key as keyof typeof labels]} ${count} ${units[key as keyof typeof units]}`);
    return `离场收尾尚未完成：${entries.join('；')}`;
  }

  private newExitCase(merchantId: string, requestedBy: string, requestReason: string, status: MerchantExitCaseStatus): Partial<MerchantExitCase> {
    return { merchantId, status, requestedBy, requestReason, salesPausedAt: status === MerchantExitCaseStatus.SALE_PAUSED ? new Date() : null, fulfillmentStartedAt: null, fulfillmentStartedBy: null, exportReadyAt: null, dataExportConfirmedAt: null, dataExportConfirmedBy: null, dataExportConfirmationNote: '', authorizationRevocationAcknowledgedAt: null, authorizationRevocationAcknowledgedBy: null, authorizationRevocationNote: '', closedAt: null, closedBy: null, retentionPolicyReference: '', retentionUntil: null, retentionReviewNote: '', retentionReviewedBy: null, purgeEligibleAt: null };
  }

  private view(user: User, exitCase: MerchantExitCase): MerchantExitCaseView {
    return { id: exitCase.id, merchantId: exitCase.merchantId, status: exitCase.status, salesPausedAt: exitCase.salesPausedAt, fulfillmentStartedAt: exitCase.fulfillmentStartedAt, exportReadyAt: exitCase.exportReadyAt, dataExportConfirmedAt: exitCase.dataExportConfirmedAt, authorizationRevocationAcknowledgedAt: exitCase.authorizationRevocationAcknowledgedAt, closedAt: exitCase.closedAt, purgeEligibleAt: exitCase.purgeEligibleAt, createdAt: exitCase.createdAt, updatedAt: exitCase.updatedAt, dataExportConfirmed: Boolean(exitCase.dataExportConfirmedAt), authorizationRevocationAcknowledged: Boolean(exitCase.authorizationRevocationAcknowledgedAt), ...(user.role === UserRole.PLATFORM_ADMIN ? { retentionPolicyReference: exitCase.retentionPolicyReference, retentionUntil: exitCase.retentionUntil } : {}) };
  }

  private async caseForMerchant(manager: EntityManager, merchantId: string, lock = false): Promise<MerchantExitCase> {
    const exitCase = await manager.findOne(MerchantExitCase, { where: { merchantId }, ...(lock ? { lock: { mode: 'pessimistic_write' as const } } : {}) });
    if (!exitCase) throw new BadRequestException('尚未建立商家离场案件，请先提交退出申请');
    return exitCase;
  }

  private requiredText(value: unknown, label: string, maxLength: number): string {
    if (typeof value !== 'string' || !value.trim() || value.trim().length > maxLength) throw new BadRequestException(`${label}不能为空且不能超过 ${maxLength} 个字符`);
    return value.trim();
  }
  private requiredDate(value: unknown, label: string): Date { const date = new Date(String(value)); if (Number.isNaN(date.getTime())) throw new BadRequestException(`${label}格式不正确`); return date; }
  private day(date: Date | string = new Date()): string { const values = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(date)).filter((part) => part.type !== 'literal').map((part) => [part.type, part.value])); return `${values.year}-${values.month}-${values.day}`; }
  private businessDayStart(day = this.day()): Date { return new Date(`${day}T00:00:00+08:00`); }
  private isUniqueConstraintError(error: unknown): boolean { return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === '23505'; }
}
