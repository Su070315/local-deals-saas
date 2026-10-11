import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash } from 'crypto';
import { DataSource, EntityManager, In, Repository } from 'typeorm';
import { AuditWriterService } from './audit-writer.service';
import { BatchOperation, BatchOperationKind, BatchOperationStatus, DealPackage, PackageStatus, PlatformAccessProfile, User, UserRole } from './domain/entities';
import { MerchantAccessService } from './merchant-access.service';
import { BatchOperationProcessorService } from './batch-operation-processor.service';
import { MerchantQueryScopeService } from './merchant-query-scope.service';

type PackageBatchItem = { packageId: string; expectedVersion: number };
export type PackageBatchPayload = { status: PackageStatus; note: string; items: PackageBatchItem[] };
export type BatchOperationView = Omit<BatchOperation, 'idempotencyKey' | 'requestHash'>;

@Injectable()
export class BatchOperationService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly merchantAccess: MerchantAccessService,
    private readonly auditWriter: AuditWriterService,
    private readonly merchantScope: MerchantQueryScopeService,
    @InjectRepository(BatchOperation) private readonly operations: Repository<BatchOperation>,
    private readonly processor: BatchOperationProcessorService,
  ) {}

  async requestPackageStatusBatch(user: User, merchantId: string, input: PackageBatchPayload, rawIdempotencyKey: string): Promise<BatchOperationView> {
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
        const packageIds = payload.items.map((item) => item.packageId);
        const packages = await manager.getRepository(DealPackage).find({ where: { merchantId, id: In(packageIds) } });
        if (packages.length !== packageIds.length) throw new NotFoundException('批量操作包含不存在或不属于当前商家的套餐');
        const operation = await manager.save(BatchOperation, {
          kind: BatchOperationKind.PACKAGE_STATUS,
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
        await this.auditWriter.write(user.id, merchantId, 'BATCH_OPERATION_REQUESTED', 'BatchOperation', operation.id, null, { kind: operation.kind, totalCount: operation.totalCount, targetStatus: payload.status }, manager);
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

  async getOperation(user: User, operationId: string): Promise<BatchOperationView> {
    const operation = await this.operations.findOneBy({ id: operationId });
    if (!operation) throw new NotFoundException('批量操作不存在');
    await this.merchantAccess.getForUser(user, operation.merchantId, [PlatformAccessProfile.OPERATIONS]);
    return this.safeOperation(operation);
  }

  async listOperations(user: User, merchantId?: string): Promise<BatchOperationView[]> {
    if (user.role === UserRole.STORE_STAFF) throw new BadRequestException('核销员不可查看批量运营任务');
    const scope = await this.merchantScope.resolve(user, merchantId, [PlatformAccessProfile.OPERATIONS]);
    const operations = await this.merchantScope.apply(scope, this.operations.createQueryBuilder('operation'), 'operation')
      .orderBy('operation.createdAt', 'DESC').addOrderBy('operation.id', 'DESC').take(100).getMany();
    return operations.map((operation) => this.safeOperation(operation));
  }

  async processPending(limit = 5): Promise<number> {
    return this.processor.processPending(limit);
  }

  private normalizePayload(input: PackageBatchPayload): PackageBatchPayload {
    if (!input || !Object.values(PackageStatus).includes(input.status)) throw new BadRequestException('批量目标状态无效');
    if (!Array.isArray(input.items) || input.items.length < 1 || input.items.length > 100) throw new BadRequestException('一次最多处理 100 个套餐');
    const seen = new Set<string>();
    const items = input.items.map((item) => {
      if (!item || typeof item.packageId !== 'string' || !/^[0-9a-f-]{36}$/i.test(item.packageId)) throw new BadRequestException('批量套餐 ID 格式不正确');
      if (seen.has(item.packageId)) throw new BadRequestException('批量套餐列表不能重复');
      seen.add(item.packageId);
      if (!Number.isSafeInteger(item.expectedVersion) || item.expectedVersion < 1) throw new BadRequestException('套餐版本号不正确');
      return { packageId: item.packageId, expectedVersion: item.expectedVersion };
    });
    return { status: input.status, note: this.requiredText(input.note, '批量操作说明', 500), items };
  }

  private async assertMerchantOperator(user: User, merchantId: string): Promise<void> {
    if (user.role === UserRole.PLATFORM_ADMIN) {
      this.merchantAccess.requirePlatformAccess(user, '执行批量运营操作', [PlatformAccessProfile.OPERATIONS]);
      await this.merchantAccess.getForUser(user, merchantId, [PlatformAccessProfile.OPERATIONS]);
      return;
    }
    if (![UserRole.AGENCY_ADMIN, UserRole.MERCHANT_ADMIN].includes(user.role)) throw new BadRequestException('当前账号不能执行批量运营操作');
    await this.merchantAccess.getForUser(user, merchantId, [PlatformAccessProfile.OPERATIONS]);
  }

  private async retryRecord(manager: EntityManager, requestedBy: string, idempotencyKey: string): Promise<BatchOperation | null> {
    return manager.getRepository(BatchOperation).createQueryBuilder('operation').addSelect(['operation.idempotencyKey', 'operation.requestHash']).where('operation.requestedBy = :requestedBy AND operation.idempotencyKey = :idempotencyKey', { requestedBy, idempotencyKey }).getOne();
  }
  private assertSameRequest(operation: BatchOperation, requestHash: string): void { if (operation.requestHash !== requestHash) throw new ConflictException('批量操作请求标识已用于其他内容，请刷新后重试'); }
  private safeOperation(operation: BatchOperation): BatchOperationView { const { idempotencyKey: _idempotencyKey, requestHash: _requestHash, ...safe } = operation; return safe; }
  private requiredKey(value: unknown): string { const key = this.requiredText(value, '批量请求标识', 128); if (!/^[A-Za-z0-9_-]{12,128}$/.test(key)) throw new BadRequestException('批量请求标识格式不正确'); return key; }
  private requiredText(value: unknown, label: string, maxLength: number): string { if (typeof value !== 'string') throw new BadRequestException(`${label}格式不正确`); const text = value.trim(); if (!text || text.length > maxLength) throw new BadRequestException(`${label}不能为空且不能超过 ${maxLength} 个字符`); return text; }
  private isUniqueConstraintError(error: unknown): boolean { return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === '23505'; }
}
