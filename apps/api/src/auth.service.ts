import { BadRequestException, ForbiddenException, HttpException, HttpStatus, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import bcrypt from 'bcryptjs';
import { createHmac } from 'crypto';
import jwt from 'jsonwebtoken';
import { DataSource, EntityManager, IsNull, LessThan, MoreThan, Repository } from 'typeorm';
import { AuthSession, LoginThrottle, User, UserRole } from './domain/entities';
import { AuditContextService } from './audit-context';
import { AuditOutboxService } from './audit-outbox.service';
import { OPERATOR_TOKEN_AUDIENCE, TOKEN_ISSUER } from './token-policy';
import { throttleKeySecret } from './runtime-config';
import type { SafeUser } from './app-service.core-types';
import { WechatPlatformService } from './wechat-platform.service';

const LOGIN_WINDOW_MS = 15 * 60_000;
const ACCOUNT_FAILURE_LIMIT = 5;
const IP_FAILURE_LIMIT = 20;
const MIN_PASSWORD_LENGTH = 10;

@Injectable()
export class AuthService {
  constructor(
    @InjectRepository(User) private readonly users: Repository<User>,
    @InjectRepository(AuthSession) private readonly sessions: Repository<AuthSession>,
    @InjectRepository(LoginThrottle) private readonly throttles: Repository<LoginThrottle>,
    private readonly dataSource: DataSource,
    private readonly auditContext: AuditContextService,
    private readonly auditOutbox: AuditOutboxService,
    private readonly wechatPlatform: WechatPlatformService,
  ) {}

  async login(email: string, password: string, context: { ipAddress: string; userAgent: string; requiredRole?: UserRole; longLived?: boolean }) {
    const identity = String(email || '').trim().toLowerCase();
    const accountThrottleKey = this.throttleKey(identity);
    const ipThrottleKey = this.ipThrottleKey(context.ipAddress);
    await this.assertNotBlocked(accountThrottleKey);
    await this.assertNotBlocked(ipThrottleKey);
    const user = await this.users.createQueryBuilder('user').addSelect('user.passwordHash').where('user.email = :email', { email: identity }).getOne();
    if (!user?.active || typeof password !== 'string' || !(await bcrypt.compare(password, user.passwordHash))) {
      await this.recordFailure(accountThrottleKey, ACCOUNT_FAILURE_LIMIT);
      await this.recordFailure(ipThrottleKey, IP_FAILURE_LIMIT);
      throw new UnauthorizedException('账号或密码不正确');
    }
    if (context.requiredRole && user.role !== context.requiredRole) throw new UnauthorizedException('账号或密码不正确');
    await this.throttles.delete({ throttleKey: accountThrottleKey });
    return this.createSessionAndToken(user, context);
  }

  /**
   * 核销员微信免密登录：核销小程序 wx.login 的 code → 第三方平台 jscode2session 换 openid →
   * 匹配已绑定微信的核销员（STORE_STAFF + wechatOpenid）→ 签发 30 天长期会话（与网页核销台一致，扫码一次长期有效）。
   * 未绑定的 openid → 拒绝并提示先到商家后台绑定。
   */
  async verifierWechatLogin(code: string, appId: string, context: { ipAddress: string; userAgent: string }) {
    if (!code) throw new BadRequestException('缺少微信登录凭证');
    const openid = await this.wechatPlatform.exchangeCustomerOpenid(code, appId);
    const verifier = await this.users.findOne({ where: { wechatOpenid: openid, role: UserRole.STORE_STAFF } });
    if (!verifier) throw new ForbiddenException('该微信尚未绑定核销员账号，请联系商家在「员工管理」中绑定');
    if (!verifier.active) throw new ForbiddenException('该核销员账号已停用，请联系商家');
    return this.createSessionAndToken(verifier, { ...context, longLived: true });
  }

  /** 创建登录会话并签发 JWT（AuthGuard 依赖 AuthSession + sub/sid/sv 三要素）。
   * longLived=true（网页核销台登录）签发 30 天长期会话，配合 AuthGuard 滑窗续期实现"扫码一次长期有效"。 */
  private async createSessionAndToken(user: User, context: { ipAddress: string; userAgent: string; longLived?: boolean }) {
    const ttlMs = context.longLived ? 30 * 24 * 60 * 60_000 : 12 * 60 * 60_000;
    const expiresAt = new Date(Date.now() + ttlMs);
    const session = await this.sessions.save({ userId: user.id, sessionVersion: user.sessionVersion, ipAddress: context.ipAddress.slice(0, 64), userAgent: context.userAgent.slice(0, 512), expiresAt, lastSeenAt: new Date(), stepUpVerifiedAt: null, revokedAt: null });
    const token = jwt.sign(
      { sub: user.id, sid: session.id, sv: user.sessionVersion },
      process.env.JWT_SECRET || 'dev-jwt-secret',
      { issuer: TOKEN_ISSUER, audience: OPERATOR_TOKEN_AUDIENCE, expiresIn: context.longLived ? '30d' : '12h' },
    );
    return { token, user: this.profile(user) };
  }

  assertPasswordPolicy(password: string, fieldName = '新密码'): void {
    if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH || password.length > 512) {
      throw new BadRequestException(`${fieldName}至少需要 ${MIN_PASSWORD_LENGTH} 位`);
    }
    const categories = [/[a-z]/.test(password), /[A-Z]/.test(password), /\d/.test(password), /[^A-Za-z0-9]/.test(password)].filter(Boolean).length;
    if (categories < 3) throw new BadRequestException(`${fieldName}需包含大小写字母、数字或符号中的至少三类字符`);
  }

  async logout(userId: string, sessionId: string) {
    await this.sessions.update({ id: sessionId, userId }, { revokedAt: new Date() });
  }

  async listSessions(userId: string, sessionVersion: number, currentSessionId: string) {
    const sessions = await this.sessions.find({
      where: { userId, sessionVersion, revokedAt: IsNull(), expiresAt: MoreThan(new Date()) },
      order: { lastSeenAt: 'DESC' },
    });
    return sessions.map((session) => ({
      id: session.id,
      ipAddress: session.ipAddress,
      userAgent: session.userAgent,
      createdAt: session.createdAt,
      lastSeenAt: session.lastSeenAt,
      expiresAt: session.expiresAt,
      current: session.id === currentSessionId,
    }));
  }

  async revokeSession(userId: string, sessionId: string) {
    const session = await this.sessions.findOneBy({ id: sessionId, userId });
    if (!session || session.revokedAt || new Date(session.expiresAt) <= new Date()) throw new NotFoundException('登录设备不存在');
    await this.sessions.update(session.id, { revokedAt: new Date() });
  }

  async logoutOthers(userId: string, currentSessionId: string) {
    await this.sessions.createQueryBuilder()
      .update()
      .set({ revokedAt: new Date() })
      .where('userId = :userId', { userId })
      .andWhere('id <> :currentSessionId', { currentSessionId })
      .andWhere('revokedAt IS NULL')
      .execute();
  }

  async confirmSensitiveAction(userId: string, sessionId: string, currentPassword: string): Promise<Date> {
    if (typeof currentPassword !== 'string' || !currentPassword) throw new UnauthorizedException('当前密码不正确');
    return this.dataSource.transaction(async (manager) => {
      const user = await manager.createQueryBuilder(User, 'user').addSelect('user.passwordHash').setLock('pessimistic_write').where('user.id = :userId', { userId }).getOne();
      const session = await manager.findOne(AuthSession, { where: { id: sessionId, userId }, lock: { mode: 'pessimistic_write' } });
      if (!user?.active || !session || session.sessionVersion !== user.sessionVersion || session.revokedAt || new Date(session.expiresAt) <= new Date()) {
        throw new UnauthorizedException('会话已失效');
      }
      if (!(await bcrypt.compare(currentPassword, user.passwordHash))) throw new UnauthorizedException('当前密码不正确');
      const verifiedAt = new Date();
      session.stepUpVerifiedAt = verifiedAt;
      await manager.save(AuthSession, session);
      const context = this.auditContext.current();
      await this.auditOutbox.enqueue(manager, {
        actorId: user.id,
        merchantId: user.merchantId,
        action: 'SENSITIVE_ACTION_REAUTHENTICATED',
        resourceType: 'AuthSession',
        resourceId: session.id,
        before: null,
        after: { validForSeconds: 600 },
        requestId: context?.requestId || '',
        actorRole: context?.actorRole || user.role,
        ipAddress: context?.ipAddress || '',
        userAgent: context?.userAgent || '',
      });
      return verifiedAt;
    });
  }

  async changePassword(userId: string, currentPassword: string, newPassword: string): Promise<void> {
    this.assertPasswordPolicy(newPassword);
    await this.dataSource.transaction(async (manager) => {
      const user = await manager.createQueryBuilder(User, 'user').addSelect('user.passwordHash').setLock('pessimistic_write').where('user.id = :userId', { userId }).getOne();
      if (!user?.active || !(await bcrypt.compare(currentPassword, user.passwordHash))) throw new UnauthorizedException('当前密码不正确');
      user.passwordHash = await bcrypt.hash(newPassword, 10);
      user.sessionVersion += 1;
      await manager.save(User, user);
      await manager.createQueryBuilder().update(AuthSession).set({ revokedAt: new Date() }).where('userId = :userId', { userId }).andWhere('revokedAt IS NULL').execute();
      await manager.delete(LoginThrottle, { throttleKey: this.throttleKey(user.email) });
      const context = this.auditContext.current();
      await this.auditOutbox.enqueue(manager, {
        actorId: user.id, merchantId: user.merchantId, action: 'USER_PASSWORD_CHANGED', resourceType: 'User', resourceId: user.id,
        before: null, after: { sessionsInvalidated: true },
        requestId: context?.requestId || '', actorRole: context?.actorRole || user.role,
        ipAddress: context?.ipAddress || '', userAgent: context?.userAgent || '',
      });
    });
  }

  async resetPassword(userId: string, newPassword: string, afterReset?: (manager: EntityManager, user: User) => Promise<void>): Promise<User> {
    this.assertPasswordPolicy(newPassword);
    return this.dataSource.transaction(async (manager) => {
      const user = await manager.createQueryBuilder(User, 'user').addSelect('user.passwordHash').setLock('pessimistic_write').where('user.id = :userId', { userId }).getOne();
      if (!user) throw new NotFoundException('账号不存在');
      if (!user.active) throw new BadRequestException('账号已停用，不能重置密码');
      user.passwordHash = await bcrypt.hash(newPassword, 10);
      user.sessionVersion += 1;
      await manager.save(User, user);
      await manager.createQueryBuilder().update(AuthSession).set({ revokedAt: new Date() }).where('userId = :userId', { userId }).andWhere('revokedAt IS NULL').execute();
      await manager.delete(LoginThrottle, { throttleKey: this.throttleKey(user.email) });
      if (afterReset) await afterReset(manager, user);
      return user;
    });
  }

  private throttleKey(identity: string): string {
    return createHmac('sha256', throttleKeySecret()).update(identity).digest('hex');
  }

  private ipThrottleKey(ipAddress: string): string {
    const normalized = String(ipAddress || '').trim().toLowerCase().replace(/^::ffff:/, '').slice(0, 64) || 'unknown';
    return createHmac('sha256', throttleKeySecret()).update(`ip:${normalized}`).digest('hex');
  }

  private async assertNotBlocked(throttleKey: string) {
    const attempt = await this.throttles.findOneBy({ throttleKey });
    if (!attempt) return;
    const now = new Date();
    if (new Date(attempt.resetAt) <= now) { await this.throttles.delete({ throttleKey: attempt.throttleKey }); return; }
    if (attempt.blockedUntil && new Date(attempt.blockedUntil) > now) {
      const retryAfterSeconds = Math.max(1, Math.ceil((new Date(attempt.blockedUntil).getTime() - now.getTime()) / 1000));
      throw new HttpException({ statusCode: HttpStatus.TOO_MANY_REQUESTS, message: '登录失败次数过多，请稍后再试', retryAfterSeconds }, HttpStatus.TOO_MANY_REQUESTS);
    }
  }

  private async recordFailure(throttleKey: string, limit: number) {
    const now = new Date();
    const nextResetAt = new Date(now.getTime() + LOGIN_WINDOW_MS);
    await this.throttles.query(`
      INSERT INTO "login_throttles" ("throttleKey", "failureCount", "resetAt", "blockedUntil")
      VALUES ($1, 1, $2, NULL)
      ON CONFLICT ("throttleKey") DO UPDATE
      SET "blockedUntil" = CASE
            WHEN "login_throttles"."resetAt" <= $3 THEN NULL
            WHEN "login_throttles"."blockedUntil" IS NOT NULL AND "login_throttles"."blockedUntil" > $3 THEN "login_throttles"."blockedUntil"
            WHEN "login_throttles"."failureCount" + 1 >= $4 THEN "login_throttles"."resetAt"
            ELSE NULL
          END,
          "failureCount" = CASE WHEN "login_throttles"."resetAt" <= $3 THEN 1 ELSE "login_throttles"."failureCount" + 1 END,
          "resetAt" = CASE WHEN "login_throttles"."resetAt" <= $3 THEN EXCLUDED."resetAt" ELSE "login_throttles"."resetAt" END,
          "updatedAt" = $3
    `, [throttleKey, nextResetAt, now, limit]);
  }

  async purgeExpiredLoginThrottles(limit = 1_000): Promise<number> {
    const batchSize = Number.isInteger(limit) ? Math.max(1, Math.min(limit, 1_000)) : 1_000;
    const candidates = await this.throttles.find({
      where: { resetAt: LessThan(new Date()) }, select: { throttleKey: true }, order: { resetAt: 'ASC' }, take: batchSize,
    });
    if (!candidates.length) return 0;
    const result = await this.throttles.delete(candidates.map((candidate) => candidate.throttleKey));
    return result.affected || 0;
  }

  profile(user: User): SafeUser {
    const { passwordHash: _passwordHash, sessionVersion: _sessionVersion, ...safe } = user;
    return safe;
  }
}
