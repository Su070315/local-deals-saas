import { BadRequestException } from '@nestjs/common';
import { InventoryBatch, InventoryBatchStatus, InventoryDocument, InventoryDocumentStatus, InventoryDocumentType } from './domain/merchant-operations.entities';
import { MerchantOperationsService } from './merchant-operations.service';

describe('MerchantOperationsService inventory documents', () => {
  it('confirms an outbound document and decrements available inventory once', async () => {
    const { service, document, batch, documentSave, batchSave } = fixture({ quantity: 10, reservedQuantity: 2, outboundQuantity: 5 });

    const result = await service.changeInventoryDocumentStatus({ id: 'user-1' } as never, document.merchantId, document.id, InventoryDocumentStatus.CONFIRMED);

    expect(batch.quantity).toBe(5);
    expect(batch.version).toBe(2);
    expect(batchSave).toHaveBeenCalledWith(batch);
    expect(document.status).toBe(InventoryDocumentStatus.CONFIRMED);
    expect(documentSave).toHaveBeenCalledTimes(1);
    expect(result.status).toBe(InventoryDocumentStatus.CONFIRMED);
  });

  it('does not consume stock that is reserved for paid orders', async () => {
    const { service, document, batchSave } = fixture({ quantity: 10, reservedQuantity: 8, outboundQuantity: 3 });

    await expect(service.changeInventoryDocumentStatus({ id: 'user-1' } as never, document.merchantId, document.id, InventoryDocumentStatus.CONFIRMED)).rejects.toBeInstanceOf(BadRequestException);

    expect(batchSave).not.toHaveBeenCalled();
    expect(document.status).toBe(InventoryDocumentStatus.DRAFT);
  });

  it('confirms a store requisition without changing physical inventory', async () => {
    const { service, document, batch, batchSave } = fixture({ quantity: 10, reservedQuantity: 2, outboundQuantity: 4, type: InventoryDocumentType.REQUISITION });

    await service.changeInventoryDocumentStatus({ id: 'user-1' } as never, document.merchantId, document.id, InventoryDocumentStatus.CONFIRMED);

    expect(batch.quantity).toBe(10);
    expect(batch.version).toBe(1);
    expect(batchSave).not.toHaveBeenCalled();
    expect(document.status).toBe(InventoryDocumentStatus.CONFIRMED);
  });
});

function fixture(input: { quantity: number; reservedQuantity: number; outboundQuantity: number; type?: InventoryDocumentType }) {
  const merchantId = '11111111-1111-4111-8111-111111111111';
  const storeId = '44444444-4444-4444-8444-444444444444';
  const batch = Object.assign(new InventoryBatch(), {
    id: '88888888-8888-4888-8888-888888888888', merchantId, storeId, packageId: null,
    skuCode: 'SKU-1', productName: '测试商品', quantity: input.quantity, reservedQuantity: input.reservedQuantity,
    unitCostFen: 1000, productionDate: null, expiresAt: null, status: InventoryBatchStatus.NORMAL,
    note: '', version: 1,
  });
  const document = Object.assign(new InventoryDocument(), {
    id: '99999999-9999-4999-8999-999999999999', merchantId, documentNo: 'CK202607310001',
    type: input.type || InventoryDocumentType.OUTBOUND, storeId, sourceStoreId: null, targetStoreId: null, counterparty: '',
    items: [{ batchId: batch.id, skuCode: batch.skuCode, productName: batch.productName, quantity: input.outboundQuantity, unitCostFen: batch.unitCostFen }],
    totalQuantity: input.outboundQuantity, totalAmountFen: input.outboundQuantity * batch.unitCostFen,
    occurredAt: new Date(), status: InventoryDocumentStatus.DRAFT, note: '', createdBy: 'user-1', confirmedBy: null, confirmedAt: null,
  });
  const documentSave = jest.fn(async (value: InventoryDocument) => value);
  const batchSave = jest.fn(async (value: InventoryBatch) => value);
  const documentRepository = { findOne: jest.fn().mockResolvedValue(document), save: documentSave };
  const batchRepository = { findOne: jest.fn().mockResolvedValue(batch), save: batchSave };
  const manager = { getRepository: jest.fn((entity: unknown) => entity === InventoryDocument ? documentRepository : batchRepository) };
  const dataSource = { transaction: jest.fn((callback: (value: typeof manager) => unknown) => callback(manager)) };
  const access = { getForUser: jest.fn().mockResolvedValue({ id: merchantId }) };
  const audit = { write: jest.fn().mockResolvedValue(undefined) };
  const service = new MerchantOperationsService(
    dataSource as never, access as never, audit as never, {} as never, {} as never,
    {} as never, {} as never, {} as never, {} as never, {} as never,
  );
  return { service, document, batch, documentSave, batchSave };
}
