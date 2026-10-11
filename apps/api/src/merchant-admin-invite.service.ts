import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import bcrypt from 'bcryptjs';
import { createHash, randomBytes } from 'crypto';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { AuditWriterService } from './audit-writer.service';
import { Agency, Merchant, MerchantAdminInvite, MerchantStatus, NotificationChannel, PlatformAccessProfile, User, UserRole } from './domain/entities';
import { AuthService } from './auth.service';
import { MerchantAccessService } from './merchant-access.service';
import { SensitiveDataService } from './sensitive-data.service';
import { NotificationOutboxService } from './notifications/notification-outbox.service';

export type MerchantAdminInviteInput = { name: string; email: string };
export type MerchantAdminInviteView = {
  id: string; merchantId: string; agencyId: string; email: string; name: string;
  expiresAt: Date; consumedAt: Date | null; consumedUserId: string | null; revokedAt: Date | null; createdAt: Date;
};
export type MerchantAdminInviteCreated = MerchantAdminInviteView & { token: string };

const INVITE_TTL_MS = 24 * 60 * 60_000;

@Injectable()
export class MerchantAdminInviteService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly authService: AuthService,
    private readonly merchantAccess: MerchantAccessService,
    private readonly sensitiveData: SensitiveDataService,
    private readonly auditWriter: AuditWriterService,
    private readonly notificationOutbox: NotificationOutboxService,
    @InjectRepository(MerchantAdminInvite) private readonly invites: Repository<MerchantAdminInvite>,
    @InjectRepository(User) private readonly users: Repository<User>,
    @InjectRepository(Agency) private readonly agencies: Repository<Agency>,
  ) {}

  async create(actor: User, merchantId: string, input: MerchantAdminInviteInput, rawIdempotencyKey: string): Promise<MerchantAdminInviteCreated> {
    const merchant = await this.merchantAccess.getForUser(actor, merchantId, [PlatformAccessProfile.OPERATIONS]);
    if (merchant.status === MerchantStatus.CLOSED) throw new BadRequestException('已关闭商家不能邀请管理员');
    const name = this.requiredText(input.name, '管理员姓名', 80);
    const email = this.requiredText(input.email, '管理员账号', 254).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new BadRequestException('管理员账号格式不正确');
    const idempotencyKey = this.requiredKey(rawIdempotencyKey);
    const requestHash = createHash('sha256').update(JSON.stringify({ merchantId, name, email })).digest('hex');
    try {
      return await this.dataSource.transaction(async (manager) => {
        const retry = await this.retryRecord(manager, actor.id, idempotencyKey);
        if (retry) {
          this.assertSameRequest(retry, requestHash);
          return this.createdView(retry, this.sensitiveData.decrypt(retry.tokenCiphertext));
        }
        const currentAdministrator = await manager.findOneBy(User, { merchantId, role: UserRole.MERCHANT_ADMIN });
        if (currentAdministrator) throw new ConflictException('该商家已存在管理员，请使用重置密码');
        const existingUser = await manager.findOne(User, { where: { email } });
        if (existingUser) throw new ConflictException('该管理员账号已存在，请使用重置密码或更换账号');
        const lockedMerchant = await manager.findOne(Merchant, { where: { id: merchantId }, lock: { mode: 'pessimistic_write' } });
        if (!lockedMerchant) throw new NotFoundException('商家不存在');
        if (lockedMerchant.status === MerchantStatus.CLOSED) throw new BadRequestException('已关闭商家不能邀请管理员');
        const previous = await manager.createQueryBuilder(MerchantAdminInvite, 'invite')
          .where('invite.merchantId = :merchantId AND invite.consumedAt IS NULL AND invite.revokedAt IS NULL', { merchantId })
          .setLock('pessimistic_write').getMany();
        const revokedAt = new Date();
        for (const invite of previous) invite.revokedAt = revokedAt;
        if (previous.length) await manager.save(MerchantAdminInvite, previous);
        const token = randomBytes(32).toString('base64url');
        const invite = await manager.save(MerchantAdminInvite, {
          merchantId, agencyId: lockedMerchant.agencyId, requestedBy: actor.id, name, email,
          tokenHash: this.hashToken(token), tokenCiphertext: this.sensitiveData.encrypt(token), idempotencyKey, requestHash,
          expiresAt: new Date(Date.now() + INVITE_TTL_MS), consumedAt: null, consumedUserId: null, revokedAt: null,
        });
        await this.auditWriter.write(actor.id, merchantId, 'MERCHANT_ADMIN_INVITE_CREATED', 'MerchantAdminInvite', invite.id, null, { email, name, expiresAt: invite.expiresAt, revokedPreviousCount: previous.length }, manager);
        await this.notificationOutbox.enqueue(manager, {
          eventType: 'MERCHANT_ADMIN_INVITE_CREATED', templateKey: 'merchant-admin-invite-created', channel: NotificationChannel.EMAIL,
          recipient: email, merchantId, resourceType: 'MerchantAdminInvite', resourceId: invite.id,
          payload: { merchantId, inviteId: invite.id, name, expiresAt: invite.expiresAt.toISOString() },
          dedupeKey: `merchant-admin-invite:${invite.id}`,
        });
        return this.createdView(invite, token);
      });
    } catch (error) {
      const retry = await this.retryRecord(this.dataSource.manager, actor.id, idempotencyKey);
      if (retry) { this.assertSameRequest(retry, requestHash); return this.createdView(retry, this.sensitiveData.decrypt(retry.tokenCiphertext)); }
      if (this.isUniqueConstraintError(error)) throw new ConflictException('邀请请求已存在，请刷新后重试');
      throw error;
    }
  }

  async list(actor: User, merchantId: string): Promise<MerchantAdminInviteView[]> {
    await this.merchantAccess.getForUser(actor, merchantId, [PlatformAccessProfile.OPERATIONS]);
    const records = await this.invites.find({ where: { merchantId }, order: { createdAt: 'DESC' }, take: 20 });
    return records.map((invite) => this.view(invite));
  }

  async revoke(actor: User, merchantId: string, inviteId: string): Promise<MerchantAdminInviteView> {
    await this.merchantAccess.getForUser(actor, merchantId, [PlatformAccessProfile.OPERATIONS]);
    return this.dataSource.transaction(async (manager) => {
      const invite = await manager.findOne(MerchantAdminInvite, { where: { id: inviteId, merchantId }, lock: { mode: 'pessimistic_write' } });
      if (!invite) throw new NotFoundException('管理员邀请不存在');
      if (!invite.revokedAt && !invite.consumedAt) {
        invite.revokedAt = new Date();
        await manager.save(MerchantAdminInvite, invite);
        await this.auditWriter.write(actor.id, merchantId, 'MERCHANT_ADMIN_INVITE_REVOKED', 'MerchantAdminInvite', invite.id, { revokedAt: null }, { revokedAt: invite.revokedAt }, manager);
      }
      return this.view(invite);
    });
  }

  async accept(rawToken: string, password: string): Promise<{ ok: true; merchantId: string; email: string }> {
    const token = this.requiredText(rawToken, '邀请令牌', 256);
    this.authService.assertPasswordPolicy(password, '登录密码');
    const tokenHash = this.hashToken(token);
    return this.dataSource.transaction(async (manager) => {
      const invite = await manager.createQueryBuilder(MerchantAdminInvite, 'invite')
        .addSelect(['invite.tokenHash']).where('invite.tokenHash = :tokenHash', { tokenHash })
        .setLock('pessimistic_write').getOne();
      const now = new Date();
      if (!invite || invite.revokedAt || invite.consumedAt || new Date(invite.expiresAt) <= now) throw new BadRequestException('邀请无效或已失效');
      const agency = await manager.findOneBy(Agency, { id: invite.agencyId });
      const merchant = await manager.findOneBy(Merchant, { id: invite.merchantId });
      if (!agency?.active || !merchant || merchant.status === MerchantStatus.CLOSED) throw new BadRequestException('商家当前不可开通管理员账号');
      if (await manager.findOneBy(User, { merchantId: invite.merchantId, role: UserRole.MERCHANT_ADMIN })) throw new ConflictException('该商家已存在管理员，请联系运营人员');
      if (await manager.findOneBy(User, { email: invite.email })) throw new ConflictException('该管理员账号已存在，请联系运营人员');
      const user = await manager.save(User, { email: invite.email, name: invite.name, passwordHash: await bcrypt.hash(password, 10), role: UserRole.MERCHANT_ADMIN, platformAccessProfile: null, agencyId: invite.agencyId, merchantId: invite.merchantId, storeIds: null, active: true, sessionVersion: 0 });
      invite.consumedAt = now; invite.consumedUserId = user.id;
      await manager.save(MerchantAdminInvite, invite);
      await this.auditWriter.write('system', invite.merchantId, 'MERCHANT_ADMIN_INVITE_ACCEPTED', 'MerchantAdminInvite', invite.id, { consumedAt: null }, { consumedAt: now, userId: user.id }, manager);
      return { ok: true, merchantId: invite.merchantId, email: invite.email };
    });
  }

  private view(invite: MerchantAdminInvite): MerchantAdminInviteView {
    return { id: invite.id, merchantId: invite.merchantId, agencyId: invite.agencyId, email: invite.email, name: invite.name, expiresAt: invite.expiresAt, consumedAt: invite.consumedAt, consumedUserId: invite.consumedUserId, revokedAt: invite.revokedAt, createdAt: invite.createdAt };
  }
  private createdView(invite: MerchantAdminInvite, token: string): MerchantAdminInviteCreated { return { ...this.view(invite), token }; }
  private hashToken(token: string): string { return createHash('sha256').update(token).digest('hex'); }
  private async retryRecord(manager: EntityManager, requestedBy: string, idempotencyKey: string): Promise<MerchantAdminInvite | null> {
    return manager.getRepository(MerchantAdminInvite).createQueryBuilder('invite').addSelect(['invite.tokenHash', 'invite.tokenCiphertext', 'invite.idempotencyKey', 'invite.requestHash']).where('invite.requestedBy = :requestedBy AND invite.idempotencyKey = :idempotencyKey', { requestedBy, idempotencyKey }).getOne();
  }
  private assertSameRequest(invite: MerchantAdminInvite, requestHash: string): void { if (invite.requestHash !== requestHash) throw new ConflictException('邀请请求标识已用于其他内容，请刷新后重试'); }
  private requiredKey(value: unknown): string { const key = this.requiredText(value, '邀请请求标识', 128); if (!/^[A-Za-z0-9_-]{12,128}$/.test(key)) throw new BadRequestException('邀请请求标识格式不正确'); return key; }
  private requiredText(value: unknown, label: string, maxLength: number): string { if (typeof value !== 'string') throw new BadRequestException(`${label}格式不正确`); const text = value.trim(); if (!text || text.length > maxLength) throw new BadRequestException(`${label}不能为空且不能超过 ${maxLength} 个字符`); return text; }
  private isUniqueConstraintError(error: unknown): boolean { return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === '23505'; }
}
