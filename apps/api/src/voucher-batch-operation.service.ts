import { BadRequestException, ConflictException, ForbiddenException, HttpException, Injectable, NotFoundException } from '@nestjs/common';
import { createHash } from 'crypto';
import { DataSource, EntityManager, In } from 'typeorm';
import { AuditWriterService } from './audit-writer.service';
import { BatchOperation, BatchOperationKind, BatchOperationStatus, PlatformAccessProfile, Store, User, UserRole, Voucher } from './domain/entities';
import { MerchantAccessService } from './merchant-access.service';
import { VoucherFulfillmentService } from './voucher-fulfillment.service';

export type VoucherStoreTransferItem = { voucherId: string; expectedStoreId: string; targetStoreId: string };
export type VoucherStoreTransferPayload = { note: string; items: VoucherStoreTransferItem[] };
export type VoucherBatchOperationView = Omit<BatchOperation, 'idempotencyKey' | 'requestHash'>;
export type VoucherBatchItemSummary = { results: Array<Record<string, unknown>>; succeeded: number; failed: number };

@Injectable()
export class VoucherBatchOperationService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly merchantAccess: MerchantAccessService,
    private readonly auditWriter: AuditWriterService,
    private readonly voucherFulfillment: VoucherFulfillmentService,
  ) {}

  async request(user: User, merchantId: string, input: VoucherStoreTransferPayload, rawIdempotencyKey: string): Promise<VoucherBatchOperationView> {
    if (user.role !== UserRole.PLATFORM_ADMIN) throw new ForbiddenException('仅平台运营可执行批量转店');
    this.merchantAccess.requirePlatformAccess(user, '批量转移券的核销门店', [PlatformAccessProfile.OPERATIONS]);
    await this.merchantAccess.getForUser(user, merchantId, [PlatformAccessProfile.OPERATIONS]);
    const payload = this.normalizePayload(input);
    const idempotencyKey = this.requiredKey(rawIdempotencyKey);
    const requestHash = createHash('sha256').update(JSON.stringify({ merchantId, ...payload })).digest('hex');
    try {
      return await this.dataSource.transaction(async (manager) => {
        const retried = await this.retryRecord(manager, user.id, idempotencyKey);
        if (retried) { this.assertSameRequest(retried, requestHash); return this.safeOperation(retried); }
        const voucherIds = payload.items.map((item) => item.voucherId);
        const voucherCount = await manager.countBy(Voucher, { id: In(voucherIds), merchantId });
        if (voucherCount !== voucherIds.length) throw new NotFoundException('批量转店包含不存在或不属于当前商家的券');
        const targetStoreIds = [...new Set(payload.items.map((item) => item.targetStoreId))];
        const targetStoreCount = await manager.countBy(Store, { id: In(targetStoreIds), merchantId });
        if (targetStoreCount !== targetStoreIds.length) throw new BadRequestException('批量转店包含不属于当前商家的目标门店');
        const operation = await manager.save(BatchOperation, {
          kind: BatchOperationKind.VOUCHER_STORE_TRANSFER,
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
      if (retried) { this.assertSameRequest(retried, requestHash); return this.safeOperation(retried); }
      if (this.isUniqueConstraintError(error)) throw new ConflictException('该批量操作请求已存在，请刷新后重试');
      throw error;
    }
  }

  async processItems(manager: EntityManager, operation: BatchOperation, payload: VoucherStoreTransferPayload): Promise<VoucherBatchItemSummary> {
    const results: Array<Record<string, unknown>> = [];
    let succeeded = 0;
    let failed = 0;
    for (const item of payload.items) {
      try {
        const voucher = await this.voucherFulfillment.transferStoreWithManager(manager, operation.requestedBy, item.voucherId, item.targetStoreId, item.expectedStoreId, operation.id, payload.note);
        succeeded += 1;
        results.push({ voucherId: item.voucherId, ok: true, storeId: voucher.storeId });
      } catch (error) {
        if (!(error instanceof HttpException)) throw error;
        failed += 1;
        results.push({ voucherId: item.voucherId, ok: false, error: error instanceof Error ? error.message.slice(0, 300) : '券转店失败' });
      }
    }
    return { results, succeeded, failed };
  }

  private normalizePayload(input: VoucherStoreTransferPayload): VoucherStoreTransferPayload {
    if (!input || !Array.isArray(input.items) || input.items.length < 1 || input.items.length > 100) throw new BadRequestException('一次最多处理 100 张券');
    const seen = new Set<string>();
    const items = input.items.map((item) => {
      for (const [label, value] of [['券', item?.voucherId], ['原门店', item?.expectedStoreId], ['目标门店', item?.targetStoreId]] as const) if (typeof value !== 'string' || !/^[0-9a-f-]{36}$/i.test(value)) throw new BadRequestException(`${label} ID 格式不正确`);
      if (seen.has(item.voucherId)) throw new BadRequestException('批量转店券列表不能重复');
      if (item.expectedStoreId === item.targetStoreId) throw new BadRequestException('目标门店不能与原核销门店相同');
      seen.add(item.voucherId);
      return { voucherId: item.voucherId, expectedStoreId: item.expectedStoreId, targetStoreId: item.targetStoreId };
    });
    return { note: this.requiredText(input.note, '批量转店说明', 500), items };
  }

  private async retryRecord(manager: EntityManager, requestedBy: string, idempotencyKey: string): Promise<BatchOperation | null> {
    return manager.getRepository(BatchOperation).createQueryBuilder('operation').addSelect(['operation.idempotencyKey', 'operation.requestHash']).where('operation.requestedBy = :requestedBy AND operation.idempotencyKey = :idempotencyKey', { requestedBy, idempotencyKey }).getOne();
  }
  private assertSameRequest(operation: BatchOperation, requestHash: string): void { if (operation.requestHash !== requestHash) throw new ConflictException('批量操作请求标识已用于其他内容，请刷新后重试'); }
  private safeOperation(operation: BatchOperation): VoucherBatchOperationView { const { idempotencyKey: _idempotencyKey, requestHash: _requestHash, ...safe } = operation; return safe; }
  private requiredKey(value: unknown): string { const key = this.requiredText(value, '批量请求标识', 128); if (!/^[A-Za-z0-9_-]{12,128}$/.test(key)) throw new BadRequestException('批量请求标识格式不正确'); return key; }
  private requiredText(value: unknown, label: string, maxLength: number): string { if (typeof value !== 'string') throw new BadRequestException(`${label}格式不正确`); const text = value.trim(); if (!text || text.length > maxLength) throw new BadRequestException(`${label}不能为空且不能超过 ${maxLength} 个字符`); return text; }
  private isUniqueConstraintError(error: unknown): boolean { return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === '23505'; }
}
