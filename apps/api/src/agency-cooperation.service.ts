import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, LessThan, Repository } from 'typeorm';
import {
  Agency, AgencyCooperationPlan, Merchant, MerchantRegistration, PublicationEntitlementStatus, User, UserRole,
} from './domain/entities';
import { WechatOnboardingEntitlementEvent, WechatOnboardingEntitlementEventType } from './domain/wechat-onboarding-entitlement.entities';
import { AuditWriterService } from './audit-writer.service';
import { MerchantAccessService } from './merchant-access.service';

/** B4：代理名额（PER_PUBLISH）RESERVED 后的最大占用时长，超期未消费自动回收 */
const ENTITLEMENT_RESERVATION_TTL_MS = 72 * 60 * 60 * 1000;

export type AgencyCooperationInput = {
  cooperationPlan?: AgencyCooperationPlan;
  publicationQuotaRemaining?: number;
  cooperationStartsAt?: string | null;
  cooperationEndsAt?: string | null;
  cooperationReference?: string;
};

type CooperationSettings = Pick<Agency, 'cooperationPlan' | 'publicationQuotaRemaining' | 'cooperationStartsAt' | 'cooperationEndsAt' | 'cooperationReference'>;

/**
 * Controls offline agency cooperation. This service deliberately records only
 * entitlement and a non-sensitive reference; funds stay outside this system.
 */
@Injectable()
export class AgencyCooperationService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly auditWriter: AuditWriterService,
    private readonly merchantAccess: MerchantAccessService,
    @InjectRepository(Agency) private readonly agencies: Repository<Agency>,
  ) {}

  settings(input: AgencyCooperationInput = {}): CooperationSettings {
    const cooperationPlan = input.cooperationPlan || AgencyCooperationPlan.PER_PUBLISH;
    const cooperationReference = this.optionalText(input.cooperationReference, '线下合作参考号', 120);
    if (cooperationPlan === AgencyCooperationPlan.ANNUAL_UNLIMITED) {
      const cooperationStartsAt = this.requiredDate(input.cooperationStartsAt, '年度合作开始日');
      const cooperationEndsAt = this.requiredDate(input.cooperationEndsAt, '年度合作截止日');
      if (this.day(cooperationStartsAt) > this.day(cooperationEndsAt)) throw new BadRequestException('年度合作截止日不能早于开始日');
      return { cooperationPlan, publicationQuotaRemaining: 0, cooperationStartsAt, cooperationEndsAt, cooperationReference };
    }
    const publicationQuotaRemaining = input.publicationQuotaRemaining === undefined ? 0 : Number(input.publicationQuotaRemaining);
    if (!Number.isInteger(publicationQuotaRemaining) || publicationQuotaRemaining < 0 || publicationQuotaRemaining > 1_000_000) {
      throw new BadRequestException('单商家小程序开通剩余名额必须为 0 至 1000000 的整数');
    }
    return { cooperationPlan, publicationQuotaRemaining, cooperationStartsAt: null, cooperationEndsAt: null, cooperationReference };
  }

  async listForUser(user: User): Promise<Agency> {
    if (user.role === UserRole.AGENCY_ADMIN) {
      if (!user.agencyId) throw new ForbiddenException('代理商账号缺少归属关系');
      const agency = await this.agencies.findOneBy({ id: user.agencyId });
      if (!agency) throw new NotFoundException('代理商不存在');
      return agency;
    }
    this.merchantAccess.requirePlatformAccess(user, '查看代理合作授权', []);
    if (!user.agencyId) throw new BadRequestException('平台账号查看合作授权时必须指定代理商');
    const agency = await this.agencies.findOneBy({ id: user.agencyId });
    if (!agency) throw new NotFoundException('代理商不存在');
    return agency;
  }

  async update(user: User, agencyId: string, input: AgencyCooperationInput): Promise<Agency> {
    this.merchantAccess.requirePlatformAccess(user, '维护代理合作授权', []);
    const settings = this.settings(input);
    return this.dataSource.transaction(async (manager) => {
      const agency = await manager.findOne(Agency, { where: { id: agencyId }, lock: { mode: 'pessimistic_write' } });
      if (!agency) throw new NotFoundException('代理商不存在');
      const before = this.auditShape(agency);
      Object.assign(agency, settings);
      const saved = await manager.save(Agency, agency);
      await this.auditWriter.write(user.id, null, 'AGENCY_COOPERATION_UPDATED', 'Agency', saved.id, before, this.auditShape(saved), manager);
      return saved;
    });
  }

  async applyOnboardingEntitlementEvent(
    manager: EntityManager,
    merchant: Merchant,
    registration: MerchantRegistration | null,
    eventType: WechatOnboardingEntitlementEventType,
  ): Promise<boolean> {
    if (!registration) return false;
    const result = await manager
      .createQueryBuilder()
      .insert()
      .into(WechatOnboardingEntitlementEvent)
      .values({
        merchantId: merchant.id,
        eventType,
        payload: { merchantId: merchant.id },
      })
      .orIgnore()
      .execute();
    if (!result.identifiers.length) return false;
    const systemUser = { id: 'system' } as User;
    if (eventType === WechatOnboardingEntitlementEventType.STARTED) {
      await this.reserveForSubmission(manager, systemUser, merchant, registration);
    } else if (eventType === WechatOnboardingEntitlementEventType.PUBLISHABLE) {
      await this.consumeAtPublication(manager, systemUser, merchant, registration);
    } else if (eventType === WechatOnboardingEntitlementEventType.TERMINATED) {
      await this.releaseEntitlement(manager, systemUser, merchant, registration);
    }
    return true;
  }

  async reserveForSubmission(manager: EntityManager, user: User, merchant: Merchant, registration: MerchantRegistration): Promise<void> {
    if (registration.publicationEntitlementStatus !== PublicationEntitlementStatus.NONE) return;
    const agency = await this.lockUsableAgency(manager, merchant.agencyId);
    const before = this.auditShape(agency);
    if (agency.cooperationPlan === AgencyCooperationPlan.PER_PUBLISH) {
      if (agency.publicationQuotaRemaining < 1) throw new ForbiddenException('当前代理商没有可用的商家小程序开通名额，请联系平台系统管理员完成线下合作授权');
      agency.publicationQuotaRemaining -= 1;
      await manager.save(Agency, agency);
    }
    registration.publicationEntitlementStatus = PublicationEntitlementStatus.RESERVED;
    registration.publicationEntitlementPlan = agency.cooperationPlan;
    registration.publicationEntitlementReservedAt = new Date();
    registration.publicationEntitlementConsumedAt = null;
    await this.auditWriter.write(user.id, merchant.id, 'AGENCY_PUBLICATION_ENTITLEMENT_RESERVED', 'Agency', agency.id, before, {
      ...this.auditShape(agency), merchantId: merchant.id, registrationId: registration.id,
    }, manager);
  }

  async consumeAtPublication(manager: EntityManager, user: User, merchant: Merchant, registration: MerchantRegistration): Promise<void> {
    if (registration.publicationEntitlementStatus === PublicationEntitlementStatus.CONSUMED) return;
    if (registration.publicationEntitlementStatus !== PublicationEntitlementStatus.RESERVED) {
      throw new BadRequestException('商家尚未占用小程序开通名额，不能标记为小程序可发布');
    }
    registration.publicationEntitlementStatus = PublicationEntitlementStatus.CONSUMED;
    registration.publicationEntitlementConsumedAt = new Date();
    await this.auditWriter.write(user.id, merchant.id, 'AGENCY_PUBLICATION_ENTITLEMENT_CONSUMED', 'MerchantRegistration', registration.id, {
      entitlementStatus: PublicationEntitlementStatus.RESERVED,
    }, {
      entitlementStatus: PublicationEntitlementStatus.CONSUMED, entitlementPlan: registration.publicationEntitlementPlan,
    }, manager);
  }

  async releaseAfterFailure(manager: EntityManager, user: User, merchant: Merchant, registration: MerchantRegistration): Promise<void> {
    await this.releaseEntitlement(manager, user, merchant, registration);
  }

  /**
   * A4：通用名额释放——RESERVED 或 CONSUMED 均释放（PER_PUBLISH 名额加回），重置为 NONE。
   * 覆盖场景：注册 FAILED、主体资料回退待补齐、商家放弃等一切不再继续发布的路径。
   */
  async releaseEntitlement(manager: EntityManager, user: User, merchant: Merchant, registration: MerchantRegistration): Promise<void> {
    if (registration.publicationEntitlementStatus !== PublicationEntitlementStatus.RESERVED && registration.publicationEntitlementStatus !== PublicationEntitlementStatus.CONSUMED) return;
    const reservedPlan = registration.publicationEntitlementPlan;
    const agency = await manager.findOne(Agency, { where: { id: merchant.agencyId }, lock: { mode: 'pessimistic_write' } });
    if (!agency) throw new NotFoundException('代理商不存在');
    const before = this.auditShape(agency);
    if (reservedPlan === AgencyCooperationPlan.PER_PUBLISH) {
      agency.publicationQuotaRemaining += 1;
      await manager.save(Agency, agency);
    }
    registration.publicationEntitlementStatus = PublicationEntitlementStatus.NONE;
    registration.publicationEntitlementPlan = null;
    registration.publicationEntitlementReservedAt = null;
    registration.publicationEntitlementConsumedAt = null;
    // 必须落库：仅改内存对象会导致"名额已返还但状态仍 RESERVED"，下次扫描重复返还名额
    await manager.save(MerchantRegistration, registration);
    await this.auditWriter.write(user.id, merchant.id, 'AGENCY_PUBLICATION_ENTITLEMENT_RELEASED', 'Agency', agency.id, before, {
      ...this.auditShape(agency), merchantId: merchant.id, registrationId: registration.id,
    }, manager);
  }

  /**
   * B4：超期名额自动回收——RESERVED 超过 ENTITLEMENT_RESERVATION_TTL_MS 未消费的注册记录自动释放，
   * 防代理名额被长期占用（如商家提交后放弃、资料长期未补齐）。由 lifecycle sweep 调用（system 上下文）。
   */
  async reconcileStaleReservations(limit = 20): Promise<number> {
    const staleBefore = new Date(Date.now() - ENTITLEMENT_RESERVATION_TTL_MS);
    const stale = await this.dataSource.getRepository(MerchantRegistration).find({
      where: { publicationEntitlementStatus: PublicationEntitlementStatus.RESERVED, publicationEntitlementReservedAt: LessThan(staleBefore) },
      order: { publicationEntitlementReservedAt: 'ASC', id: 'ASC' },
      take: Math.max(1, Math.min(limit, 100)),
    });
    let released = 0;
    for (const registration of stale) {
      try {
        await this.dataSource.transaction(async (manager) => {
          const locked = await manager.findOne(MerchantRegistration, { where: { id: registration.id }, lock: { mode: 'pessimistic_write' } });
          if (!locked || locked.publicationEntitlementStatus !== PublicationEntitlementStatus.RESERVED || (locked.publicationEntitlementReservedAt && locked.publicationEntitlementReservedAt.getTime() >= staleBefore.getTime())) return;
          const merchant = await manager.findOneBy(Merchant, { id: locked.merchantId });
          if (!merchant) return;
          await this.releaseEntitlement(manager, { id: 'system' } as User, merchant, locked);
          released += 1;
        });
      } catch { /* 单条失败不阻塞 */ }
    }
    return released;
  }

  private isUniqueViolation(error: unknown): boolean {
    return Boolean(error && typeof error === 'object' && 'code' in error && (error as { code?: string }).code === '23505');
  }

  private async lockUsableAgency(manager: EntityManager, agencyId: string): Promise<Agency> {
    const agency = await manager.findOne(Agency, { where: { id: agencyId }, lock: { mode: 'pessimistic_write' } });
    if (!agency) throw new NotFoundException('代理商不存在');
    if (!agency.active) throw new ForbiddenException('代理商已停用，不能提交新商家小程序开通资料');
    if (agency.cooperationPlan === AgencyCooperationPlan.ANNUAL_UNLIMITED) {
      if (!agency.cooperationStartsAt || !agency.cooperationEndsAt || this.day() < this.day(agency.cooperationStartsAt) || this.day() > this.day(agency.cooperationEndsAt)) {
        throw new ForbiddenException('代理年度合作未在有效期内，不能提交新商家小程序开通资料');
      }
    }
    return agency;
  }

  private auditShape(agency: Agency): Record<string, unknown> {
    return {
      cooperationPlan: agency.cooperationPlan,
      publicationQuotaRemaining: agency.publicationQuotaRemaining,
      cooperationStartsAt: agency.cooperationStartsAt ? this.day(agency.cooperationStartsAt) : null,
      cooperationEndsAt: agency.cooperationEndsAt ? this.day(agency.cooperationEndsAt) : null,
      hasCooperationReference: Boolean(agency.cooperationReference),
    };
  }

  private requiredDate(value: unknown, label: string): Date {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new BadRequestException(`${label}格式不正确`);
    const date = new Date(`${value}T00:00:00+08:00`);
    if (Number.isNaN(date.getTime())) throw new BadRequestException(`${label}格式不正确`);
    return date;
  }

  private optionalText(value: unknown, label: string, maxLength: number): string {
    if (value === undefined || value === null || value === '') return '';
    if (typeof value !== 'string') throw new BadRequestException(`${label}格式不正确`);
    const normalized = value.trim();
    if (normalized.length > maxLength) throw new BadRequestException(`${label}不能超过 ${maxLength} 个字符`);
    return normalized;
  }

  private day(date: Date | string = new Date()): string {
    if (typeof date === 'string') return date.slice(0, 10);
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date).filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
    return `${parts.year}-${parts.month}-${parts.day}`;
  }
}
