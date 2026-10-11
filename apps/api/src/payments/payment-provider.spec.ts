import { calculateServiceFeeFen } from '../domain/fee';
import { PaymentEventType } from '../domain/entities';
import { MockPaymentProvider } from './payment-provider';

describe('transaction primitives', () => {
  it('rounds a voucher service fee to fen', () => {
    expect(calculateServiceFeeFen(3990, '0.0800')).toBe(319);
    expect(calculateServiceFeeFen(101, 0.075)).toBe(8);
    expect(calculateServiceFeeFen(5000, '0.0003')).toBe(2);
    expect(() => calculateServiceFeeFen(100, '0.00001')).toThrow('最多四位小数');
  });

  it('creates deterministic demo payment events and retry-safe refund references', async () => {
    const provider = new MockPaymentProvider();
    const otherReplicaProvider = new MockPaymentProvider();
    const intent = { orderId: '01234567-0000-0000-0000-000000000000', orderNo: 'DG202607190123456789ABCDEF', merchantId: 'abcdef12-0000-0000-0000-000000000000', amountFen: 3990, expiresAt: new Date('2026-07-20T00:00:00.000Z'), idempotencyKey: 'payment-key-0001' };
    const payment = await provider.createDemoPaymentEvent(intent);
    const paymentRetry = await provider.createDemoPaymentEvent(intent);
    const paymentFromOtherReplica = await otherReplicaProvider.createDemoPaymentEvent(intent);
    const refundRequest = { orderId: 'order', orderNo: 'DG202607190123456789ABCDEF', voucherId: 'abcdef12-0000-0000-0000-000000000000', amountFen: 3990, idempotencyKey: 'refund-key-0001' };
    const refund = await provider.refund(refundRequest);
    const refundRetry = await provider.refund(refundRequest);
    expect(payment.eventType).toBe(PaymentEventType.PAYMENT_SUCCEEDED);
    expect(payment.providerPaymentReference).toMatch(/^mock_pay_01234567_/);
    expect(payment.occurredAt.toISOString()).toBe('2026-07-19T23:45:00.000Z');
    expect(refund.paymentReference).toMatch(/^mock_refund_abcdef12_/);
    expect(paymentRetry.providerEventId).toBe(payment.providerEventId);
    expect(paymentFromOtherReplica).toEqual(payment);
    expect(refundRetry.paymentReference).toBe(refund.paymentReference);
  });
});
