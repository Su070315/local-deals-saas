import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { DataSource, In, Repository } from 'typeorm';
import { AuditWriterService } from './audit-writer.service';
import { calculateServiceFeeFen } from './domain/fee';
import { SettlementLedgerEntry, Store, User, UserRole, Verification, Voucher, VoucherStatus } from './domain/entities';
import type { CustomerIdentity, VerificationListItem, VoucherListItem } from './app-service.core-types';
import { SensitiveDataService } from './sensitive-data.service';
import { CustomerAuthService } from './customer-auth.service';
import { DelayedSettlementService } from './delayed-settlement.service';

export type VerificationPreview = {
  voucher: VoucherListItem & { storeName: string };
  workingStoreMatches: boolean;
  fulfillmentAvailable: boolean;
  canVerify: boolean;
};

@Injectable()
export class VerificationService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly auditWriter: AuditWriterService,
    private readonly sensitiveData: SensitiveDataService,
    private readonly customerAuth: CustomerAuthService,
    private readonly delayedSettlement: DelayedSettlementService,
    @InjectRepository(Voucher) private readonly vouchers: Repository<Voucher>,
    @InjectRepository(Store) private readonly stores: Repository<Store>,
    @InjectRepository(User) private readonly users: Repository<User>,
  ) {}

  /**
   * 顾客小程序内嵌核销：用当前顾客的 openid 识别已绑定核销员（users.wechatOpenid）。
   * 返回核销员档案（含授权门店），未绑定则返回 null。
   */
  async verifierByCustomer(customerId: string): Promise<User | null> {
    const openid = await this.customerAuth.openidOf(customerId).catch(() => null);
    if (!openid) return null;
    const verifier = await this.users.findOne({ where: { wechatOpenid: openid, role: UserRole.STORE_STAFF } });
    return verifier || null;
  }

  /** 顾客身份核销预览（复用标准 preview 逻辑，核销员身份从 openid 解析）。 */
  async previewAsVerifier(customerId: string, input: { token: string; workingStoreId: string }): Promise<VerificationPreview> {
    const verifier = await this.verifierByCustomer(customerId);
    if (!verifier) throw new ForbiddenException('当前微信未绑定核销员，请联系商家在「员工管理」中绑定');
    return this.preview(verifier, input);
  }

  /** 顾客身份核销确认（复用标准 confirm 逻辑，核销员身份从 openid 解析）。 */
  async confirmAsVerifier(customerId: string, input: { token: string; workingStoreId: string; idempotencyKey: string }): Promise<VerificationListItem> {
    const verifier = await this.verifierByCustomer(customerId);
    if (!verifier) throw new ForbiddenException('当前微信未绑定核销员，请联系商家在「员工管理」中绑定');
    return this.confirm(verifier, input);
  }

  /** 网页核销台：返回核销员授权的工作门店列表（核销时需选择工作门店）。 */
  async verifierStores(user: User): Promise<Array<{ id: string; name: string }>> {
    const storeIds = user.storeIds || [];
    if (!storeIds.length) return [];
    const list = await this.stores.findBy({ id: In(storeIds) });
    return list.map((store) => ({ id: store.id, name: store.name }));
  }

  async dynamicCode(voucherId: string, customer: CustomerIdentity): Promise<{ token: string; expiresAt: string }> {
    const voucher = await this.vouchers.findOneBy({ id: voucherId, customerId: customer.id });
    if (!voucher || !this.canUse(voucher)) throw new BadRequestException('该券当前不能核销');    const expiresAtMs = Date.now() + 90_000;
    const payload = Buffer.from(JSON.stringify({ voucherId: voucher.id, nonce: randomBytes(5).toString('hex'), exp: Math.floor(expiresAtMs / 1000) })).toString('base64url');
    const signature = createHmac('sha256', this.tokenSecret()).update(payload).digest('base64url');
    return { token: `${payload}.${signature}`, expiresAt: new Date(expiresAtMs).toISOString() };
  }

  async preview(user: User, input: { token: string; workingStoreId: string }): Promise<VerificationPreview> {
    const voucherId = this.parseToken(input.token);
    const voucher = await this.vouchers.findOneBy({ id: voucherId });
    if (!voucher) throw new NotFoundException('券不存在');
    const workingStoreMatches = this.requireWorkingStore(user, voucher, input.workingStoreId);
    const store = await this.stores.findOneBy({ id: voucher.storeId, merchantId: voucher.merchantId });
    const fulfillmentAvailable = store?.openForVerification !== false;
    return {
      voucher: { ...this.listItem(voucher), storeName: store?.name || '指定门店' },
      workingStoreMatches,
      fulfillmentAvailable,
      canVerify: workingStoreMatches && fulfillmentAvailable && this.canUse(voucher),
    };
  }

  async confirm(user: User, input: { token: string; workingStoreId: string; idempotencyKey: string }): Promise<VerificationListItem> {
    if (user.role !== UserRole.STORE_STAFF) throw new ForbiddenException('仅核销员可执行核销');
    const voucherId = this.parseToken(input.token);
    if (typeof input.idempotencyKey !== 'string' || !/^[A-Za-z0-9_-]{12,128}$/.test(input.idempotencyKey)) throw new BadRequestException('核销请求标识格式不正确');
    return this.dataSource.transaction(async (manager) => {
      const voucher = await manager.findOne(Voucher, { where: { id: voucherId }, lock: { mode: 'pessimistic_write' } });
      if (!voucher) throw new NotFoundException('券不存在');
      if (!this.requireWorkingStore(user, voucher, input.workingStoreId)) throw new BadRequestException('此券不属于当前工作门店，请切换门店后再核销');
      const existing = await manager.findOneBy(Verification, { voucherId, idempotencyKey: input.idempotencyKey });
      if (existing) return this.result(existing);
      const store = await manager.findOne(Store, { where: { id: voucher.storeId, merchantId: voucher.merchantId }, lock: { mode: 'pessimistic_write' } });
      if (!store?.openForVerification) throw new BadRequestException('该门店已停止履约，请由平台转店或补偿退款');
      if (!this.canUse(voucher)) throw new BadRequestException('券已核销、退款或过期');
      const verification = await manager.save(Verification, { voucherId, merchantId: voucher.merchantId, storeId: voucher.storeId, staffId: user.id, idempotencyKey: input.idempotencyKey, amountFen: voucher.faceValueFen });
      voucher.status = VoucherStatus.USED;
      voucher.verificationId = verification.id;
      await manager.save(Voucher, voucher);
      if (!this.delayedSettlement.enabled()) {
        await manager.save(SettlementLedgerEntry, {
          merchantId: voucher.merchantId,
          voucherId: voucher.id,
          verificationId: verification.id,
          verifiedAmountFen: voucher.faceValueFen,
          serviceFeeFen: calculateServiceFeeFen(voucher.faceValueFen, voucher.commissionRateSnapshot),
          rateSnapshot: voucher.commissionRateSnapshot,
          entryType: 'VERIFIED',
        });
      }
      await this.delayedSettlement.enqueueConfirmation(manager, verification, voucher);
      await this.auditWriter.write(user.id, voucher.merchantId, 'VOUCHER_VERIFIED', 'Voucher', voucher.id, { status: VoucherStatus.UNUSED }, { status: VoucherStatus.USED, verificationId: verification.id }, manager);
      return this.result(verification);
    });
  }

  private requireWorkingStore(user: User, voucher: Voucher, workingStoreId: string): boolean {
    if (user.role !== UserRole.STORE_STAFF) throw new ForbiddenException('仅核销员可执行核销');
    if (!user.merchantId || voucher.merchantId !== user.merchantId || !user.storeIds?.includes(voucher.storeId)) throw new ForbiddenException('此券不属于您的授权门店');
    if (!user.storeIds.includes(workingStoreId)) throw new ForbiddenException('当前工作门店未获授权');
    return voucher.storeId === workingStoreId;
  }

  private parseToken(token: string): string {
    if (!token || typeof token !== 'string') throw new BadRequestException('动态码无效');
    const parts = token.split('.');
    if (parts.length !== 2) throw new BadRequestException('动态码无效');
    const [payload, signature] = parts;
    const expected = createHmac('sha256', this.tokenSecret()).update(payload).digest('base64url');
    const signatureBuffer = Buffer.from(signature || '');
    const expectedBuffer = Buffer.from(expected);
    if (!payload || signatureBuffer.length !== expectedBuffer.length || !timingSafeEqual(signatureBuffer, expectedBuffer)) throw new BadRequestException('动态码无效');
    try {
      const data = JSON.parse(Buffer.from(payload, 'base64url').toString()) as { voucherId: unknown; nonce: unknown; exp: unknown };
      if (
        typeof data.voucherId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(data.voucherId) ||
        typeof data.nonce !== 'string' || !/^[0-9a-f]{10}$/i.test(data.nonce) ||
        typeof data.exp !== 'number' || !Number.isSafeInteger(data.exp) || data.exp <= 0 || data.exp * 1000 <= Date.now()
      ) throw new Error('invalid token payload');
      return data.voucherId;
    } catch { throw new BadRequestException('动态码已过期'); }
  }

  private listItem(voucher: Voucher): VoucherListItem {
    const { customerId: _customerId, commissionRateSnapshot: _rate, ...safe } = voucher;
    return { ...safe, status: this.effectiveStatus(voucher), refundStatus: null };
  }

  private result(verification: Verification): VerificationListItem {
    const { idempotencyKey: _idempotencyKey, ...safe } = verification;
    return safe;
  }

  private canUse(voucher: Voucher): boolean {
    return voucher.status === VoucherStatus.UNUSED && this.day(voucher.validFrom) <= this.day() && this.day(voucher.validTo) >= this.day();
  }

  private effectiveStatus(voucher: Voucher): VoucherStatus {
    return voucher.status === VoucherStatus.UNUSED && this.day(voucher.validTo) < this.day() ? VoucherStatus.EXPIRED : voucher.status;
  }

  private tokenSecret(): string { return process.env.VOUCHER_TOKEN_SECRET || 'dev-voucher-secret'; }

  private day(date: Date | string = new Date()): string {
    const values = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(date)).filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
    return `${values.year}-${values.month}-${values.day}`;
  }
}
