import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { createHash } from 'crypto';
import { DataSource, EntityManager, In } from 'typeorm';
import { AuditWriterService } from './audit-writer.service';
import { BatchOperation, BatchOperationKind, BatchOperationStatus, PlatformAccessProfile, Store, User, UserRole } from './domain/entities';
import { MerchantAccessService } from './merchant-access.service';

export type StaffStoreAccessItem = { staffId: string; expectedStoreIds: string[]; storeIds: string[] };
export type StaffStoreAccessPayload = { note: string; items: StaffStoreAccessItem[] };
export type StaffBatchOperationView = Omit<BatchOperation, 'idempotencyKey' | 'requestHash'>;
export type BatchItemSummary = { results: Array<Record<string, unknown>>; succeeded: number; failed: number };

@Injectable()
export class StaffBatchOperationService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly merchantAccess: MerchantAccessService,
    private readonly auditWriter: AuditWriterService,
  ) {}

  async request(user: User, merchantId: string, input: StaffStoreAccessPayload, rawIdempotencyKey: string): Promise<StaffBatchOperationView> {
    await this.assertMerchantOperator(user, merchantId);
    const payload = this.normalizePayload(input);
    const idempotencyKey = this.requiredKey(rawIdempotencyKey);
    const requestHash = createHash('sha256').update(JSON.stringify({ merchantId, ...payload })).digest('hex');
    try {
      return await this.dataSource.transaction(async (manager) => {
        const retried = await this.retryRecord(manager, user.id, idempotencyKey);
        if (retried) {
          this.assertSameRequest(retried, requestHash);
          return this.safeOperation(retried);
        }
        const staffIds = payload.items.map((item) => item.staffId);
        const staff = await manager.getRepository(User).find({ where: { id: In(staffIds), merchantId, role: UserRole.STORE_STAFF } });
        if (staff.length !== staffIds.length) throw new NotFoundException('批量操作包含不存在或不属于当前商家的核销员');
        const targetStoreIds = [...new Set(payload.items.flatMap((item) => item.storeIds))];
        const storeCount = await manager.getRepository(Store).countBy({ id: In(targetStoreIds), merchantId });
        if (storeCount !== targetStoreIds.length) throw new BadRequestException('批量授权包含不属于当前商家的门店');
        const operation = await manager.save(BatchOperation, {
          kind: BatchOperationKind.STAFF_STORE_ACCESS,
          merchantId,
          requestedBy: user.id,
          status: BatchOperationStatus.PENDING,
          payload,
          totalCount: payload.items.length,
          succeededCount: 0,
          failedCount: 0,
          results: null,
          error: '',
          startedAt: null,
          completedAt: null,
          idempotencyKey,
          requestHash,
        });
        await this.auditWriter.write(user.id, merchantId, 'BATCH_OPERATION_REQUESTED', 'BatchOperation', operation.id, null, { kind: operation.kind, totalCount: operation.totalCount }, manager);
        return this.safeOperation(operation);
      });
    } catch (error) {
      const retried = await this.retryRecord(this.dataSource.manager, user.id, idempotencyKey);
      if (retried) {
        this.assertSameRequest(retried, requestHash);
        return this.safeOperation(retried);
      }
      if (this.isUniqueConstraintError(error)) throw new ConflictException('该批量操作请求已存在，请刷新后重试');
      throw error;
    }
  }

  async processItems(manager: EntityManager, operation: BatchOperation, payload: StaffStoreAccessPayload): Promise<BatchItemSummary> {
    const results: Array<Record<string, unknown>> = [];
    let succeeded = 0;
    let failed = 0;
    for (const item of payload.items) {
      const staff = await manager.findOne(User, { where: { id: item.staffId, merchantId: operation.merchantId, role: UserRole.STORE_STAFF }, lock: { mode: 'pessimistic_write' } });
      if (!staff) {
        failed += 1;
        results.push({ staffId: item.staffId, ok: false, error: '核销员不存在或已不属于当前商家' });
        continue;
      }
      const currentStoreIds = this.normalizedStoreIds(staff.storeIds || []);
      if (JSON.stringify(currentStoreIds) !== JSON.stringify(item.expectedStoreIds)) {
        failed += 1;
        results.push({ staffId: item.staffId, ok: false, error: '员工门店授权已变化，请刷新后重试' });
        continue;
      }
      const storeCount = await manager.countBy(Store, { id: In(item.storeIds), merchantId: operation.merchantId });
      if (storeCount !== item.storeIds.length) {
        failed += 1;
        results.push({ staffId: item.staffId, ok: false, error: '目标门店不存在或已不属于当前商家' });
        continue;
      }
      const authorizationChanged = JSON.stringify(currentStoreIds) !== JSON.stringify(item.storeIds);
      if (authorizationChanged) {
        const before = { storeIds: currentStoreIds, sessionVersion: staff.sessionVersion };
        staff.storeIds = item.storeIds;
        // Authorization changes revoke every existing verifier session before
        // the new store scope can be used.
        staff.sessionVersion += 1;
        await manager.save(User, staff);
        await this.auditWriter.write(operation.requestedBy, operation.merchantId, 'STAFF_STORE_ACCESS_BATCH_CHANGED', 'User', staff.id, before, { storeIds: item.storeIds, sessionVersion: staff.sessionVersion, operationId: operation.id, note: payload.note }, manager);
      }
      succeeded += 1;
      results.push({ staffId: staff.id, ok: true, storeIds: item.storeIds, authorizationChanged });
    }
    return { results, succeeded, failed };
  }

  private normalizePayload(input: StaffStoreAccessPayload): StaffStoreAccessPayload {
    if (!input || !Array.isArray(input.items) || input.items.length < 1 || input.items.length > 100) throw new BadRequestException('一次最多处理 100 个核销员');
    const seen = new Set<string>();
    const items = input.items.map((item) => {
      if (!item || typeof item.staffId !== 'string' || !/^[0-9a-f-]{36}$/i.test(item.staffId)) throw new BadRequestException('批量核销员 ID 格式不正确');
      if (seen.has(item.staffId)) throw new BadRequestException('批量核销员列表不能重复');
      seen.add(item.staffId);
      const expectedStoreIds = this.normalizeUuidList(item.expectedStoreIds, '原门店授权', false);
      const storeIds = this.normalizeUuidList(item.storeIds, '目标门店授权', true);
      return { staffId: item.staffId, expectedStoreIds, storeIds };
    });
    return { note: this.requiredText(input.note, '批量操作说明', 500), items };
  }

  private normalizeUuidList(value: unknown, label: string, requireOne: boolean): string[] {
    if (!Array.isArray(value) || (requireOne && value.length < 1) || value.length > 50) throw new BadRequestException(`${label}格式不正确`);
    const result = [...new Set(value.filter((item): item is string => typeof item === 'string'))];
    if (result.length !== value.length || result.some((item) => !/^[0-9a-f-]{36}$/i.test(item))) throw new BadRequestException(`${label}格式不正确`);
    if (requireOne && !result.length) throw new BadRequestException(`${label}不能为空`);
    return result.sort();
  }

  private normalizedStoreIds(storeIds: string[]): string[] { return [...new Set(storeIds)].sort(); }

  private async assertMerchantOperator(user: User, merchantId: string): Promise<void> {
    if (user.role === UserRole.PLATFORM_ADMIN) {
      this.merchantAccess.requirePlatformAccess(user, '执行批量员工授权', [PlatformAccessProfile.OPERATIONS]);
      await this.merchantAccess.getForUser(user, merchantId, [PlatformAccessProfile.OPERATIONS]);
      return;
    }
    if (![UserRole.AGENCY_ADMIN, UserRole.MERCHANT_ADMIN].includes(user.role)) throw new BadRequestException('当前账号不能执行批量员工授权');
    await this.merchantAccess.getForUser(user, merchantId, [PlatformAccessProfile.OPERATIONS]);
  }

  private async retryRecord(manager: EntityManager, requestedBy: string, idempotencyKey: string): Promise<BatchOperation | null> {
    return manager.getRepository(BatchOperation).createQueryBuilder('operation').addSelect(['operation.idempotencyKey', 'operation.requestHash']).where('operation.requestedBy = :requestedBy AND operation.idempotencyKey = :idempotencyKey', { requestedBy, idempotencyKey }).getOne();
  }

  private assertSameRequest(operation: BatchOperation, requestHash: string): void { if (operation.requestHash !== requestHash) throw new ConflictException('批量操作请求标识已用于其他内容，请刷新后重试'); }
  private safeOperation(operation: BatchOperation): StaffBatchOperationView { const { idempotencyKey: _idempotencyKey, requestHash: _requestHash, ...safe } = operation; return safe; }
  private requiredKey(value: unknown): string { const key = this.requiredText(value, '批量请求标识', 128); if (!/^[A-Za-z0-9_-]{12,128}$/.test(key)) throw new BadRequestException('批量请求标识格式不正确'); return key; }
  private requiredText(value: unknown, label: string, maxLength: number): string { if (typeof value !== 'string') throw new BadRequestException(`${label}格式不正确`); const text = value.trim(); if (!text || text.length > maxLength) throw new BadRequestException(`${label}不能为空且不能超过 ${maxLength} 个字符`); return text; }
  private isUniqueConstraintError(error: unknown): boolean { return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === '23505'; }
}
