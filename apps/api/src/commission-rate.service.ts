import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash } from 'crypto';
import { DataSource, EntityManager, In, Repository } from 'typeorm';
import {
  CommissionRateVersion, Merchant, PlatformAccessProfile, RateChangeRequest, RateChangeRequestStatus, User,
} from './domain/entities';
import { MerchantAccessService } from './merchant-access.service';
import { AuditWriterService } from './audit-writer.service';
import { isUniqueConstraintError, requiredText } from './billing-policy';

type CommissionRateVersionListItem = Omit<CommissionRateVersion, 'idempotencyKey' | 'requestHash'>;
type RateChangeRequestListItem = Omit<RateChangeRequest, 'idempotencyKey' | 'requestHash'>;
type PlatformRateChangeRequestListItem = RateChangeRequestListItem & { merchantBrandName: string };

@Injectable()
export class CommissionRateService {
  constructor(
    private readonly merchantAccess: MerchantAccessService,
    private readonly dataSource: DataSource,
    private readonly auditWriter: AuditWriterService,
    @InjectRepository(Merchant) private readonly merchants: Repository<Merchant>,
    @InjectRepository(CommissionRateVersion) private readonly rates: Repository<CommissionRateVersion>,
    @InjectRepository(RateChangeRequest) private readonly rateChangeRequests: Repository<RateChangeRequest>,
  ) {}

  async requestChange(user: User, merchantId: string, rate: number, effectiveFrom: string, note: string, rawIdempotencyKey?: string): Promise<RateChangeRequestListItem> {
    // FIX: 恢复本地费率变更申请（此前被误停用为 GoneException「收钱吧」——系统无任何外部费率同步渠道，
    // 费率版本由本地维护，见 2026-08-09 排查记录）。
    this.merchantAccess.requirePlatformAccess(user, '提交费率变更', [PlatformAccessProfile.FINANCE]);
    await this.merchantAccess.getForUser(user, merchantId, [PlatformAccessProfile.FINANCE]);
    if (!Number.isFinite(rate) || rate < 0 || rate > 1) throw new BadRequestException('费率必须为 0 至 1 之间');
    if (!/^\d{4}-(0[1-9]|1[0-2])-([0-2]\d|3[01])$/.test(effectiveFrom)) throw new BadRequestException('生效日期格式为 YYYY-MM-DD');
    const statement = requiredText(note, '费率变更说明', 500);
    const idempotencyKey = requiredText(rawIdempotencyKey, '费率变更请求标识', 128);
    if (!/^[A-Za-z0-9_-]{12,128}$/.test(idempotencyKey)) throw new BadRequestException('费率变更请求标识格式不正确');
    const requestHash = rateChangeRequestHash({ merchantId, rate, effectiveFrom, note: statement });
    try {
      return await this.dataSource.transaction(async (manager) => {
        if (idempotencyKey && requestHash) {
          const retried = await this.rateChangeRequestForRetry(manager, merchantId, user.id, idempotencyKey);
          if (retried) { assertSameRateChangeRequest(retried, requestHash); return this.requestListItem(retried); }
        }
        const pending = await manager.findOneBy(RateChangeRequest, { merchantId, status: RateChangeRequestStatus.PENDING_REVIEW });
        if (pending) throw new ConflictException('该商家已有待复核的费率变更请求');
        const request = await manager.save(RateChangeRequest, {
          merchantId, requestedBy: user.id, rate: String(rate), effectiveFrom: new Date(`${effectiveFrom}T00:00:00+08:00`),
          note: statement, status: RateChangeRequestStatus.PENDING_REVIEW,
          idempotencyKey, requestHash, reviewedBy: null, reviewNote: '', reviewedAt: null, rateVersionId: null,
        });
        await this.auditWriter.write(user.id, merchantId, 'RATE_CHANGE_REQUESTED', 'RateChangeRequest', request.id, null, { rate, effectiveFrom, note: statement }, manager);
        return this.requestListItem(request);
      });
    } catch (error) {
      if (!idempotencyKey || !requestHash || !isUniqueConstraintError(error)) throw error;
      const retried = await this.rateChangeRequestForRetry(this.dataSource.manager, merchantId, user.id, idempotencyKey);
      if (!retried) throw error;
      assertSameRateChangeRequest(retried, requestHash);
      return this.requestListItem(retried);
    }
  }

  async listRequests(user: User, merchantId: string): Promise<RateChangeRequestListItem[]> {
    this.merchantAccess.requirePlatformAccess(user, '查看费率变更请求', [PlatformAccessProfile.FINANCE]);
    await this.merchantAccess.getForUser(user, merchantId, [PlatformAccessProfile.FINANCE]);
    return (await this.rateChangeRequests.find({ where: { merchantId }, order: { createdAt: 'DESC', id: 'DESC' }, take: 100 })).map((request) => this.requestListItem(request));
  }

  async listPlatformRequests(user: User): Promise<PlatformRateChangeRequestListItem[]> {
    this.merchantAccess.requirePlatformAccess(user, '查看平台费率复核队列', [PlatformAccessProfile.FINANCE]);
    const requests = await this.rateChangeRequests.find({ order: { createdAt: 'DESC', id: 'DESC' }, take: 200 });
    if (!requests.length) return [];
    const merchants = await this.merchants.find({ where: { id: In([...new Set(requests.map((request) => request.merchantId))]) }, select: { id: true, brandName: true } });
    const names = new Map(merchants.map((merchant) => [merchant.id, merchant.brandName]));
    return requests.map((request) => ({ ...this.requestListItem(request), merchantBrandName: names.get(request.merchantId) || '已归档商家' }));
  }

  async review(user: User, merchantId: string, requestId: string, approved: boolean, note: string): Promise<RateChangeRequestListItem> {
    // FIX: 恢复本地费率变更复核（四眼原则：批准后生成不可变费率版本）。
    this.merchantAccess.requirePlatformAccess(user, approved ? '复核费率变更' : '驳回费率变更', [PlatformAccessProfile.FINANCE]);
    await this.merchantAccess.getForUser(user, merchantId, [PlatformAccessProfile.FINANCE]);
    const reviewNote = requiredText(note, approved ? '费率复核结论' : '费率驳回说明', 1000);
    return this.dataSource.transaction(async (manager) => {
      const request = await manager.findOne(RateChangeRequest, { where: { id: requestId, merchantId }, lock: { mode: 'pessimistic_write' } });
      if (!request) throw new NotFoundException('费率变更请求不存在');
      if (request.status !== RateChangeRequestStatus.PENDING_REVIEW) throw new ConflictException('该费率变更请求已处理');
      if (request.requestedBy === user.id) throw new ForbiddenException('费率变更必须由不同平台账号复核');
      const merchant = await manager.findOne(Merchant, { where: { id: merchantId }, lock: { mode: 'pessimistic_write' } });
      if (!merchant) throw new NotFoundException('商家不存在');
      if (!approved) {
        request.status = RateChangeRequestStatus.REJECTED;
        request.reviewedBy = user.id;
        request.reviewNote = reviewNote;
        request.reviewedAt = new Date();
        const saved = await manager.save(RateChangeRequest, request);
        await this.auditWriter.write(user.id, merchantId, 'RATE_CHANGE_REJECTED', 'RateChangeRequest', saved.id, { status: RateChangeRequestStatus.PENDING_REVIEW }, { status: saved.status, reviewNote }, manager);
        return this.requestListItem(saved);
      }
      // 批准：创建不可变费率版本（幂等键由请求派生，同请求重放不重复建版本）
      const version = await manager.save(CommissionRateVersion, {
        merchantId, rate: request.rate, effectiveFrom: request.effectiveFrom, note: request.note,
        createdBy: user.id, idempotencyKey: `rate-request-${request.id}`, requestHash: request.requestHash,
      });
      request.rateVersionId = version.id;
      request.status = RateChangeRequestStatus.APPROVED;
      request.reviewedBy = user.id;
      request.reviewNote = reviewNote;
      request.reviewedAt = new Date();
      const saved = await manager.save(RateChangeRequest, request);
      await this.auditWriter.write(user.id, merchantId, 'RATE_CHANGE_APPROVED', 'RateChangeRequest', saved.id, { status: RateChangeRequestStatus.PENDING_REVIEW }, { status: saved.status, rate: request.rate, effectiveFrom: request.effectiveFrom, rateVersionId: version.id }, manager);
      return this.requestListItem(saved);
    });
  }

  async listVersions(user: User, merchantId: string): Promise<CommissionRateVersionListItem[]> {
    this.merchantAccess.requirePlatformAccess(user, '查看合同费率', [PlatformAccessProfile.FINANCE]);
    await this.merchantAccess.getForUser(user, merchantId, [PlatformAccessProfile.FINANCE]);
    return (await this.rates.find({ where: { merchantId }, order: { effectiveFrom: 'DESC', createdAt: 'DESC' } })).map((rate) => this.rateListItem(rate));
  }

  private requestListItem(request: RateChangeRequest): RateChangeRequestListItem {
    const { idempotencyKey: _idempotencyKey, requestHash: _requestHash, ...safe } = request;
    return safe;
  }

  private rateListItem(rate: CommissionRateVersion): CommissionRateVersionListItem {
    const { idempotencyKey: _idempotencyKey, requestHash: _requestHash, ...safe } = rate;
    return safe;
  }

  private async rateChangeRequestForRetry(manager: EntityManager, merchantId: string, requestedBy: string, idempotencyKey: string): Promise<RateChangeRequest | null> {
    return manager.getRepository(RateChangeRequest).createQueryBuilder('request').addSelect(['request.idempotencyKey', 'request.requestHash']).where('request.merchantId = :merchantId AND request.requestedBy = :requestedBy AND request.idempotencyKey = :idempotencyKey', { merchantId, requestedBy, idempotencyKey }).getOne();
  }

}

/** 费率变更请求幂等哈希（与 bill-payment-confirmation 同风格：sha256 摘要，防重放/防重复提交） */
function rateChangeRequestHash(input: { merchantId: string; rate: number; effectiveFrom: string; note: string }): string {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex');
}

/** 幂等重试断言：同请求标识必须对应同内容 */
function assertSameRateChangeRequest(request: RateChangeRequest, requestHash: string): void {
  if (request.requestHash !== requestHash) throw new ConflictException('费率变更请求标识已用于其他内容，请刷新后重试');
}
