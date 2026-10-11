import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { AuditWriterService } from './audit-writer.service';
import type { PackageBatchPayload } from './batch-operation.service';
import { BatchOperation, BatchOperationKind, BatchOperationStatus, DealPackage } from './domain/entities';
import { RefundBatchOperationService, type VoucherCompensationRefundPayload } from './refund-batch-operation.service';
import { StaffBatchOperationService, type StaffStoreAccessPayload } from './staff-batch-operation.service';
import { VoucherBatchOperationService, type VoucherStoreTransferPayload } from './voucher-batch-operation.service';

type BatchItemSummary = { results: Array<Record<string, unknown>>; succeeded: number; failed: number };

@Injectable()
export class BatchOperationProcessorService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly auditWriter: AuditWriterService,
    @InjectRepository(BatchOperation) private readonly operations: Repository<BatchOperation>,
    private readonly staffBatchOperations: StaffBatchOperationService,
    private readonly voucherBatchOperations: VoucherBatchOperationService,
    private readonly refundBatchOperations: RefundBatchOperationService,
  ) {}

  async processPending(limit = 5): Promise<number> {
    const pending = await this.operations.find({ where: { status: BatchOperationStatus.PENDING }, order: { createdAt: 'ASC', id: 'ASC' }, take: Math.max(1, Math.min(limit, 20)) });
    let processed = 0;
    for (const candidate of pending) {
      await this.processOne(candidate.id);
      processed += 1;
    }
    return processed;
  }

  private async processOne(operationId: string): Promise<void> {
    const claimed = await this.dataSource.transaction(async (manager) => {
      const operation = await manager.findOne(BatchOperation, { where: { id: operationId, status: BatchOperationStatus.PENDING }, lock: { mode: 'pessimistic_write' } });
      if (!operation) return false;
      operation.status = BatchOperationStatus.PROCESSING;
      operation.startedAt = new Date();
      await manager.save(BatchOperation, operation);
      return true;
    });
    if (!claimed) return;
    try {
      const externalOperation = await this.operations.findOneBy({ id: operationId, status: BatchOperationStatus.PROCESSING });
      if (externalOperation?.kind === BatchOperationKind.VOUCHER_COMPENSATION_REFUND) {
        const summary = await this.refundBatchOperations.processItems(externalOperation, this.voucherCompensationRefundPayload(externalOperation));
        await this.dataSource.transaction(async (manager) => {
          const operation = await manager.findOne(BatchOperation, { where: { id: operationId, status: BatchOperationStatus.PROCESSING }, lock: { mode: 'pessimistic_write' } });
          if (operation) await this.completeOperation(manager, operation, summary);
        });
        return;
      }
      await this.dataSource.transaction(async (manager) => {
        const operation = await manager.findOne(BatchOperation, { where: { id: operationId, status: BatchOperationStatus.PROCESSING }, lock: { mode: 'pessimistic_write' } });
        if (!operation) return;
        const summary = operation.kind === BatchOperationKind.PACKAGE_STATUS
          ? await this.processPackageStatusItems(manager, operation, this.packagePayload(operation))
          : operation.kind === BatchOperationKind.STAFF_STORE_ACCESS
            ? await this.staffBatchOperations.processItems(manager, operation, this.staffStoreAccessPayload(operation))
            : operation.kind === BatchOperationKind.VOUCHER_STORE_TRANSFER
              ? await this.voucherBatchOperations.processItems(manager, operation, this.voucherStoreTransferPayload(operation))
            : (() => { throw new BadRequestException('批量任务类型不受支持'); })();
        await this.completeOperation(manager, operation, summary);
      });
    } catch (error) {
      await this.dataSource.transaction(async (manager) => {
        const operation = await manager.findOne(BatchOperation, { where: { id: operationId, status: BatchOperationStatus.PROCESSING }, lock: { mode: 'pessimistic_write' } });
        if (!operation) return;
        operation.status = BatchOperationStatus.FAILED;
        operation.error = error instanceof Error ? error.message.slice(0, 500) : '批量任务执行失败';
        operation.completedAt = new Date();
        await manager.save(BatchOperation, operation);
        await this.auditWriter.write(operation.requestedBy, operation.merchantId, 'BATCH_OPERATION_FAILED', 'BatchOperation', operation.id, { status: BatchOperationStatus.PROCESSING }, { status: operation.status, error: operation.error }, manager);
      });
    }
  }

  private async processPackageStatusItems(manager: EntityManager, operation: BatchOperation, payload: PackageBatchPayload): Promise<BatchItemSummary> {
    const results: Array<Record<string, unknown>> = [];
    let succeeded = 0;
    let failed = 0;
    for (const item of payload.items) {
      const deal = await manager.findOne(DealPackage, { where: { id: item.packageId, merchantId: operation.merchantId }, lock: { mode: 'pessimistic_write' } });
      if (!deal) { failed += 1; results.push({ packageId: item.packageId, ok: false, error: '套餐不存在或已不属于当前商家' }); continue; }
      if (deal.version !== item.expectedVersion) { failed += 1; results.push({ packageId: item.packageId, ok: false, error: '套餐版本已变化，请刷新后重试' }); continue; }
      const before = { status: deal.status, version: deal.version };
      if (deal.status !== payload.status) {
        deal.status = payload.status;
        deal.version += 1;
        await manager.save(DealPackage, deal);
        await this.auditWriter.write(operation.requestedBy, operation.merchantId, 'PACKAGE_BATCH_STATUS_CHANGED', 'DealPackage', deal.id, before, { status: deal.status, version: deal.version, operationId: operation.id, note: payload.note }, manager);
      }
      succeeded += 1;
      results.push({ packageId: deal.id, ok: true, status: deal.status, version: deal.version });
    }
    return { results, succeeded, failed };
  }

  private packagePayload(operation: BatchOperation): PackageBatchPayload { return operation.payload as unknown as PackageBatchPayload; }
  private staffStoreAccessPayload(operation: BatchOperation): StaffStoreAccessPayload { return operation.payload as unknown as StaffStoreAccessPayload; }
  private voucherStoreTransferPayload(operation: BatchOperation): VoucherStoreTransferPayload { return operation.payload as unknown as VoucherStoreTransferPayload; }
  private voucherCompensationRefundPayload(operation: BatchOperation): VoucherCompensationRefundPayload { return operation.payload as unknown as VoucherCompensationRefundPayload; }
  private async completeOperation(manager: EntityManager, operation: BatchOperation, summary: BatchItemSummary): Promise<void> {
    operation.succeededCount = summary.succeeded;
    operation.failedCount = summary.failed;
    operation.results = summary.results;
    operation.status = summary.failed === 0 ? BatchOperationStatus.COMPLETED : summary.succeeded === 0 ? BatchOperationStatus.FAILED : BatchOperationStatus.PARTIAL;
    operation.completedAt = new Date();
    operation.error = summary.failed ? '部分批量项目未完成，请查看逐项结果' : '';
    const saved = await manager.save(BatchOperation, operation);
    await this.auditWriter.write(operation.requestedBy, operation.merchantId, 'BATCH_OPERATION_COMPLETED', 'BatchOperation', saved.id, { status: BatchOperationStatus.PROCESSING }, { status: saved.status, succeededCount: saved.succeededCount, failedCount: saved.failedCount }, manager);
  }
}
