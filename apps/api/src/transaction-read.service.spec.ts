import { PaymentEvent, PaymentEventStatus, PaymentEventType, Refund, UserRole } from './domain/entities';
import { TransactionReadService } from './transaction-read.service';

describe('TransactionReadService merchant finance flows', () => {
  it('returns scoped payment events without provider references or hashes', async () => {
    const payment = Object.assign(new PaymentEvent(), {
      id: '11111111-1111-4111-8111-111111111111', orderId: '22222222-2222-4222-8222-222222222222', merchantId: merchantId,
      provider: 'wechat_pay', providerEventId: 'provider-event-secret', providerPaymentReference: 'provider-payment-secret',
      eventType: PaymentEventType.PAYMENT_SUCCEEDED, amountFen: 3990, occurredAt: new Date('2026-07-31T10:30:00Z'), receivedAt: new Date('2026-07-31T10:30:01Z'),
      rawPayloadHash: 'a'.repeat(64), normalizedHash: 'b'.repeat(64), status: PaymentEventStatus.PROCESSED, processingNote: '', updatedAt: new Date(),
    });
    const { service, scope } = fixture([payment], []);

    const result = await service.listPaymentTransactions(user(), { merchantId, page: 1, pageSize: 25 });

    expect(scope.resolve).toHaveBeenCalledWith(expect.anything(), merchantId, expect.any(Array));
    expect(result.items).toEqual([expect.objectContaining({ id: payment.id, orderNo: 'DG20260731DEMO0001', provider: 'wechat_pay', amountFen: 3990 })]);
    expect(result.items[0]).not.toHaveProperty('providerPaymentReference');
    expect(result.items[0]).not.toHaveProperty('providerEventId');
    expect(result.items[0]).not.toHaveProperty('rawPayloadHash');
    expect(result.items[0]).not.toHaveProperty('normalizedHash');
  });

  it('returns refund attempts without exposing the payment reference', async () => {
    const refund = Object.assign(new Refund(), {
      id: '33333333-3333-4333-8333-333333333333', voucherId: '44444444-4444-4444-8444-444444444444', orderId: '22222222-2222-4222-8222-222222222222', merchantId,
      amountFen: 3990, reason: 'CUSTOMER_SELF_SERVICE', status: 'SUCCEEDED', paymentReference: 'refund-provider-secret',
      lastAttemptAt: new Date('2026-07-31T11:00:00Z'), attemptCount: 1, createdAt: new Date('2026-07-31T10:59:00Z'),
    });
    const { service } = fixture([], [refund]);

    const result = await service.listRefundTransactions(user(), { merchantId, page: 1, pageSize: 25 });

    expect(result.items).toEqual([expect.objectContaining({ id: refund.id, orderNo: 'DG20260731DEMO0001', status: 'SUCCEEDED', amountFen: 3990 })]);
    expect(result.items[0]).not.toHaveProperty('paymentReference');
  });
});

const merchantId = '55555555-5555-4555-8555-555555555555';

function user() { return { id: 'user-1', role: UserRole.MERCHANT_ADMIN, merchantId } as never; }

function fixture(payments: PaymentEvent[], refunds: Refund[]) {
  const paymentBuilder = queryBuilder(payments);
  const refundBuilder = queryBuilder(refunds);
  const scope = { resolve: jest.fn().mockResolvedValue({ kind: 'merchant', merchantId }), apply: jest.fn((_scope, builder) => builder) };
  const orders = { find: jest.fn().mockResolvedValue([{ id: '22222222-2222-4222-8222-222222222222', orderNo: 'DG20260731DEMO0001' }]) };
  const paymentRepository = { createQueryBuilder: jest.fn(() => paymentBuilder) };
  const refundRepository = { createQueryBuilder: jest.fn(() => refundBuilder) };
  const vouchers = { findBy: jest.fn().mockResolvedValue([]) };
  const supportTickets = { findBy: jest.fn().mockResolvedValue([]) };
  const service = new TransactionReadService(scope as never, orders as never, paymentRepository as never, vouchers as never, refundRepository as never, {} as never, supportTickets as never);
  return { service, scope };
}

function queryBuilder<T>(records: T[]) {
  const builder: Record<string, jest.Mock> = {};
  ['orderBy', 'addOrderBy', 'skip', 'take'].forEach((method) => { builder[method] = jest.fn(() => builder); });
  builder.getMany = jest.fn().mockResolvedValue(records);
  builder.getCount = jest.fn().mockResolvedValue(records.length);
  return builder;
}
