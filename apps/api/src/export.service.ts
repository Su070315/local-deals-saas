import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash } from 'crypto';
import { DataSource, EntityManager, In, LessThanOrEqual, MoreThan, Repository } from 'typeorm';
import { ExportJob, ExportJobStatus, ExportKind, Merchant, Order, PlatformAccessProfile, User, UserRole, Verification } from './domain/entities';
import { AuditWriterService } from './audit-writer.service';
import { MerchantAccessService } from './merchant-access.service';
import { SensitiveDataService } from './sensitive-data.service';
import { isLocalOrTestEnvironment, usesEmbeddedDatabase } from './runtime-config';
import type { ExportJobListItem, ExportQuery, ExportQueueSnapshot } from './app-service.core-types';

const DEFAULT_RANGE_DAYS = 31;
const MAX_RANGE_DAYS = 92;
const MAX_ROWS = 10_000;
const MAX_ARTIFACT_BYTES = 8 * 1024 * 1024;
const ARTIFACT_TTL_MS = 24 * 60 * 60_000;
const MAX_DOWNLOADS = 3;
const PROCESSING_STALE_MS = 5 * 60_000;

type ExportRange = { from: Date; toExclusive: Date; fromDay: string; toDay: string };
type CreateExportInput = ExportQuery & { kind: ExportKind };

@Injectable()
export class ExportService {
  private processor: Promise<{ completed: number; failed: number }> | null = null;

  constructor(
    private readonly dataSource: DataSource,
    private readonly auditWriter: AuditWriterService,
    private readonly merchantAccess: MerchantAccessService,
    private readonly sensitiveData: SensitiveDataService,
    @InjectRepository(Merchant) private readonly merchants: Repository<Merchant>,
    @InjectRepository(Order) private readonly orders: Repository<Order>,
    @InjectRepository(Verification) private readonly verifications: Repository<Verification>,
    @InjectRepository(ExportJob) private readonly exportJobs: Repository<ExportJob>,
  ) {}

  async create(user: User, input: CreateExportInput, rawIdempotencyKey?: string): Promise<ExportJobListItem> {
    this.assertCanExport(user);
    if (!Object.values(ExportKind).includes(input.kind)) throw new BadRequestException('不支持的导出类型');
    const merchantScope = input.merchantId ? [input.merchantId] : await this.scopedMerchantIds(user);
    if (input.merchantId) await this.merchantAccess.getForUser(user, input.merchantId, [PlatformAccessProfile.OPERATIONS, PlatformAccessProfile.FINANCE]);
    const range = this.exportRange(input);
    const idempotencyKey = rawIdempotencyKey === undefined ? null : this.requiredText(rawIdempotencyKey, '导出请求标识', 128);
    if (idempotencyKey && !/^[A-Za-z0-9_-]{12,128}$/.test(idempotencyKey)) throw new BadRequestException('导出请求标识格式不正确');
    const requestHash = this.requestHash({ kind: input.kind, merchantScope, requestedMerchantId: input.merchantId || null, fromDay: range.fromDay, toDay: range.toDay });
    if (idempotencyKey) {
      const retried = await this.forRetry(this.dataSource.manager, user.id, idempotencyKey);
      if (retried) { this.assertSameRetry(retried, requestHash); return this.listItem(retried); }
    }
    let job: ExportJob;
    try {
      job = await this.dataSource.transaction(async (manager) => {
        if (idempotencyKey) {
          const retried = await this.forRetry(manager, user.id, idempotencyKey);
          if (retried) { this.assertSameRetry(retried, requestHash); return retried; }
        }
        const created = await manager.save(ExportJob, manager.create(ExportJob, {
          requestedBy: user.id, requestedRole: user.role, kind: input.kind, merchantScope, requestedMerchantId: input.merchantId || null,
          idempotencyKey, requestHash: idempotencyKey ? requestHash : null, fromDay: range.fromDay, toDay: range.toDay,
          status: ExportJobStatus.PENDING, recordCount: 0, encryptedArtifact: null, artifactSha256: '', downloadCount: 0,
          lastDownloadedAt: null, attemptCount: 0, lastAttemptAt: null, failureReason: '', revokedAt: null,
          expiresAt: new Date(Date.now() + ARTIFACT_TTL_MS),
        }));
        await this.auditWriter.write(user.id, input.merchantId || null, 'DATA_EXPORT_REQUESTED', 'ExportJob', created.id, null, {
          kind: created.kind, scopeMerchantCount: merchantScope.length, scopeMerchantId: input.merchantId || null,
          from: range.fromDay, to: range.toDay, expiresAt: created.expiresAt, idempotentRequest: Boolean(idempotencyKey),
        }, manager);
        return created;
      });
    } catch (error) {
      if (!idempotencyKey || !this.isUniqueConstraintError(error)) throw error;
      const retried = await this.forRetry(this.dataSource.manager, user.id, idempotencyKey);
      if (!retried) throw error;
      this.assertSameRetry(retried, requestHash);
      job = retried;
    }
    if (isLocalOrTestEnvironment()) void this.process().catch(() => undefined);
    return this.listItem(job);
  }

  async list(user: User): Promise<ExportJobListItem[]> {
    if (user.role === UserRole.STORE_STAFF) throw new ForbiddenException('核销员不可导出经营数据');
    const jobs = await this.exportJobs.find({ where: { requestedBy: user.id }, order: { createdAt: 'DESC', id: 'DESC' }, take: 100 });
    return jobs.map((job) => this.listItem(job));
  }

  async get(user: User, exportJobId: string): Promise<ExportJobListItem> {
    const job = await this.findForRequester(user, exportJobId);
    await this.assertScopeStillAuthorized(user, job);
    return this.listItem(job);
  }

  async queueStatus(): Promise<ExportQueueSnapshot> {
    const now = new Date();
    const active = (status: ExportJobStatus) => ({ status, expiresAt: MoreThan(now) });
    const [pending, processing, failed, oldestPending, oldestProcessing] = await Promise.all([
      this.exportJobs.count({ where: active(ExportJobStatus.PENDING) }),
      this.exportJobs.count({ where: active(ExportJobStatus.PROCESSING) }),
      this.exportJobs.count({ where: active(ExportJobStatus.FAILED) }),
      this.exportJobs.findOne({ where: active(ExportJobStatus.PENDING), select: { id: true, createdAt: true }, order: { createdAt: 'ASC', id: 'ASC' } }),
      this.exportJobs.findOne({ where: active(ExportJobStatus.PROCESSING), select: { id: true, createdAt: true, lastAttemptAt: true }, order: { lastAttemptAt: 'ASC', id: 'ASC' } }),
    ]);
    return { pending, processing, failed, oldestPendingAt: oldestPending?.createdAt || null, oldestProcessingAt: oldestProcessing?.lastAttemptAt || oldestProcessing?.createdAt || null };
  }

  async process(limit = 20): Promise<{ completed: number; failed: number }> {
    if (this.processor) return this.processor;
    const task = this.processInternal(limit);
    this.processor = task;
    try { return await task; } finally { if (this.processor === task) this.processor = null; }
  }

  async download(user: User, exportJobId: string): Promise<{ csv: string; filename: string }> {
    const requested = await this.findForRequester(user, exportJobId);
    await this.assertScopeStillAuthorized(user, requested);
    return this.dataSource.transaction(async (manager) => {
      const job = await manager.findOne(ExportJob, { where: { id: exportJobId, requestedBy: user.id }, lock: { mode: 'pessimistic_write' } });
      if (!job) throw new NotFoundException('导出任务不存在');
      if (job.status !== ExportJobStatus.READY || !job.encryptedArtifact) throw new ConflictException('导出文件当前不可下载');
      if (job.expiresAt <= new Date()) throw new ConflictException('导出文件已过期');
      if (job.downloadCount >= MAX_DOWNLOADS) throw new ConflictException(`导出文件最多下载 ${MAX_DOWNLOADS} 次，请重新创建任务`);
      const csv = this.sensitiveData.decrypt(job.encryptedArtifact);
      job.downloadCount += 1;
      job.lastDownloadedAt = new Date();
      await manager.save(ExportJob, job);
      await this.auditWriter.write(user.id, job.requestedMerchantId, 'DATA_EXPORT_DOWNLOADED', 'ExportJob', job.id, null, { downloadCount: job.downloadCount, artifactSha256: job.artifactSha256 }, manager);
      return { csv, filename: `${job.kind}-${job.fromDay.replaceAll('-', '')}-${job.toDay.replaceAll('-', '')}.csv` };
    });
  }

  async revoke(user: User, exportJobId: string): Promise<ExportJobListItem> {
    const requested = await this.findForRequester(user, exportJobId);
    await this.assertScopeStillAuthorized(user, requested);
    return this.dataSource.transaction(async (manager) => {
      const job = await manager.findOne(ExportJob, { where: { id: exportJobId, requestedBy: user.id }, lock: { mode: 'pessimistic_write' } });
      if (!job) throw new NotFoundException('导出任务不存在');
      if (![ExportJobStatus.PENDING, ExportJobStatus.PROCESSING, ExportJobStatus.READY].includes(job.status)) throw new ConflictException('当前导出任务不可撤回');
      const before = { status: job.status, downloadCount: job.downloadCount };
      job.status = ExportJobStatus.REVOKED;
      job.encryptedArtifact = null;
      job.artifactSha256 = '';
      job.revokedAt = new Date();
      await manager.save(ExportJob, job);
      await this.auditWriter.write(user.id, job.requestedMerchantId, 'DATA_EXPORT_REVOKED', 'ExportJob', job.id, before, { status: job.status, revokedAt: job.revokedAt }, manager);
      return this.listItem(job);
    });
  }

  async expire(): Promise<number> {
    const candidates = await this.exportJobs.find({ where: { expiresAt: LessThanOrEqual(new Date()), status: In([ExportJobStatus.PENDING, ExportJobStatus.PROCESSING, ExportJobStatus.READY]) }, select: { id: true }, take: 100 });
    let expired = 0;
    for (const candidate of candidates) {
      const didExpire = await this.dataSource.transaction(async (manager) => {
        const job = await manager.findOne(ExportJob, { where: { id: candidate.id }, lock: { mode: 'pessimistic_write' } });
        if (!job || job.expiresAt > new Date() || ![ExportJobStatus.PENDING, ExportJobStatus.PROCESSING, ExportJobStatus.READY].includes(job.status)) return false;
        const before = { status: job.status, recordCount: job.recordCount, downloadCount: job.downloadCount };
        job.status = ExportJobStatus.EXPIRED;
        job.encryptedArtifact = null;
        job.artifactSha256 = '';
        await manager.save(ExportJob, job);
        await this.auditWriter.write('system', job.requestedMerchantId, 'DATA_EXPORT_EXPIRED', 'ExportJob', job.id, before, { status: job.status }, manager);
        return true;
      });
      if (didExpire) expired += 1;
    }
    return expired;
  }

  private async processInternal(limit: number): Promise<{ completed: number; failed: number }> {
    const batchLimit = this.requiredInteger(limit, '导出任务批量大小', 1, 100);
    let completed = 0;
    let failed = 0;
    for (let index = 0; index < batchLimit; index += 1) {
      const job = await this.claim();
      if (!job) break;
      try {
        const generated = await this.generateCsv(job.kind, job.merchantScope, this.exportRange({ from: job.fromDay, to: job.toDay }));
        if (await this.complete(job.id, job.attemptCount, generated)) completed += 1;
      } catch (error) {
        if (await this.fail(job.id, job.attemptCount, error)) failed += 1;
      }
    }
    return { completed, failed };
  }

  private async claim(): Promise<ExportJob | null> {
    return this.dataSource.transaction(async (manager) => {
      const staleBefore = new Date(Date.now() - PROCESSING_STALE_MS);
      const query = manager.createQueryBuilder(ExportJob, 'job').setLock('pessimistic_write')
        .where('(job.status = :pending OR (job.status = :processing AND job.lastAttemptAt < :staleBefore))', { pending: ExportJobStatus.PENDING, processing: ExportJobStatus.PROCESSING, staleBefore })
        .andWhere('job.expiresAt > :now', { now: new Date() }).orderBy('job.createdAt', 'ASC').addOrderBy('job.id', 'ASC');
      if (!usesEmbeddedDatabase()) query.setOnLocked('skip_locked');
      const job = await query.getOne();
      if (!job) return null;
      job.status = ExportJobStatus.PROCESSING;
      job.attemptCount += 1;
      job.lastAttemptAt = new Date();
      job.failureReason = '';
      return manager.save(ExportJob, job);
    });
  }

  private async complete(jobId: string, attemptCount: number, generated: { csv: string; recordCount: number }): Promise<boolean> {
    const bytes = Buffer.byteLength(generated.csv, 'utf8');
    if (bytes > MAX_ARTIFACT_BYTES) throw new BadRequestException(`导出文件超过 ${(MAX_ARTIFACT_BYTES / 1024 / 1024).toFixed(0)}MB，请缩小时间范围后重试`);
    const encryptedArtifact = this.sensitiveData.encrypt(generated.csv);
    const artifactSha256 = createHash('sha256').update(generated.csv, 'utf8').digest('hex');
    return this.dataSource.transaction(async (manager) => {
      const job = await manager.findOne(ExportJob, { where: { id: jobId }, lock: { mode: 'pessimistic_write' } });
      if (!job || job.status !== ExportJobStatus.PROCESSING || job.attemptCount !== attemptCount || job.expiresAt <= new Date()) return false;
      job.status = ExportJobStatus.READY;
      job.recordCount = generated.recordCount;
      job.encryptedArtifact = encryptedArtifact;
      job.artifactSha256 = artifactSha256;
      job.failureReason = '';
      await manager.save(ExportJob, job);
      await this.auditWriter.write('system', job.requestedMerchantId, 'DATA_EXPORT_READY', 'ExportJob', job.id, { status: ExportJobStatus.PROCESSING }, { kind: job.kind, recordCount: job.recordCount, artifactSha256, expiresAt: job.expiresAt }, manager);
      return true;
    });
  }

  private async fail(jobId: string, attemptCount: number, error: unknown): Promise<boolean> {
    const failureReason = this.failureReason(error);
    return this.dataSource.transaction(async (manager) => {
      const job = await manager.findOne(ExportJob, { where: { id: jobId }, lock: { mode: 'pessimistic_write' } });
      if (!job || job.status !== ExportJobStatus.PROCESSING || job.attemptCount !== attemptCount) return false;
      job.status = ExportJobStatus.FAILED;
      job.encryptedArtifact = null;
      job.artifactSha256 = '';
      job.failureReason = failureReason;
      await manager.save(ExportJob, job);
      await this.auditWriter.write('system', job.requestedMerchantId, 'DATA_EXPORT_FAILED', 'ExportJob', job.id, { status: ExportJobStatus.PROCESSING }, { failureReason }, manager);
      return true;
    });
  }

  private async generateCsv(kind: ExportKind, merchantIds: string[], range: ExportRange): Promise<{ csv: string; recordCount: number }> {
    if (kind === ExportKind.ORDERS) {
      const records = merchantIds.length ? await this.orders.createQueryBuilder('order')
        .select(['order.orderNo', 'order.merchantId', 'order.packageId', 'order.quantity', 'order.amountFen', 'order.status', 'order.createdAt'])
        .where('order.merchantId IN (:...merchantIds)', { merchantIds }).andWhere('order.createdAt >= :from AND order.createdAt < :toExclusive', range)
        .orderBy('order.createdAt', 'DESC').addOrderBy('order.id', 'DESC').take(MAX_ROWS + 1).getMany() : [];
      this.assertSize(records.length);
      return { recordCount: records.length, csv: ['订单号,商家ID,套餐ID,数量,金额(元),状态,创建时间', ...records.map((record) => [record.orderNo, record.merchantId, record.packageId, record.quantity, (record.amountFen / 100).toFixed(2), record.status, new Date(record.createdAt).toISOString()].map((value) => this.csvCell(value)).join(','))].join('\n') };
    }
    if (kind !== ExportKind.VERIFICATIONS) throw new BadRequestException('不支持的导出类型');
    const records = merchantIds.length ? await this.verifications.createQueryBuilder('verification')
      .select(['verification.id', 'verification.voucherId', 'verification.storeId', 'verification.amountFen', 'verification.verifiedAt'])
      .where('verification.merchantId IN (:...merchantIds)', { merchantIds }).andWhere('verification.verifiedAt >= :from AND verification.verifiedAt < :toExclusive', range)
      .orderBy('verification.verifiedAt', 'DESC').addOrderBy('verification.id', 'DESC').take(MAX_ROWS + 1).getMany() : [];
    this.assertSize(records.length);
    return { recordCount: records.length, csv: ['核销ID,券ID,门店ID,核销金额(元),核销时间', ...records.map((record) => [record.id, record.voucherId, record.storeId, (record.amountFen / 100).toFixed(2), new Date(record.verifiedAt).toISOString()].map((value) => this.csvCell(value)).join(','))].join('\n') };
  }

  private exportRange(query: ExportQuery): ExportRange {
    const hasFrom = Boolean(query.from);
    const hasTo = Boolean(query.to);
    if (hasFrom !== hasTo) throw new BadRequestException('导出时间范围必须同时提供开始日期和结束日期');
    if (!hasFrom) {
      const to = this.businessDayStart();
      const from = new Date(to.getTime() - (DEFAULT_RANGE_DAYS - 1) * 86400000);
      return { from, toExclusive: new Date(to.getTime() + 86400000), fromDay: this.day(from), toDay: this.day(to) };
    }
    const from = this.requiredBusinessDate(query.from!, '导出开始日期');
    const to = this.requiredBusinessDate(query.to!, '导出结束日期');
    if (from > to) throw new BadRequestException('导出开始日期不能晚于结束日期');
    if (Math.floor((to.getTime() - from.getTime()) / 86400000) + 1 > MAX_RANGE_DAYS) throw new BadRequestException(`单次导出时间范围不能超过 ${MAX_RANGE_DAYS} 天`);
    return { from, toExclusive: new Date(to.getTime() + 86400000), fromDay: this.day(from), toDay: this.day(to) };
  }

  private async scopedMerchantIds(user: User): Promise<string[]> {
    if (user.role === UserRole.PLATFORM_ADMIN) {
      this.merchantAccess.requirePlatformAccess(user, '查看商家范围', [PlatformAccessProfile.OPERATIONS, PlatformAccessProfile.FINANCE, PlatformAccessProfile.COMPLIANCE]);
      return (await this.merchants.find({ select: { id: true } })).map((merchant) => merchant.id);
    }
    if (user.role === UserRole.AGENCY_ADMIN) return (await this.merchants.find({ where: { agencyId: user.agencyId! }, select: { id: true } })).map((merchant) => merchant.id);
    return user.merchantId ? [user.merchantId] : [];
  }

  private assertCanExport(user: User): void {
    if (user.role === UserRole.STORE_STAFF) throw new ForbiddenException('核销员不可导出经营数据');
    if (user.role === UserRole.PLATFORM_ADMIN) this.merchantAccess.requirePlatformAccess(user, '导出经营数据', [PlatformAccessProfile.OPERATIONS, PlatformAccessProfile.FINANCE]);
  }

  private async assertScopeStillAuthorized(user: User, job: ExportJob): Promise<void> {
    if (user.role === UserRole.STORE_STAFF) throw new ForbiddenException('核销员不可导出经营数据');
    const currentScope = new Set(await this.scopedMerchantIds(user));
    if (!job.merchantScope.every((merchantId) => currentScope.has(merchantId))) throw new ForbiddenException('当前权限范围已变化，导出文件已不可下载');
  }

  private async findForRequester(user: User, id: string): Promise<ExportJob> {
    const job = await this.exportJobs.findOneBy({ id, requestedBy: user.id });
    if (!job) throw new NotFoundException('导出任务不存在');
    return job;
  }

  private async forRetry(manager: EntityManager, requestedBy: string, idempotencyKey: string): Promise<ExportJob | null> {
    return manager.getRepository(ExportJob).createQueryBuilder('job').addSelect(['job.idempotencyKey', 'job.requestHash'])
      .where('job.requestedBy = :requestedBy AND job.idempotencyKey = :idempotencyKey', { requestedBy, idempotencyKey }).getOne();
  }

  private requestHash(input: { kind: ExportKind; merchantScope: string[]; requestedMerchantId: string | null; fromDay: string; toDay: string }): string {
    return createHash('sha256').update(JSON.stringify({ ...input, merchantScope: [...input.merchantScope].sort() })).digest('hex');
  }

  private assertSameRetry(job: ExportJob, requestHash: string): void { if (job.requestHash !== requestHash) throw new ConflictException('导出请求标识已用于其他内容，请刷新后重试'); }
  private isUniqueConstraintError(error: unknown): boolean { return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === '23505'; }
  private assertSize(size: number): void { if (size > MAX_ROWS) throw new BadRequestException(`导出结果超过 ${MAX_ROWS.toLocaleString('en-US')} 条，请缩小时间范围后重试`); }
  private failureReason(error: unknown): string {
    if (error instanceof BadRequestException) {
      const response = error.getResponse();
      const message = typeof response === 'string' ? response : (response as { message?: unknown }).message;
      return typeof message === 'string' ? message.slice(0, 240) : '导出数据不符合要求';
    }
    return '导出生成失败，请稍后重新创建任务';
  }
  private listItem(job: ExportJob): ExportJobListItem {
    return { id: job.id, kind: job.kind, requestedMerchantId: job.requestedMerchantId, fromDay: job.fromDay, toDay: job.toDay, status: job.status, recordCount: job.recordCount, artifactSha256: job.artifactSha256, downloadCount: job.downloadCount, lastDownloadedAt: job.lastDownloadedAt, attemptCount: job.attemptCount, failureReason: job.failureReason, revokedAt: job.revokedAt, expiresAt: job.expiresAt, createdAt: job.createdAt, updatedAt: job.updatedAt };
  }
  private requiredText(value: unknown, label: string, maxLength: number): string {
    if (typeof value !== 'string') throw new BadRequestException(`${label}格式不正确`);
    const normalized = value.trim();
    if (!normalized || normalized.length > maxLength) throw new BadRequestException(`${label}不能为空且不能超过 ${maxLength} 个字符`);
    return normalized;
  }
  private requiredInteger(value: unknown, label: string, min: number, max: number): number {
    const number = Number(value);
    if (!Number.isInteger(number) || number < min || number > max) throw new BadRequestException(`${label}必须为 ${min} 至 ${max} 的整数`);
    return number;
  }
  private requiredBusinessDate(value: string, label: string): Date {
    if (!/^\d{4}-(0[1-9]|1[0-2])-([0-2]\d|3[01])$/.test(value)) throw new BadRequestException(`${label}格式为 YYYY-MM-DD`);
    const date = new Date(`${value}T00:00:00+08:00`);
    if (Number.isNaN(date.getTime()) || this.day(date) !== value) throw new BadRequestException(`${label}不是有效日期`);
    return date;
  }
  private day(date: Date | string = new Date()): string {
    const values = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(date)).filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
    return `${values.year}-${values.month}-${values.day}`;
  }
  private businessDayStart(day = this.day()): Date { return new Date(`${day}T00:00:00+08:00`); }
  private csvCell(value: unknown): string {
    const text = String(value ?? '');
    const firstMeaningfulCharacter = [...text].find((character) => character !== '\uFEFF' && character.charCodeAt(0) > 0x20);
    const protectedText = firstMeaningfulCharacter && '=+-@'.includes(firstMeaningfulCharacter) ? `'${text}` : text;
    return `"${protectedText.replace(/"/g, '""')}"`;
  }
}
