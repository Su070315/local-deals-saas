import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash, randomBytes } from 'crypto';
import { DataSource, EntityManager, In, Repository } from 'typeorm';
import { PlatformAccessProfile, StaffActiveCommand, Store, User, UserRole } from './domain/entities';
import type { SafeUser } from './app-service.core-types';
import { AuditWriterService } from './audit-writer.service';
import { AuthService } from './auth.service';
import { MerchantAccessService } from './merchant-access.service';
import { WechatPlatformService } from './wechat-platform.service';
import { CustomerAuthService } from './customer-auth.service';

export type SaveStaffInput = { id?: string; email: string; name: string; password?: string; storeIds: string[] };

@Injectable()
export class StaffService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly auditWriter: AuditWriterService,
    private readonly merchantAccess: MerchantAccessService,
    private readonly authService: AuthService,
    private readonly wechatPlatform: WechatPlatformService,
    private readonly customerAuth: CustomerAuthService,
    @InjectRepository(Store) private readonly stores: Repository<Store>,
    @InjectRepository(User) private readonly users: Repository<User>,
  ) {}

  async listUsers(user: User, merchantId: string): Promise<SafeUser[]> {
    await this.merchantAccess.getForUser(user, merchantId, [PlatformAccessProfile.OPERATIONS]);
    if (user.role === UserRole.STORE_STAFF) throw new ForbiddenException('核销员不可查看员工');
    return (await this.users.find({ where: { merchantId }, order: { createdAt: 'ASC' } })).map((record) => this.safeUser(record));
  }

  async saveStaff(user: User, merchantId: string, input: SaveStaffInput): Promise<SafeUser> {
    const merchant = await this.merchantAccess.getForUser(user, merchantId, [PlatformAccessProfile.OPERATIONS]);
    if (![UserRole.PLATFORM_ADMIN, UserRole.AGENCY_ADMIN, UserRole.MERCHANT_ADMIN].includes(user.role)) throw new ForbiddenException('无权管理员工');
    if (user.role === UserRole.PLATFORM_ADMIN) this.merchantAccess.requirePlatformAccess(user, '管理核销员工', [PlatformAccessProfile.OPERATIONS]);
    const name = this.requiredText(input.name, '员工姓名', 80);
    if (!Array.isArray(input.storeIds)) throw new BadRequestException('门店授权格式不正确');
    const allowedStores = await this.stores.countBy({ id: In(input.storeIds), merchantId });
    if (allowedStores !== input.storeIds.length || !input.storeIds.length) throw new BadRequestException('请至少选择一个本商家门店');
    try {
      return await this.dataSource.transaction(async (manager) => {
        let staff: User;
        let authorizationChanged = false;
        let before: { name: string; storeIds: string[]; sessionVersion: number } | null = null;
        if (input.id) {
          const existing = await manager.findOne(User, { where: { id: input.id, merchantId, role: UserRole.STORE_STAFF }, lock: { mode: 'pessimistic_write' } });
          if (!existing) throw new NotFoundException('核销员工不存在');
          staff = existing;
          before = { name: existing.name, storeIds: [...(existing.storeIds || [])], sessionVersion: existing.sessionVersion };
          authorizationChanged = !this.sameStoreScope(existing.storeIds || [], input.storeIds);
          staff.name = name;
          staff.storeIds = input.storeIds;
          if (input.password) {
            this.authService.assertPasswordPolicy(input.password);
            const bcrypt = await import('bcryptjs');
            staff.passwordHash = await bcrypt.default.hash(input.password, 10);
            staff.sessionVersion += 1;
          }
          if (authorizationChanged && !input.password) staff.sessionVersion += 1;
        } else {
          if (!input.password) throw new BadRequestException('初始密码不能为空');
          this.authService.assertPasswordPolicy(input.password, '初始密码');
          const email = this.requiredText(input.email, '员工登录账号', 254).toLowerCase();
          if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new BadRequestException('员工登录账号格式不正确');
          if (await manager.existsBy(User, { email })) throw new ConflictException('员工登录账号已存在，请勿重复创建');
          const bcrypt = await import('bcryptjs');
          staff = manager.create(User, { email, name, passwordHash: await bcrypt.default.hash(input.password, 10), role: UserRole.STORE_STAFF, agencyId: merchant.agencyId, merchantId, storeIds: input.storeIds, active: true });
        }
        const saved = await manager.save(User, staff);
        await this.auditWriter.write(user.id, merchantId, input.id ? 'STAFF_UPDATED' : 'STAFF_CREATED', 'User', saved.id, before, { name: saved.name, storeIds: saved.storeIds, passwordReset: Boolean(input.id && input.password), authorizationChanged }, manager);
        return this.safeUser(saved);
      });
    } catch (error) {
      if (this.isUniqueConstraintError(error)) throw new ConflictException('员工登录账号已存在，请勿重复创建');
      throw error;
    }
  }

  async setStaffActive(user: User, merchantId: string, staffId: string, active: boolean, rawIdempotencyKey?: string): Promise<SafeUser> {
    await this.merchantAccess.getForUser(user, merchantId, [PlatformAccessProfile.OPERATIONS]);
    if (user.role === UserRole.STORE_STAFF) throw new ForbiddenException('无权停用员工');
    if (user.role === UserRole.PLATFORM_ADMIN) this.merchantAccess.requirePlatformAccess(user, active ? '启用核销员工' : '停用核销员工', [PlatformAccessProfile.OPERATIONS]);
    const idempotencyKey = rawIdempotencyKey === undefined ? null : this.requiredText(rawIdempotencyKey, '员工启停请求标识', 128);
    if (idempotencyKey && !/^[A-Za-z0-9_-]{12,128}$/.test(idempotencyKey)) throw new BadRequestException('员工启停请求标识格式不正确');
    const requestHash = idempotencyKey ? this.commandRequestHash(merchantId, staffId, active) : null;
    try {
      return await this.dataSource.transaction(async (manager) => {
        const staff = await manager.findOne(User, { where: { id: staffId, merchantId, role: UserRole.STORE_STAFF }, lock: { mode: 'pessimistic_write' } });
        if (!staff) throw new NotFoundException('核销员工不存在');
        if (idempotencyKey && requestHash) {
          const retried = await this.commandForRetry(manager, merchantId, staffId, user.id, idempotencyKey);
          if (retried) {
            this.assertSameCommand(retried, requestHash);
            return this.safeUser(staff);
          }
          await manager.save(StaffActiveCommand, { merchantId, staffId, requestedBy: user.id, active, idempotencyKey, requestHash });
        }
        if (staff.active === active) return this.safeUser(staff);
        const before = { active: staff.active, sessionVersion: staff.sessionVersion };
        staff.active = active;
        staff.sessionVersion += 1;
        const saved = await manager.save(User, staff);
        await this.auditWriter.write(user.id, merchantId, active ? 'STAFF_ENABLED' : 'STAFF_DISABLED', 'User', staffId, before, { active, sessionVersion: saved.sessionVersion }, manager);
        return this.safeUser(saved);
      });
    } catch (error) {
      if (idempotencyKey && requestHash && this.isUniqueConstraintError(error)) {
        const retried = await this.commandForRetry(this.dataSource.manager, merchantId, staffId, user.id, idempotencyKey);
        if (retried) {
          this.assertSameCommand(retried, requestHash);
          const staff = await this.users.findOneBy({ id: staffId, merchantId, role: UserRole.STORE_STAFF });
          if (staff) return this.safeUser(staff);
        }
      }
      throw error;
    }
  }

  /** 核销员解绑：sessionVersion+1 使该核销员所有已签发登录态（含网页核销台 30 天长期会话）立即失效，
   * 需重新扫码核销台二维码登录后恢复核销能力。 */
  async unbindVerifier(user: User, merchantId: string, staffId: string): Promise<SafeUser> {
    await this.merchantAccess.getForUser(user, merchantId, [PlatformAccessProfile.OPERATIONS]);
    if (user.role === UserRole.STORE_STAFF) throw new ForbiddenException('无权解绑核销员工');
    if (user.role === UserRole.PLATFORM_ADMIN) this.merchantAccess.requirePlatformAccess(user, '解绑核销员工', [PlatformAccessProfile.OPERATIONS]);
    return this.dataSource.transaction(async (manager) => {
      const staff = await manager.findOne(User, { where: { id: staffId, merchantId, role: UserRole.STORE_STAFF }, lock: { mode: 'pessimistic_write' } });
      if (!staff) throw new NotFoundException('核销员工不存在');
      const before = { sessionVersion: staff.sessionVersion, wechatOpenid: staff.wechatOpenid };
      staff.sessionVersion += 1;
      staff.wechatOpenid = null;
      staff.wechatBindToken = null;
      staff.wechatBindTokenExpiresAt = null;
      const saved = await manager.save(User, staff);
      await this.auditWriter.write(user.id, merchantId, 'STAFF_UNBOUND', 'User', staffId, before, { sessionVersion: saved.sessionVersion, wechatOpenid: saved.wechatOpenid }, manager);
      return this.safeUser(saved);
    });
  }

  /**
   * 商家端发起核销员微信绑定：生成一次性 bindToken（15 分钟有效），
   * 并生成顾客小程序绑定页的微信小程序码（scene 携带 staffId + bindToken），商家端直接展示图片。
   */
  async createWechatBindToken(user: User, merchantId: string, staffId: string): Promise<{ bindToken: string; expiresInSeconds: number; staffId: string; qrDataUrl: string }> {
    await this.merchantAccess.getForUser(user, merchantId, [PlatformAccessProfile.OPERATIONS]);
    if (user.role === UserRole.STORE_STAFF) throw new ForbiddenException('无权发起核销员绑定');
    const staff = await this.users.findOneBy({ id: staffId, merchantId, role: UserRole.STORE_STAFF });
    if (!staff) throw new NotFoundException('核销员工不存在');
    if (staff.wechatOpenid) throw new BadRequestException('该核销员已绑定微信，请先解绑再重新绑定');
    const bindToken = randomBytes(16).toString('base64url');
    const expiresInSeconds = 15 * 60;
    staff.wechatBindToken = createHash('sha256').update(bindToken).digest('hex');
    staff.wechatBindTokenExpiresAt = new Date(Date.now() + expiresInSeconds * 1000);
    await this.users.save(staff);
    await this.auditWriter.write(user.id, merchantId, 'STAFF_WECHAT_BIND_TOKEN_CREATED', 'User', staffId, { wechatOpenid: null }, { expiresAt: staff.wechatBindTokenExpiresAt }, undefined as never);
    // 生成顾客小程序绑定页小程序码。
    // scene 直接放 bindToken（22 字符 base64url），不再 JSON 包装：
    // 微信 getwxacodeunlimit 的 scene 参数最多 32 个可见字符，JSON+base64url 会超长被截断，
    // 前端扫码后解不出 bindToken 报「绑定链接无效」。staffId 由 bindToken 反查，无需进 scene。
    const qrDataUrl = await this.wechatPlatform.createVerifierBindMiniProgramQr(merchantId, bindToken);
    return { bindToken, expiresInSeconds, staffId, qrDataUrl };
  }

  /**
   * 顾客小程序内确认绑定：用当前顾客的 openid（CustomerProfile 加密存储）匹配核销员 bindToken。
   * 绑定后同一微信（顾客小程序 appid 下）即为核销员，可在「我的」页进入员工核销。
   */
  async confirmWechatBindByOpenid(customerId: string, bindToken: string): Promise<{ staffName: string; merchantName: string }> {
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(bindToken)) throw new BadRequestException('绑定令牌格式不正确');
    const openid = await this.customerAuth.openidOf(customerId).catch(() => null);
    if (!openid) throw new BadRequestException('无法识别当前微信身份，请重新打开小程序');
    const tokenHash = createHash('sha256').update(bindToken).digest('hex');
    return this.dataSource.transaction(async (manager) => {
      const staff = await manager.findOne(User, { where: { wechatBindToken: tokenHash, role: UserRole.STORE_STAFF } });
      if (!staff || !staff.wechatBindTokenExpiresAt || staff.wechatBindTokenExpiresAt.getTime() <= Date.now()) {
        throw new BadRequestException('绑定二维码已失效，请在商家后台重新发起绑定');
      }
      const existing = await manager.findOne(User, { where: { wechatOpenid: openid, role: UserRole.STORE_STAFF } });
      if (existing && existing.id !== staff.id) throw new ConflictException('该微信已绑定其他核销员，请先解绑');
      if (staff.wechatOpenid === openid) return { staffName: staff.name, merchantName: '已绑定' };
      const before = { wechatOpenid: staff.wechatOpenid, wechatBindToken: staff.wechatBindToken };
      staff.wechatOpenid = openid;
      staff.wechatBindToken = null;
      staff.wechatBindTokenExpiresAt = null;
      const saved = await manager.save(User, staff);
      await this.auditWriter.write('system', staff.merchantId, 'STAFF_WECHAT_BOUND', 'User', staff.id, before, { wechatOpenid: saved.wechatOpenid }, manager);
      return { staffName: saved.name, merchantName: '' };
    });
  }
  /** 核销员微信扫码确认绑定（核销小程序路径）：wx.login code 换 openid 后绑定。 */
  async confirmWechatBind(code: string, appId: string, bindToken: string): Promise<{ staffName: string; merchantName: string }> {
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(bindToken)) throw new BadRequestException('绑定令牌格式不正确');
    const openid = await this.wechatPlatform.exchangeCustomerOpenid(code, appId);
    const tokenHash = createHash('sha256').update(bindToken).digest('hex');
    return this.dataSource.transaction(async (manager) => {
      const staff = await manager.findOne(User, {
        where: { wechatBindToken: tokenHash, role: UserRole.STORE_STAFF },
      });
      if (!staff || !staff.wechatBindTokenExpiresAt || staff.wechatBindTokenExpiresAt.getTime() <= Date.now()) {
        throw new BadRequestException('绑定二维码已失效，请在商家后台重新发起绑定');
      }
      const existing = await manager.findOne(User, { where: { wechatOpenid: openid, role: UserRole.STORE_STAFF } });
      if (existing && existing.id !== staff.id) throw new ConflictException('该微信已绑定其他核销员，请先解绑');
      if (staff.wechatOpenid === openid) {
        return { staffName: staff.name, merchantName: '已绑定' };
      }
      const before = { wechatOpenid: staff.wechatOpenid, wechatBindToken: staff.wechatBindToken };
      staff.wechatOpenid = openid;
      staff.wechatBindToken = null;
      staff.wechatBindTokenExpiresAt = null;
      const saved = await manager.save(User, staff);
      await this.auditWriter.write('system', staff.merchantId, 'STAFF_WECHAT_BOUND', 'User', staff.id, before, { wechatOpenid: saved.wechatOpenid }, manager);
      return { staffName: saved.name, merchantName: '' };
    });
  }

  private commandRequestHash(merchantId: string, staffId: string, active: boolean): string {
    return createHash('sha256').update(JSON.stringify({ merchantId, staffId, active })).digest('hex');
  }

  private async commandForRetry(manager: EntityManager, merchantId: string, staffId: string, requestedBy: string, idempotencyKey: string): Promise<StaffActiveCommand | null> {
    return manager.getRepository(StaffActiveCommand).createQueryBuilder('command')
      .addSelect(['command.idempotencyKey', 'command.requestHash'])
      .where('command.merchantId = :merchantId AND command.staffId = :staffId AND command.requestedBy = :requestedBy AND command.idempotencyKey = :idempotencyKey', { merchantId, staffId, requestedBy, idempotencyKey })
      .getOne();
  }

  private assertSameCommand(command: StaffActiveCommand, requestHash: string): void {
    if (command.requestHash !== requestHash) throw new ConflictException('员工启停请求标识已用于其他内容，请刷新后重试');
  }

  private safeUser(user: User): SafeUser {
    const { passwordHash: _passwordHash, sessionVersion: _sessionVersion, ...safe } = user;
    return safe;
  }

  private sameStoreScope(left: string[], right: string[]): boolean {
    return JSON.stringify([...new Set(left)].sort()) === JSON.stringify([...new Set(right)].sort());
  }

  private requiredText(value: unknown, label: string, maxLength: number): string {
    if (typeof value !== 'string') throw new BadRequestException(`${label}格式不正确`);
    const normalized = value.trim();
    if (!normalized || normalized.length > maxLength) throw new BadRequestException(`${label}不能为空且不能超过 ${maxLength} 个字符`);
    return normalized;
  }

  private isUniqueConstraintError(error: unknown): boolean {
    return typeof error === 'object' && error !== null && ('code' in error && (error as { code?: string }).code === '23505' || 'message' in error && /unique|duplicate/i.test(String((error as { message?: unknown }).message)));
  }
}
