import {
  BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash } from 'crypto';
import { DataSource, EntityManager, In, Repository } from 'typeorm';
import {
  Agency, AuthSession, CommissionRateVersion, Merchant, MerchantStatus, MerchantStatusChangeCommand,
  PlatformAccessProfile, User, UserRole,
} from './domain/entities';
import { AuditWriterService } from './audit-writer.service';
import { AuthService } from './auth.service';
import { MerchantAccessService } from './merchant-access.service';
import { MerchantExitService } from './merchant-exit.service';
import { RegistrationWorkflowService } from './registration-workflow.service';
import { AgencyCooperationService } from './agency-cooperation.service';
import type { MerchantListItem, SafeUser } from './app-service.core-types';

type StoreStaffMerchantListItem = Pick<Merchant, 'id' | 'brandName' | 'primaryColor'>;
type CreateAgencyInput = { name: string; managerName: string; managerEmail: string; password?: string; cooperationPlan?: import('./domain/entities').AgencyCooperationPlan; publicationQuotaRemaining?: number; cooperationStartsAt?: string | null; cooperationEndsAt?: string | null; cooperationReference?: string };
type CreateMerchantInput = {
  agencyId?: string;
  legalName: string;
  brandName: string;
  servicePhone?: string;
  contractNumber?: string;
  contractEndsAt?: string;
  rate?: number;
  adminName?: string;
  adminEmail?: string;
  adminPassword?: string;
  idempotencyKey?: string;
  operationId?: string;
  importExternalRef?: string;
};
type UpdateMerchantInput = {
  brandName?: string;
  legalName?: string;
  servicePhone?: string;
  primaryColor?: string;
  rating?: string;
  featureTags?: string[];
  status?: MerchantStatus;
  expectedStatus?: MerchantStatus;
  statusReason?: string;
  idempotencyKey?: string;
  contractNumber?: string;
  contractEndsAt?: string | null;
};

@Injectable()
export class TenantAdministrationService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly auditWriter: AuditWriterService,
    private readonly merchantAccess: MerchantAccessService,
    private readonly authService: AuthService,
    private readonly merchantExitService: MerchantExitService,
    private readonly registrationWorkflow: RegistrationWorkflowService,
    private readonly agencyCooperation: AgencyCooperationService,
    @InjectRepository(Agency) private readonly agencies: Repository<Agency>,
    @InjectRepository(Merchant) private readonly merchants: Repository<Merchant>,
    @InjectRepository(User) private readonly users: Repository<User>,
  ) {}

  async scopedMerchantIds(user: User): Promise<string[]> {
    if (user.role === UserRole.PLATFORM_ADMIN) {
      this.merchantAccess.requirePlatformAccess(user, '查看商家范围', [PlatformAccessProfile.OPERATIONS, PlatformAccessProfile.FINANCE, PlatformAccessProfile.COMPLIANCE]);
      return (await this.merchants.find({ select: { id: true } })).map((merchant) => merchant.id);
    }
    if (user.role === UserRole.AGENCY_ADMIN) return (await this.merchants.find({ where: { agencyId: user.agencyId! }, select: { id: true } })).map((merchant) => merchant.id);
    return user.merchantId ? [user.merchantId] : [];
  }

  async listMerchants(user: User): Promise<Array<MerchantListItem | StoreStaffMerchantListItem>> {
    if (user.role === UserRole.STORE_STAFF) {
      if (!user.merchantId) return [];
      const merchant = await this.merchants.findOne({ where: { id: user.merchantId }, select: { id: true, brandName: true, primaryColor: true } });
      return merchant ? [{ id: merchant.id, brandName: merchant.brandName, primaryColor: merchant.primaryColor }] : [];
    }
    if (user.role === UserRole.PLATFORM_ADMIN) this.merchantAccess.requirePlatformAccess(user, '查看商家范围', [PlatformAccessProfile.OPERATIONS, PlatformAccessProfile.FINANCE, PlatformAccessProfile.COMPLIANCE]);
    if (user.role === UserRole.AGENCY_ADMIN && !user.agencyId) return [];
    if (user.role === UserRole.MERCHANT_ADMIN && !user.merchantId) return [];
    const where = user.role === UserRole.PLATFORM_ADMIN ? {} : user.role === UserRole.AGENCY_ADMIN ? { agencyId: user.agencyId! } : { id: user.merchantId! };
    const merchants = await this.merchants.find({ where, order: { createdAt: 'DESC', id: 'DESC' } });
    return merchants.map((merchant) => this.merchantListItem(merchant));
  }

  async listAgencies(user: User): Promise<Array<Agency & { managerUserId: string | null; managerName: string; managerEmail: string }>> {
    this.merchantAccess.requirePlatformAccess(user, '查看代理商', []);
    const agencies = await this.agencies.find({ order: { createdAt: 'DESC' } });
    if (!agencies.length) return [];
    const managers = await this.users.find({ where: { agencyId: In(agencies.map((agency) => agency.id)), role: UserRole.AGENCY_ADMIN }, order: { createdAt: 'ASC' } });
    const managerByAgency = new Map<string, User>();
    for (const manager of managers) if (!managerByAgency.has(manager.agencyId!)) managerByAgency.set(manager.agencyId!, manager);
    return agencies.map((agency) => {
      const manager = managerByAgency.get(agency.id);
      return { ...agency, managerUserId: manager?.id || null, managerName: manager?.name || '', managerEmail: manager?.email || '' };
    });
  }

  async resetManagedPassword(actor: User, targetUserId: string, newPassword: string): Promise<SafeUser> {
    if (actor.id === targetUserId) throw new BadRequestException('请通过修改密码功能更新当前账号密码');
    const target = await this.users.findOneBy({ id: targetUserId });
    if (!target) throw new NotFoundException('账号不存在');
    const allowed = actor.role === UserRole.PLATFORM_ADMIN
      ? (this.merchantAccess.requirePlatformAccess(actor, '重置下级账号密码', []) === undefined && target.role !== UserRole.PLATFORM_ADMIN)
      : actor.role === UserRole.AGENCY_ADMIN
        ? target.agencyId === actor.agencyId && [UserRole.MERCHANT_ADMIN, UserRole.STORE_STAFF].includes(target.role)
        : actor.role === UserRole.MERCHANT_ADMIN
          ? target.merchantId === actor.merchantId && target.role === UserRole.STORE_STAFF
          : false;
    if (!allowed) throw new ForbiddenException('当前角色无权重置该账号密码');
    const before = { targetRole: target.role, sessionVersion: target.sessionVersion };
    const saved = await this.authService.resetPassword(target.id, newPassword, async (manager, updated) => {
      await this.auditWriter.write(actor.id, target.merchantId, 'USER_PASSWORD_RESET_BY_SUPERVISOR', 'User', updated.id, before, { targetRole: updated.role, sessionsInvalidated: true }, manager);
    });
    return this.safeUser(saved);
  }

  async createAgency(user: User, input: CreateAgencyInput): Promise<Agency> {
    this.merchantAccess.requirePlatformAccess(user, '创建代理商', []);
    const name = this.requiredText(input.name, '代理商名称');
    const managerName = this.requiredText(input.managerName, '管理员姓名');
    const email = this.requiredText(input.managerEmail, '管理员登录账号', 254).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new BadRequestException('管理员登录账号格式不正确');
    if (await this.agencies.existsBy({ name })) throw new ConflictException('代理商名称已存在，请勿重复创建');
    if (await this.users.existsBy({ email })) throw new ConflictException('管理员账号已存在，请勿重复创建');
    if (!input.password) throw new BadRequestException('初始密码不能为空');
    this.authService.assertPasswordPolicy(input.password, '初始密码');
    const cooperation = this.agencyCooperation.settings(input);
    const passwordHash = await (await import('bcryptjs')).default.hash(input.password, 10);
    try {
      return await this.dataSource.transaction(async (manager) => {
        const agency = await manager.save(Agency, { name, active: true, ...cooperation });
        const administrator = await manager.save(User, {
          email, name: managerName, passwordHash,
          role: UserRole.AGENCY_ADMIN, agencyId: agency.id, merchantId: null, storeIds: null, active: true,
        });
        await this.auditWriter.write(user.id, null, 'AGENCY_CREATED', 'Agency', agency.id, null, { name: agency.name, administratorId: administrator.id, cooperationPlan: agency.cooperationPlan, publicationQuotaRemaining: agency.publicationQuotaRemaining, cooperationStartsAt: agency.cooperationStartsAt, cooperationEndsAt: agency.cooperationEndsAt, hasCooperationReference: Boolean(agency.cooperationReference) }, manager);
        return agency;
      });
    } catch (error) {
      if (this.isUniqueConstraintError(error)) throw new ConflictException('代理商名称或管理员账号已存在，请勿重复创建');
      throw error;
    }
  }

  async setAgencyActive(user: User, agencyId: string, active: boolean): Promise<Agency> {
    this.merchantAccess.requirePlatformAccess(user, active ? '恢复代理商' : '停用代理商', []);
    return this.dataSource.transaction(async (manager) => {
      const agency = await manager.findOne(Agency, { where: { id: agencyId }, lock: { mode: 'pessimistic_write' } });
      if (!agency) throw new NotFoundException('代理商不存在');
      if (agency.active === active) return agency;
      const administrators = await manager.find(User, { where: { agencyId, role: UserRole.AGENCY_ADMIN }, lock: { mode: 'pessimistic_write' } });
      const before = { active: agency.active, administratorCount: administrators.length };
      agency.active = active;
      await manager.save(Agency, agency);
      if (administrators.length) {
        const now = new Date();
        for (const administrator of administrators) {
          administrator.active = active;
          if (!active) administrator.sessionVersion += 1;
        }
        await manager.save(User, administrators);
        if (!active) {
          await manager.createQueryBuilder().update(AuthSession)
            .set({ revokedAt: now })
            .where('userId IN (:...administratorIds)', { administratorIds: administrators.map((administrator) => administrator.id) })
            .andWhere('revokedAt IS NULL')
            .execute();
        }
      }
      await this.auditWriter.write(user.id, null, active ? 'AGENCY_REACTIVATED' : 'AGENCY_DEACTIVATED', 'Agency', agency.id, before, { active, administratorCount: administrators.length, sessionsRevoked: active ? 0 : administrators.length }, manager);
      return agency;
    });
  }

  async createMerchant(user: User, input: CreateMerchantInput): Promise<MerchantListItem> {
    if (![UserRole.PLATFORM_ADMIN, UserRole.AGENCY_ADMIN].includes(user.role)) throw new ForbiddenException('仅平台或代理商可创建商家');
    if (user.role === UserRole.PLATFORM_ADMIN) this.merchantAccess.requirePlatformAccess(user, '创建商家', [PlatformAccessProfile.OPERATIONS]);
    const isAgencyOperator = user.role === UserRole.AGENCY_ADMIN;
    // FIX: 恢复创建商家时可设初始服务费率（此前被误停用为 GoneException「收钱吧」，本地费率是唯一来源）
    if (input.rate !== undefined && (typeof input.rate !== 'number' || !Number.isFinite(input.rate) || input.rate < 0 || input.rate > 1)) throw new BadRequestException('初始服务费率必须为 0 至 1 之间');
    if (isAgencyOperator && [input.contractNumber, input.contractEndsAt].some((value) => value !== undefined)) throw new ForbiddenException('代理商不可设置合同，请由平台完成审核配置');
    const agencyId = user.role === UserRole.AGENCY_ADMIN ? user.agencyId! : input.agencyId;
    const agency = agencyId ? await this.agencies.findOneBy({ id: agencyId }) : null;
    if (!agency) throw new BadRequestException('代理商不存在');
    if (!agency.active) throw new BadRequestException('代理商已停用，不能创建商家');
    const hasAdministrator = Boolean(input.adminName || input.adminEmail || input.adminPassword);
    if (hasAdministrator && (!input.adminName || !input.adminEmail || !input.adminPassword)) throw new BadRequestException('商家管理员姓名、账号和初始密码需要同时填写');
    const adminName = hasAdministrator ? this.requiredText(input.adminName, '商家管理员姓名', 80) : '';
    const adminEmail = hasAdministrator ? this.requiredText(input.adminEmail, '商家管理员账号', 254).toLowerCase() : '';
    if (hasAdministrator && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(adminEmail)) throw new BadRequestException('商家管理员账号格式不正确');
    if (hasAdministrator) this.authService.assertPasswordPolicy(input.adminPassword!, '商家管理员初始密码');
    const legalName = this.requiredText(input.legalName, '商家主体', 200);
    const brandName = this.requiredText(input.brandName, '品牌名称', 80);
    const servicePhone = this.optionalText(input.servicePhone, '服务电话', 40);
    const contractNumber = isAgencyOperator ? '' : this.optionalText(input.contractNumber, '合同编号', 80);
    const contractEndsAt = isAgencyOperator ? null : input.contractEndsAt ? this.requiredDate(input.contractEndsAt, '合同到期日') : null;
    const idempotencyKey = input.idempotencyKey === undefined ? null : this.requiredText(input.idempotencyKey, '商家创建请求标识', 128);
    if (idempotencyKey && !/^[A-Za-z0-9_-]{12,128}$/.test(idempotencyKey)) throw new BadRequestException('商家创建请求标识格式不正确');
    const requestHash = this.merchantCreationRequestHash({ agencyId: agency.id, legalName, brandName, servicePhone, contractNumber, contractEndsAt, hasAdministrator, adminName, adminEmail });
    if (idempotencyKey) {
      const existing = await this.merchantForCreationRetry(this.dataSource.manager, user.id, idempotencyKey);
      if (existing) {
        if (!(await this.sameMerchantCreationRetry(this.dataSource.manager, existing, requestHash, hasAdministrator, adminEmail, input.adminPassword))) throw new ConflictException('商家创建请求标识已用于其他内容，请刷新后重试');
        return this.merchantListItem(existing);
      }
    }
    if (hasAdministrator && await this.users.existsBy({ email: adminEmail })) throw new ConflictException('商家管理员账号已存在，请勿重复创建');
    const passwordHash = hasAdministrator ? await (await import('bcryptjs')).default.hash(input.adminPassword!, 10) : '';
    try {
      return await this.dataSource.transaction(async (manager) => {
        if (idempotencyKey) {
          const existing = await this.merchantForCreationRetry(manager, user.id, idempotencyKey);
          if (existing) {
            if (!(await this.sameMerchantCreationRetry(manager, existing, requestHash, hasAdministrator, adminEmail, input.adminPassword))) throw new ConflictException('商家创建请求标识已用于其他内容，请刷新后重试');
            return this.merchantListItem(existing);
          }
        }
        const created = await manager.save(Merchant, { agencyId: agency.id, legalName, brandName, servicePhone, contractNumber, contractEndsAt, status: isAgencyOperator ? MerchantStatus.SALES_SUSPENDED : MerchantStatus.ACTIVE, createdBy: user.id, creationIdempotencyKey: idempotencyKey, creationRequestHash: idempotencyKey ? requestHash : null });
        // FIX: 恢复创建商家时写入初始费率版本（与费率可调恢复配套；幂等键由商家 ID 派生，重试不重复建版本）
        if (input.rate !== undefined) {
          await manager.save(CommissionRateVersion, {
            merchantId: created.id, rate: String(input.rate), effectiveFrom: new Date(`${this.day()}T00:00:00+08:00`),
            note: '创建商家初始费率', createdBy: user.id, idempotencyKey: `merchant-creation-${created.id}`, requestHash: null,
          });
        }
        await this.registrationWorkflow.createDraft(manager, created.id, user.id);
        if (hasAdministrator) await manager.save(User, { email: adminEmail, name: adminName, passwordHash, role: UserRole.MERCHANT_ADMIN, agencyId: agency.id, merchantId: created.id, storeIds: null, active: true });
        await this.auditWriter.write(user.id, created.id, 'MERCHANT_CREATED', 'Merchant', created.id, null, { brandName: created.brandName, administratorCreated: hasAdministrator, status: created.status, awaitingPlatformContract: isAgencyOperator, idempotentRequest: Boolean(idempotencyKey), importOperationId: input.operationId || null, importExternalRef: input.importExternalRef || null }, manager);
        return this.merchantListItem(created);
      });
    } catch (error) {
      if (this.isUniqueConstraintError(error)) {
        if (idempotencyKey) {
          const existing = await this.merchantForCreationRetry(this.dataSource.manager, user.id, idempotencyKey);
          if (existing) {
            if (!(await this.sameMerchantCreationRetry(this.dataSource.manager, existing, requestHash, hasAdministrator, adminEmail, input.adminPassword))) throw new ConflictException('商家创建请求标识已用于其他内容，请刷新后重试');
            return this.merchantListItem(existing);
          }
        }
        throw new ConflictException('商家管理员账号或商家创建请求标识已存在，请勿重复创建');
      }
      throw error;
    }
  }

  async updateMerchant(user: User, merchantId: string, input: UpdateMerchantInput): Promise<MerchantListItem> {
    await this.merchantAccess.getForUser(user, merchantId, [PlatformAccessProfile.OPERATIONS, PlatformAccessProfile.FINANCE]);
    if (user.role === UserRole.STORE_STAFF) throw new ForbiddenException('核销员不可修改商家资料');
    const statusCommand = input.status !== undefined || input.expectedStatus !== undefined || input.statusReason !== undefined;
    const idempotencyKey = input.idempotencyKey === undefined ? null : this.requiredText(input.idempotencyKey, '商家经营状态请求标识', 128);
    if (idempotencyKey && !statusCommand) throw new BadRequestException('商家经营状态请求标识仅用于经营状态变更');
    if (idempotencyKey && !/^[A-Za-z0-9_-]{12,128}$/.test(idempotencyKey)) throw new BadRequestException('商家经营状态请求标识格式不正确');
    const requestHash = idempotencyKey ? this.merchantStatusCommandRequestHash(merchantId, input) : null;
    try {
      return await this.dataSource.transaction(async (manager) => {
        const merchant = await manager.findOne(Merchant, { where: { id: merchantId }, lock: { mode: 'pessimistic_write' } });
        if (!merchant) throw new NotFoundException('商家不存在');
        this.merchantAccess.ensure(user, merchant, undefined, [PlatformAccessProfile.OPERATIONS, PlatformAccessProfile.FINANCE]);
        if (idempotencyKey && requestHash) {
          this.merchantAccess.requirePlatformAccess(user, '变更商家经营状态', [PlatformAccessProfile.OPERATIONS]);
          const retried = await this.merchantStatusCommandForRetry(manager, merchantId, user.id, idempotencyKey);
          if (retried) {
            this.assertSameMerchantStatusCommand(retried, requestHash);
            return this.merchantListItem(merchant);
          }
        }
        const before = { ...merchant } as unknown as Record<string, unknown>;
        const updates: Partial<Merchant> = {};
        if (input.brandName !== undefined) updates.brandName = this.requiredText(input.brandName, '品牌名称', 80);
        if (input.legalName !== undefined) {
          await this.registrationWorkflow.assertLegalNameEditable(manager, merchantId);
          updates.legalName = this.requiredText(input.legalName, '商家主体', 200);
        }
        if (input.servicePhone !== undefined) updates.servicePhone = this.optionalText(input.servicePhone, '服务电话', 40);
        if (input.primaryColor !== undefined) {
          if (typeof input.primaryColor !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(input.primaryColor)) throw new BadRequestException('品牌主色必须为 6 位十六进制颜色值');
          updates.primaryColor = input.primaryColor;
        }
        if (input.rating !== undefined) {
          if (typeof input.rating !== 'string' || !/^([0-4](\.[0-9])?|5(\.0)?)$/.test(input.rating)) throw new BadRequestException('评分必须为 0-5（支持一位小数）');
          updates.rating = input.rating;
        }
        if (input.featureTags !== undefined) {
          if (!Array.isArray(input.featureTags) || input.featureTags.some((tag) => typeof tag !== 'string' || tag.length > 12)) throw new BadRequestException('附加服务标签格式不正确');
          updates.featureTags = Array.from(new Set(input.featureTags.map((tag) => tag.trim()).filter(Boolean))).slice(0, 12);
        }
        let statusReason = '';
        let statusChanged = false;
        if (statusCommand) {
          this.merchantAccess.requirePlatformAccess(user, '变更商家经营状态', [PlatformAccessProfile.OPERATIONS]);
          if (input.status === undefined) throw new BadRequestException('变更经营状态时必须提供目标状态');
          if (!Object.values(MerchantStatus).includes(input.status)) throw new BadRequestException('商家经营状态不正确');
          if (input.expectedStatus === undefined) throw new BadRequestException('变更经营状态时必须提供操作前状态');
          if (input.expectedStatus !== merchant.status) throw new ConflictException('商家经营状态已被其他操作更新，请刷新后重试');
          statusChanged = input.status !== merchant.status;
          if (statusChanged) statusReason = this.requiredText(input.statusReason, '经营状态变更说明', 500);
          else if (input.statusReason !== undefined) throw new BadRequestException('经营状态未变化，无需填写变更说明');
          updates.status = input.status;
        }
        if (user.role === UserRole.PLATFORM_ADMIN) {
          if (input.contractNumber !== undefined || input.contractEndsAt !== undefined) this.merchantAccess.requirePlatformAccess(user, '维护商家合同', [PlatformAccessProfile.FINANCE]);
          if (input.contractNumber !== undefined) updates.contractNumber = this.optionalText(input.contractNumber, '合同编号', 80);
          if (input.contractEndsAt !== undefined) updates.contractEndsAt = input.contractEndsAt ? this.requiredDate(input.contractEndsAt, '合同到期日') : null;
        }
        if (!Object.keys(updates).length) throw new BadRequestException('未提供可修改字段');
        const exitCase = updates.status === undefined ? null : await this.merchantExitService.prepareStatusTransition(manager, user, merchant, updates.status, statusChanged, statusReason);
        // Offline agency cooperation governs only new merchant publishing. It
        // never stops an already-operating merchant because of an SaaS fee.
        if (idempotencyKey && requestHash) {
          await manager.save(MerchantStatusChangeCommand, { merchantId, requestedBy: user.id, expectedStatus: input.expectedStatus!, targetStatus: input.status!, idempotencyKey, requestHash });
        }
        Object.assign(merchant, updates);
        const saved = await manager.save(Merchant, merchant);
        const auditAfter = statusChanged ? { ...updates, statusReason } : updates;
        await this.auditWriter.write(user.id, merchant.id, statusChanged ? 'MERCHANT_STATUS_CHANGED' : 'MERCHANT_UPDATED', 'Merchant', merchant.id, before, auditAfter as Record<string, unknown>, manager);
        if (updates.status !== undefined) await this.merchantExitService.completeStatusTransition(manager, user, merchant.id, updates.status, exitCase);
        return this.merchantListItem(saved);
      });
    } catch (error) {
      if (idempotencyKey && requestHash && this.isUniqueConstraintError(error)) {
        const retried = await this.merchantStatusCommandForRetry(this.dataSource.manager, merchantId, user.id, idempotencyKey);
        if (retried) {
          this.assertSameMerchantStatusCommand(retried, requestHash);
          const merchant = await this.merchants.findOneBy({ id: merchantId });
          if (merchant) return this.merchantListItem(merchant);
        }
      }
      if (this.isUniqueConstraintError(error)) throw new ConflictException('商家资料与现有记录冲突，请刷新后重试');
      throw error;
    }
  }

  private merchantCreationRequestHash(input: { agencyId: string; legalName: string; brandName: string; servicePhone: string; contractNumber: string; contractEndsAt: Date | null; hasAdministrator: boolean; adminName: string; adminEmail: string }): string {
    return createHash('sha256').update(JSON.stringify({
      version: 1, agencyId: input.agencyId, legalName: input.legalName, brandName: input.brandName,
      servicePhone: input.servicePhone, contractNumber: input.contractNumber,
      contractEndsAt: input.contractEndsAt ? this.day(input.contractEndsAt) : null,
      hasAdministrator: input.hasAdministrator,
      adminName: input.adminName, adminEmail: input.adminEmail,
    })).digest('hex');
  }

  private async merchantForCreationRetry(manager: EntityManager, createdBy: string, idempotencyKey: string): Promise<Merchant | null> {
    return manager.getRepository(Merchant).createQueryBuilder('merchant')
      .addSelect(['merchant.createdBy', 'merchant.creationIdempotencyKey', 'merchant.creationRequestHash'])
      .where('merchant.createdBy = :createdBy AND merchant.creationIdempotencyKey = :idempotencyKey', { createdBy, idempotencyKey })
      .getOne();
  }

  private async sameMerchantCreationRetry(manager: EntityManager, merchant: Merchant, requestHash: string, hasAdministrator: boolean, adminEmail: string, adminPassword?: string): Promise<boolean> {
    if (merchant.creationRequestHash !== requestHash) return false;
    if (!hasAdministrator) return true;
    const administrator = await manager.getRepository(User).createQueryBuilder('user')
      .addSelect('user.passwordHash')
      .where('user.merchantId = :merchantId AND user.role = :role', { merchantId: merchant.id, role: UserRole.MERCHANT_ADMIN })
      .getOne();
    if (!administrator || administrator.email !== adminEmail || !adminPassword) return false;
    return (await import('bcryptjs')).default.compare(adminPassword, administrator.passwordHash);
  }

  private merchantStatusCommandRequestHash(merchantId: string, input: UpdateMerchantInput): string {
    return createHash('sha256').update(JSON.stringify({
      merchantId, brandName: input.brandName?.trim() ?? null, legalName: input.legalName?.trim() ?? null,
      servicePhone: input.servicePhone?.trim() ?? null, primaryColor: input.primaryColor ?? null,
      expectedStatus: input.expectedStatus ?? null, status: input.status ?? null,
      statusReason: input.statusReason?.trim() ?? null, contractNumber: input.contractNumber?.trim() ?? null,
      contractEndsAt: input.contractEndsAt ?? null,
    })).digest('hex');
  }

  private async merchantStatusCommandForRetry(manager: EntityManager, merchantId: string, requestedBy: string, idempotencyKey: string): Promise<MerchantStatusChangeCommand | null> {
    return manager.getRepository(MerchantStatusChangeCommand).createQueryBuilder('command')
      .addSelect(['command.idempotencyKey', 'command.requestHash'])
      .where('command.merchantId = :merchantId AND command.requestedBy = :requestedBy AND command.idempotencyKey = :idempotencyKey', { merchantId, requestedBy, idempotencyKey })
      .getOne();
  }

  private assertSameMerchantStatusCommand(command: MerchantStatusChangeCommand, requestHash: string): void {
    if (command.requestHash !== requestHash) throw new ConflictException('商家经营状态请求标识已用于其他内容，请刷新后重试');
  }

  private safeUser(user: User): SafeUser {
    const { passwordHash: _passwordHash, sessionVersion: _sessionVersion, ...safe } = user;
    return safe;
  }

  private merchantListItem(merchant: Merchant): MerchantListItem {
    const { createdBy: _createdBy, creationIdempotencyKey: _creationIdempotencyKey, creationRequestHash: _creationRequestHash, ...safe } = merchant;
    return safe;
  }

  private requiredText(value: unknown, label: string, maxLength = 120): string {
    if (typeof value !== 'string') throw new BadRequestException(`${label}格式不正确`);
    const normalized = value.trim();
    if (!normalized || normalized.length > maxLength) throw new BadRequestException(`${label}不能为空且不能超过 ${maxLength} 个字符`);
    return normalized;
  }

  private optionalText(value: unknown, label: string, maxLength: number): string {
    if (value === undefined || value === null || value === '') return '';
    return this.requiredText(value, label, maxLength);
  }

  private requiredDate(value: unknown, label: string): Date {
    const date = new Date(String(value));
    if (Number.isNaN(date.getTime())) throw new BadRequestException(`${label}格式不正确`);
    return date;
  }

  private day(date: Date | string = new Date()): string {
    const values = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(date)).filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
    return `${values.year}-${values.month}-${values.day}`;
  }

  private isUniqueConstraintError(error: unknown): boolean {
    return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === '23505';
  }
}
