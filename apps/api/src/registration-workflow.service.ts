import { BadRequestException, ForbiddenException, GoneException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash } from 'crypto';
import { DataSource, EntityManager, Repository } from 'typeorm';
import {
  Merchant, MerchantRegistration, MerchantRegistrationStatus, PlatformAccessProfile, PublicationEntitlementStatus, User, UserRole,
} from './domain/entities';
import { AuditWriterService } from './audit-writer.service';
import { MerchantAccessService } from './merchant-access.service';
import { NotificationAudienceService } from './notifications/notification-audience.service';
import { AgencyCooperationService } from './agency-cooperation.service';

export type UpdateMerchantRegistrationInput = {
  status: MerchantRegistrationStatus;
  note?: string;
  failureReason?: string;
};

const TRANSITIONS: Record<MerchantRegistrationStatus, MerchantRegistrationStatus[]> = {
  [MerchantRegistrationStatus.DRAFT]: [MerchantRegistrationStatus.PENDING_MATERIALS],
  [MerchantRegistrationStatus.PENDING_MATERIALS]: [MerchantRegistrationStatus.SUBMITTED],
  [MerchantRegistrationStatus.SUBMITTED]: [MerchantRegistrationStatus.PENDING_CONFIRMATION, MerchantRegistrationStatus.PENDING_MATERIALS],
  [MerchantRegistrationStatus.PENDING_CONFIRMATION]: [MerchantRegistrationStatus.UNDER_REVIEW, MerchantRegistrationStatus.PENDING_MATERIALS],
  [MerchantRegistrationStatus.UNDER_REVIEW]: [MerchantRegistrationStatus.OPENED, MerchantRegistrationStatus.FAILED, MerchantRegistrationStatus.PENDING_MATERIALS],
  [MerchantRegistrationStatus.OPENED]: [MerchantRegistrationStatus.AUTHORIZING, MerchantRegistrationStatus.PENDING_MATERIALS],
  [MerchantRegistrationStatus.AUTHORIZING]: [MerchantRegistrationStatus.PUBLISHABLE, MerchantRegistrationStatus.FAILED, MerchantRegistrationStatus.PENDING_MATERIALS],
  [MerchantRegistrationStatus.PUBLISHABLE]: [MerchantRegistrationStatus.PENDING_MATERIALS],
  [MerchantRegistrationStatus.FAILED]: [MerchantRegistrationStatus.PENDING_MATERIALS],
};

const STATUS_TEXT: Record<MerchantRegistrationStatus, string> = {
  [MerchantRegistrationStatus.DRAFT]: '草稿',
  [MerchantRegistrationStatus.PENDING_MATERIALS]: '待补齐资料',
  [MerchantRegistrationStatus.SUBMITTED]: '资料已提交',
  [MerchantRegistrationStatus.PENDING_CONFIRMATION]: '待主体确认',
  [MerchantRegistrationStatus.UNDER_REVIEW]: '审核中',
  [MerchantRegistrationStatus.OPENED]: '已开通',
  [MerchantRegistrationStatus.AUTHORIZING]: '授权中',
  [MerchantRegistrationStatus.PUBLISHABLE]: '小程序可发布',
  [MerchantRegistrationStatus.FAILED]: '审核失败',
};

@Injectable()
export class RegistrationWorkflowService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly auditWriter: AuditWriterService,
    private readonly merchantAccess: MerchantAccessService,
    private readonly notificationAudience: NotificationAudienceService,
    private readonly agencyCooperation: AgencyCooperationService,
    @InjectRepository(MerchantRegistration) private readonly registrations: Repository<MerchantRegistration>,
  ) {}

  findForMerchant(merchantId: string): Promise<MerchantRegistration | null> {
    return this.registrations.findOneBy({ merchantId });
  }

  statusText(status: MerchantRegistrationStatus): string {
    return STATUS_TEXT[status];
  }

  isPublishable(registration: MerchantRegistration | null): boolean {
    return registration?.status === MerchantRegistrationStatus.PUBLISHABLE;
  }

  createDraft(manager: EntityManager, merchantId: string, updatedBy: string | null): Promise<MerchantRegistration> {
    return manager.save(MerchantRegistration, {
      merchantId, status: MerchantRegistrationStatus.DRAFT, note: '', failureReason: '', publicationEntitlementStatus: PublicationEntitlementStatus.NONE, publicationEntitlementPlan: null, publicationEntitlementReservedAt: null, publicationEntitlementConsumedAt: null, updatedBy,
    });
  }

  /**
   * 主体资料（legalName）修改校验。
   * 已按业务要求放开：任何开户阶段都允许直接修改主体资料，不再要求先退回"待补齐资料"。
   * （保留空实现以兼容调用点，后续如需恢复审核期锁定，在此处加回状态判断即可）
   */
  async assertLegalNameEditable(_manager: EntityManager, _merchantId: string): Promise<void> {
    // 放开：不拦截任何状态下修改主体资料
  }

  async get(user: User, merchantId: string): Promise<MerchantRegistration> {
    const merchant = await this.merchantAccess.getForUser(user, merchantId, [PlatformAccessProfile.COMPLIANCE]);
    if (user.role === UserRole.STORE_STAFF) throw new ForbiddenException('核销员不可查看开户与授权进度');
    return this.dataSource.transaction(async (manager) => {
      await manager.findOneOrFail(Merchant, { where: { id: merchant.id }, lock: { mode: 'pessimistic_write' } });
      return (await manager.findOneBy(MerchantRegistration, { merchantId: merchant.id }))
        || this.createDraft(manager, merchant.id, null);
    });
  }

  async update(_user: User, _merchantId: string, _input: UpdateMerchantRegistrationInput): Promise<MerchantRegistration> {
    throw new GoneException('开户进度由微信真实状态自动同步，人工推进接口已停用');
  }

  private canTransition(user: User, current: MerchantRegistrationStatus, target: MerchantRegistrationStatus): boolean {
    if (user.role === UserRole.PLATFORM_ADMIN) return true;
    if (user.role === UserRole.AGENCY_ADMIN) return [
      [MerchantRegistrationStatus.DRAFT, MerchantRegistrationStatus.PENDING_MATERIALS],
      [MerchantRegistrationStatus.PENDING_MATERIALS, MerchantRegistrationStatus.SUBMITTED],
      [MerchantRegistrationStatus.SUBMITTED, MerchantRegistrationStatus.PENDING_CONFIRMATION],
      [MerchantRegistrationStatus.PENDING_CONFIRMATION, MerchantRegistrationStatus.UNDER_REVIEW],
      [MerchantRegistrationStatus.UNDER_REVIEW, MerchantRegistrationStatus.OPENED],
      [MerchantRegistrationStatus.FAILED, MerchantRegistrationStatus.PENDING_MATERIALS],
      [MerchantRegistrationStatus.OPENED, MerchantRegistrationStatus.AUTHORIZING],
      // 主体资料需修改时，仅允许从【尚未触发微信侧不可逆操作】的状态退回"待补齐资料"：
      // SUBMITTED / PENDING_CONFIRMATION / UNDER_REVIEW 阶段微信侧尚未授权、认证、备案，退回不产生状态矛盾。
      // OPENED 起已进入微信授权环节（AUTHORIZING）乃至认证/备案/发布（PUBLISHABLE），
      // 微信侧授权、认证、备案为不可逆真实事实，本地退回会造成「registrationStatus=待补齐资料 但 授权/认证/备案已完成」的矛盾，
      // 因此禁止这些退回；改主体资料的需求由「任何开户阶段都允许直接修改」机制覆盖，不受影响。
      [MerchantRegistrationStatus.SUBMITTED, MerchantRegistrationStatus.PENDING_MATERIALS],
      [MerchantRegistrationStatus.PENDING_CONFIRMATION, MerchantRegistrationStatus.PENDING_MATERIALS],
      [MerchantRegistrationStatus.UNDER_REVIEW, MerchantRegistrationStatus.PENDING_MATERIALS],
    ].some(([from, to]) => from === current && to === target);
    return false;
  }

  private optionalText(value: unknown, field: string, maxLength: number): string {
    if (value === undefined || value === null) return '';
    if (typeof value !== 'string') throw new BadRequestException(`${field}格式不正确`);
    const text = value.trim();
    if (text.length > maxLength) throw new BadRequestException(`${field}不能超过 ${maxLength} 个字符`);
    return text;
  }
}
