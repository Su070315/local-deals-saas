import { BadRequestException, ConflictException, ForbiddenException, HttpException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash } from 'crypto';
import { DataSource, EntityManager, LessThan, Repository } from 'typeorm';
import { AuditWriterService } from './audit-writer.service';
import { Agency, BatchOperationStatus, MerchantImportOperation, PlatformAccessProfile, User, UserRole } from './domain/entities';
import { MerchantAccessService } from './merchant-access.service';
import { TenantAdministrationService } from './tenant-administration.service';

export type MerchantImportItem = {
  externalRef: string;
  legalName: string;
  brandName: string;
  servicePhone?: string;
  contractNumber?: string;
  contractEndsAt?: string;
  rate?: number;
};
export type MerchantImportPayload = { note: string; items: MerchantImportItem[] };
export type MerchantImportOperationView = Omit<MerchantImportOperation, 'idempotencyKey' | 'requestHash'>;
export type MerchantImportOperationSummary = Pick<MerchantImportOperation, 'id' | 'agencyId' | 'requestedBy' | 'status' | 'totalCount' | 'succeededCount' | 'failedCount' | 'error' | 'startedAt' | 'completedAt' | 'createdAt' | 'updatedAt'>;

const PROCESSING_STALE_MS = 10 * 60_000;

@Injectable()
export class MerchantImportService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly auditWriter: AuditWriterService,
    private readonly merchantAccess: MerchantAccessService,
    private readonly tenantAdministration: TenantAdministrationService,
    @InjectRepository(Agency) private readonly agencies: Repository<Agency>,
    @InjectRepository(User) private readonly users: Repository<User>,
    @InjectRepository(MerchantImportOperation) private readonly operations: Repository<MerchantImportOperation>,
  ) {}

  async request(user: User, agencyId: string, input: MerchantImportPayload, rawIdempotencyKey: string): Promise<MerchantImportOperationView> {
    this.assertRequester(user, agencyId);
    const agency = await this.agencies.findOneBy({ id: agencyId });
    if (!agency) throw new NotFoundException('代理商不存在');
    if (!agency.active) throw new BadRequestException('代理商已停用，不能导入商家');
    const payload = this.normalizePayload(input);
    // FIX: 恢复批量导入携带初始费率（此前被误停用为 GoneException「收钱吧」；费率由本地维护，见 2026-08-09 排查）
    if (user.role === UserRole.AGENCY_ADMIN && payload.items.some((item) => item.contractNumber !== undefined || item.contractEndsAt !== undefined)) throw new ForbiddenException('代理商批量导入不可设置合同，请由平台审核配置');
    const idempotencyKey = this.requiredKey(rawIdempotencyKey);
    const requestHash = createHash('sha256').update(JSON.stringify({ agencyId, ...payload })).digest('hex');
    try {
      return await this.dataSource.transaction(async (manager) => {
        const retried = await this.retryRecord(manager, user.id, idempotencyKey);
        if (retried) { this.assertSameRequest(retried, requestHash); return this.safeOperation(retried); }
        const operation = await manager.save(MerchantImportOperation, {
          agencyId, requestedBy: user.id, status: BatchOperationStatus.PENDING, payload, totalCount: payload.items.length,
          succeededCount: 0, failedCount: 0, results: null, error: '', startedAt: null, completedAt: null, idempotencyKey, requestHash,
        });
        await this.auditWriter.write(user.id, null, 'MERCHANT_IMPORT_REQUESTED', 'MerchantImportOperation', operation.id, null, { agencyId, totalCount: operation.totalCount, note: payload.note, containsContractTerms: payload.items.some((item) => item.contractNumber !== undefined || item.contractEndsAt !== undefined) }, manager);
        return this.safeOperation(operation);
      });
    } catch (error) {
      const retried = await this.retryRecord(this.dataSource.manager, user.id, idempotencyKey);
      if (retried) { this.assertSameRequest(retried, requestHash); return this.safeOperation(retried); }
      if (this.isUniqueConstraintError(error)) throw new ConflictException('该商家导入请求已存在，请刷新后重试');
      throw error;
    }
  }

  async list(user: User): Promise<MerchantImportOperationSummary[]> {
    const agencyId = this.scopeAgencyId(user);
    const where = agencyId ? { agencyId } : {};
    const operations = await this.operations.find({ where,
      select: { id: true, agencyId: true, requestedBy: true, status: true, totalCount: true, succeededCount: true, failedCount: true, error: true, startedAt: true, completedAt: true, createdAt: true, updatedAt: true }, order: { createdAt: 'DESC', id: 'DESC' }, take: 100 });
    return operations.map((operation) => this.operationSummary(operation));
  }

  async get(user: User, operationId: string): Promise<MerchantImportOperationView> {
    const operation = await this.operations.findOneBy({ id: operationId });
    if (!operation) throw new NotFoundException('商家导入任务不存在');
    const agencyId = this.scopeAgencyId(user);
    if (agencyId && operation.agencyId !== agencyId) throw new ForbiddenException('不能查看其他代理商的导入任务');
    return this.safeOperation(operation);
  }

  async processPending(limit = 5): Promise<number> {
    const boundedLimit = Math.max(1, Math.min(limit, 20));
    await this.requeueStaleProcessing(boundedLimit);
    const pending = await this.operations.find({ where: { status: BatchOperationStatus.PENDING }, select: { id: true }, order: { createdAt: 'ASC', id: 'ASC' }, take: boundedLimit });
    let processed = 0;
    for (const candidate of pending) { await this.processOne(candidate.id); processed += 1; }
    return processed;
  }

  private async requeueStaleProcessing(limit: number): Promise<number> {
    const staleBefore = new Date(Date.now() - PROCESSING_STALE_MS);
    const candidates = await this.operations.find({ where: { status: BatchOperationStatus.PROCESSING, updatedAt: LessThan(staleBefore) }, select: { id: true }, order: { updatedAt: 'ASC', id: 'ASC' }, take: limit });
    let requeued = 0;
    for (const candidate of candidates) {
      const changed = await this.dataSource.transaction(async (manager) => {
        const operation = await manager.findOne(MerchantImportOperation, { where: { id: candidate.id, status: BatchOperationStatus.PROCESSING, updatedAt: LessThan(staleBefore) }, lock: { mode: 'pessimistic_write' } });
        if (!operation) return false;
        Object.assign(operation, { status: BatchOperationStatus.PENDING, startedAt: null, completedAt: null, error: '执行实例中断，任务已重新排队' });
        await manager.save(MerchantImportOperation, operation);
        await this.auditWriter.write(operation.requestedBy, null, 'MERCHANT_IMPORT_REQUEUED', 'MerchantImportOperation', operation.id, { status: BatchOperationStatus.PROCESSING }, { status: BatchOperationStatus.PENDING, reason: 'stale-processing' }, manager);
        return true;
      });
      if (changed) requeued += 1;
    }
    return requeued;
  }

  private async processOne(operationId: string): Promise<void> {
    const claimed = await this.dataSource.transaction(async (manager) => {
      const operation = await manager.findOne(MerchantImportOperation, { where: { id: operationId, status: BatchOperationStatus.PENDING }, lock: { mode: 'pessimistic_write' } });
      if (!operation) return false;
      operation.status = BatchOperationStatus.PROCESSING;
      operation.startedAt = new Date();
      await manager.save(MerchantImportOperation, operation);
      return true;
    });
    if (!claimed) return;
    try {
      const operation = await this.operations.findOneByOrFail({ id: operationId, status: BatchOperationStatus.PROCESSING });
      const requester = await this.users.findOneBy({ id: operation.requestedBy, active: true });
      if (!requester) throw new ForbiddenException('导入发起账号已停用，任务不能继续执行');
      this.assertRequester(requester, operation.agencyId);
      const summary = await this.processItems(requester, operation, operation.payload as unknown as MerchantImportPayload);
      await this.dataSource.transaction(async (manager) => {
        const locked = await manager.findOne(MerchantImportOperation, { where: { id: operation.id, status: BatchOperationStatus.PROCESSING }, lock: { mode: 'pessimistic_write' } });
        if (!locked) return;
        locked.succeededCount = summary.succeeded;
        locked.failedCount = summary.failed;
        locked.results = summary.results;
        locked.status = summary.failed === 0 ? BatchOperationStatus.COMPLETED : summary.succeeded === 0 ? BatchOperationStatus.FAILED : BatchOperationStatus.PARTIAL;
        locked.error = summary.failed ? '部分商家未导入，请查看逐项结果' : '';
        locked.completedAt = new Date();
        const saved = await manager.save(MerchantImportOperation, locked);
        await this.auditWriter.write(saved.requestedBy, null, 'MERCHANT_IMPORT_COMPLETED', 'MerchantImportOperation', saved.id, { status: BatchOperationStatus.PROCESSING }, { agencyId: saved.agencyId, status: saved.status, succeededCount: saved.succeededCount, failedCount: saved.failedCount }, manager);
      });
    } catch (error) {
      await this.dataSource.transaction(async (manager) => {
        const operation = await manager.findOne(MerchantImportOperation, { where: { id: operationId, status: BatchOperationStatus.PROCESSING }, lock: { mode: 'pessimistic_write' } });
        if (!operation) return;
        operation.status = BatchOperationStatus.FAILED;
        operation.error = error instanceof Error ? error.message.slice(0, 500) : '商家导入任务执行失败';
        operation.completedAt = new Date();
        await manager.save(MerchantImportOperation, operation);
        await this.auditWriter.write(operation.requestedBy, null, 'MERCHANT_IMPORT_FAILED', 'MerchantImportOperation', operation.id, { status: BatchOperationStatus.PROCESSING }, { agencyId: operation.agencyId, status: operation.status, error: operation.error }, manager);
      });
    }
  }

  private async processItems(requester: User, operation: MerchantImportOperation, payload: MerchantImportPayload): Promise<{ results: Array<Record<string, unknown>>; succeeded: number; failed: number }> {
    const results: Array<Record<string, unknown>> = [];
    let succeeded = 0;
    let failed = 0;
    let lastHeartbeatAt = 0;
    for (const [index, item] of payload.items.entries()) {
      if (index === 0 || Date.now() - lastHeartbeatAt >= 30_000) {
        await this.operations.update({ id: operation.id, status: BatchOperationStatus.PROCESSING }, { updatedAt: new Date() });
        lastHeartbeatAt = Date.now();
      }
      try {
        const merchant = await this.tenantAdministration.createMerchant(requester, {
          agencyId: operation.agencyId, legalName: item.legalName, brandName: item.brandName, servicePhone: item.servicePhone,
          contractNumber: item.contractNumber, contractEndsAt: item.contractEndsAt, rate: item.rate,
          idempotencyKey: `merchant-import-${operation.id}-${item.externalRef}`, operationId: operation.id, importExternalRef: item.externalRef,
        });
        succeeded += 1;
        results.push({ externalRef: item.externalRef, ok: true, merchantId: merchant.id, brandName: merchant.brandName, status: merchant.status });
      } catch (error) {
        failed += 1;
        results.push({ externalRef: item.externalRef, ok: false, error: error instanceof HttpException || error instanceof Error ? error.message.slice(0, 300) : '商家导入失败' });
      }
    }
    return { results, succeeded, failed };
  }

  private normalizePayload(input: MerchantImportPayload): MerchantImportPayload {
    if (!input || !Array.isArray(input.items) || input.items.length < 1 || input.items.length > 100) throw new BadRequestException('一次最多导入 100 家商家');
    const seen = new Set<string>();
    const items = input.items.map((item) => {
      const externalRef = this.requiredText(item?.externalRef, '导入行标识', 64);
      if (!/^[A-Za-z0-9_-]+$/.test(externalRef)) throw new BadRequestException('导入行标识只能包含字母、数字、下划线和短横线');
      if (seen.has(externalRef)) throw new BadRequestException('导入行标识不能重复');
      seen.add(externalRef);
      return {
        externalRef, legalName: this.requiredText(item.legalName, '商家主体', 200), brandName: this.requiredText(item.brandName, '品牌名称', 80),
        servicePhone: this.optionalText(item.servicePhone, '服务电话', 40), contractNumber: this.optionalText(item.contractNumber, '合同编号', 80),
        contractEndsAt: item.contractEndsAt, rate: item.rate,
      };
    });
    return { note: this.requiredText(input.note, '商家导入说明', 500), items };
  }

  private assertRequester(user: User, agencyId: string): void {
    if (user.role === UserRole.PLATFORM_ADMIN) { this.merchantAccess.requirePlatformAccess(user, '批量导入商家', [PlatformAccessProfile.OPERATIONS]); return; }
    if (user.role !== UserRole.AGENCY_ADMIN || user.agencyId !== agencyId) throw new ForbiddenException('只能向当前代理商导入商家');
  }
  private scopeAgencyId(user: User): string | null {
    if (user.role === UserRole.PLATFORM_ADMIN) { this.merchantAccess.requirePlatformAccess(user, '查看商家导入任务', [PlatformAccessProfile.OPERATIONS]); return null; }
    if (user.role !== UserRole.AGENCY_ADMIN || !user.agencyId) throw new ForbiddenException('当前账号不能查看商家导入任务');
    return user.agencyId;
  }
  private async retryRecord(manager: EntityManager, requestedBy: string, idempotencyKey: string): Promise<MerchantImportOperation | null> {
    return manager.getRepository(MerchantImportOperation).createQueryBuilder('operation').addSelect(['operation.idempotencyKey', 'operation.requestHash']).where('operation.requestedBy = :requestedBy AND operation.idempotencyKey = :idempotencyKey', { requestedBy, idempotencyKey }).getOne();
  }
  private assertSameRequest(operation: MerchantImportOperation, requestHash: string): void { if (operation.requestHash !== requestHash) throw new ConflictException('商家导入请求标识已用于其他内容，请刷新后重试'); }
  private safeOperation(operation: MerchantImportOperation): MerchantImportOperationView { const { idempotencyKey: _idempotencyKey, requestHash: _requestHash, ...safe } = operation; return safe; }
  private operationSummary(operation: MerchantImportOperation): MerchantImportOperationSummary {
    return {
      id: operation.id, agencyId: operation.agencyId, requestedBy: operation.requestedBy, status: operation.status,
      totalCount: operation.totalCount, succeededCount: operation.succeededCount, failedCount: operation.failedCount, error: operation.error,
      startedAt: operation.startedAt, completedAt: operation.completedAt, createdAt: operation.createdAt, updatedAt: operation.updatedAt,
    };
  }
  private requiredKey(value: unknown): string { const key = this.requiredText(value, '商家导入请求标识', 128); if (!/^[A-Za-z0-9_-]{12,128}$/.test(key)) throw new BadRequestException('商家导入请求标识格式不正确'); return key; }
  private requiredText(value: unknown, label: string, maxLength: number): string { if (typeof value !== 'string') throw new BadRequestException(`${label}格式不正确`); const text = value.trim(); if (!text || text.length > maxLength) throw new BadRequestException(`${label}不能为空且不能超过 ${maxLength} 个字符`); return text; }
  private optionalText(value: unknown, label: string, maxLength: number): string | undefined { if (value === undefined || value === null || value === '') return undefined; return this.requiredText(value, label, maxLength); }
  private isUniqueConstraintError(error: unknown): boolean { return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === '23505'; }
}
