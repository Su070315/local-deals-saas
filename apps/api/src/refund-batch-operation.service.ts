import { BadRequestException, ConflictException, ForbiddenException, HttpException, Injectable, NotFoundException } from '@nestjs/common';
import { createHash } from 'crypto';
import { DataSource, EntityManager, In } from 'typeorm';
import { AuditWriterService } from './audit-writer.service';
import { BatchOperation, BatchOperationKind, BatchOperationStatus, PlatformAccessProfile, Store, User, UserRole, Voucher } from './domain/entities';
import { MerchantAccessService } from './merchant-access.service';
import { RefundService } from './refund.service';

export type VoucherCompensationRefundItem = { voucherId: string; expectedStoreId: string };
export type VoucherCompensationRefundPayload = { note: string; items: VoucherCompensationRefundItem[] };
export type RefundBatchOperationView = Omit<BatchOperation, 'idempotencyKey' | 'requestHash'>;
export type RefundBatchItemSummary = { results: Array<Record<string, unknown>>; succeeded: number; failed: number };

@Injectable()
export class RefundBatchOperationService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly merchantAccess: MerchantAccessService,
    private readonly auditWriter: AuditWriterService,
    private readonly refunds: RefundService,
  ) {}

  async request(user: User, merchantId: string, input: VoucherCompensationRefundPayload, rawIdempotencyKey: string): Promise<RefundBatchOperationView> {
    if (user.role !== UserRole.PLATFORM_ADMIN) throw new ForbiddenException('仅平台财务可执行批量补偿退款');
    this.merchantAccess.requirePlatformAccess(user, '执行批量门店停业补偿退款', [PlatformAccessProfile.FINANCE]);
    await this.merchantAccess.getForUser(user, merchantId, [PlatformAccessProfile.FINANCE]);
    const payload = this.normalizePayload(input);
    const idempotencyKey = this.requiredKey(rawIdempotencyKey);
    const requestHash = createHash('sha256').update(JSON.stringify({ merchantId, ...payload })).digest('hex');
    try {
      return await this.dataSource.transaction(async (manager) => {
        const retried = await this.retryRecord(manager, user.id, idempotencyKey);
        if (retried) { this.assertSameRequest(retried, requestHash); return this.safeOperation(retried); }
        const voucherIds = payload.items.map((item) => item.voucherId);
        const vouchers = await manager.find(Voucher, { where: { id: In(voucherIds), merchantId } });
        if (vouchers.length !== voucherIds.length) throw new NotFoundException('批量补偿退款包含不存在或不属于当前商家的券');
        const storeIds = [...new Set(payload.items.map((item) => item.expectedStoreId))];
        const stores = await manager.find(Store, { where: { id: In(storeIds), merchantId } });
        if (stores.length !== storeIds.length) throw new BadRequestException('批量补偿退款包含不属于当前商家的门店');
        const voucherById = new Map(vouchers.map((voucher) => [voucher.id, voucher]));
        const storeById = new Map(stores.map((store) => [store.id, store]));
        for (const item of payload.items) {
          const voucher = voucherById.get(item.voucherId)!;
          if (voucher.storeId !== item.expectedStoreId) throw new ConflictException('批量补偿退款包含已变更核销门店的券，请刷新后重试');
          if (storeById.get(item.expectedStoreId)!.openForVerification) throw new BadRequestException('仅停止履约门店的券可进入批量补偿退款');
        }
        const operation = await manager.save(BatchOperation, {
          kind: BatchOperationKind.VOUCHER_COMPENSATION_REFUND, merchantId, requestedBy: user.id, status: BatchOperationStatus.PENDING,
          payload, totalCount: payload.items.length, succeededCount: 0, failedCount: 0, results: null, error: '', startedAt: null, completedAt: null,
          idempotencyKey, requestHash,
        });
        await this.auditWriter.write(user.id, merchantId, 'BATCH_OPERATION_REQUESTED', 'BatchOperation', operation.id, null, { kind: operation.kind, totalCount: operation.totalCount, reason: 'STORE_CLOSURE_BATCH_COMPENSATION' }, manager);
        return this.safeOperation(operation);
      });
    } catch (error) {
      const retried = await this.retryRecord(this.dataSource.manager, user.id, idempotencyKey);
      if (retried) { this.assertSameRequest(retried, requestHash); return this.safeOperation(retried); }
      if (this.isUniqueConstraintError(error)) throw new ConflictException('该批量操作请求已存在，请刷新后重试');
      throw error;
    }
  }

  async processItems(operation: BatchOperation, payload: VoucherCompensationRefundPayload): Promise<RefundBatchItemSummary> {
    const results: Array<Record<string, unknown>> = [];
    let succeeded = 0;
    let failed = 0;
    for (const item of payload.items) {
      try {
        const refund = await this.refunds.executeStoreClosureCompensationFromBatch(operation.requestedBy, item.voucherId, item.expectedStoreId, operation.id);
        if (refund.status !== 'SUCCEEDED') throw new ConflictException('退款尚未确认，请在退款失败队列中重试');
        succeeded += 1;
        results.push({ voucherId: item.voucherId, ok: true, refundId: refund.id, status: refund.status, amountFen: refund.amountFen });
      } catch (error) {
        failed += 1;
        results.push({ voucherId: item.voucherId, ok: false, error: error instanceof HttpException || error instanceof Error ? error.message.slice(0, 300) : '批量补偿退款失败' });
      }
    }
    return { results, succeeded, failed };
  }

  private normalizePayload(input: VoucherCompensationRefundPayload): VoucherCompensationRefundPayload {
    if (!input || !Array.isArray(input.items) || input.items.length < 1 || input.items.length > 100) throw new BadRequestException('一次最多处理 100 张券');
    const seen = new Set<string>();
    const items = input.items.map((item) => {
      for (const [label, value] of [['券', item?.voucherId], ['核销门店', item?.expectedStoreId]] as const) if (typeof value !== 'string' || !/^[0-9a-f-]{36}$/i.test(value)) throw new BadRequestException(`${label} ID 格式不正确`);
      if (seen.has(item.voucherId)) throw new BadRequestException('批量补偿退款券列表不能重复');
      seen.add(item.voucherId);
      return { voucherId: item.voucherId, expectedStoreId: item.expectedStoreId };
    });
    return { note: this.requiredText(input.note, '批量补偿退款说明', 500), items };
  }

  private async retryRecord(manager: EntityManager, requestedBy: string, idempotencyKey: string): Promise<BatchOperation | null> {
    return manager.getRepository(BatchOperation).createQueryBuilder('operation').addSelect(['operation.idempotencyKey', 'operation.requestHash']).where('operation.requestedBy = :requestedBy AND operation.idempotencyKey = :idempotencyKey', { requestedBy, idempotencyKey }).getOne();
  }
  private assertSameRequest(operation: BatchOperation, requestHash: string): void { if (operation.requestHash !== requestHash) throw new ConflictException('批量操作请求标识已用于其他内容，请刷新后重试'); }
  private safeOperation(operation: BatchOperation): RefundBatchOperationView { const { idempotencyKey: _idempotencyKey, requestHash: _requestHash, ...safe } = operation; return safe; }
  private requiredKey(value: unknown): string { const key = this.requiredText(value, '批量请求标识', 128); if (!/^[A-Za-z0-9_-]{12,128}$/.test(key)) throw new BadRequestException('批量请求标识格式不正确'); return key; }
  private requiredText(value: unknown, label: string, maxLength: number): string { if (typeof value !== 'string') throw new BadRequestException(`${label}格式不正确`); const text = value.trim(); if (!text || text.length > maxLength) throw new BadRequestException(`${label}不能为空且不能超过 ${maxLength} 个字符`); return text; }
  private isUniqueConstraintError(error: unknown): boolean { return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === '23505'; }
}
