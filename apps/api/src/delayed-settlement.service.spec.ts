import {
  DelayedSettlementConfirmationOutbox,
  DelayedSettlementOutboxStatus,
  DelayedSettlementTransaction,
  DelayedSettlementTransactionStatus,
  Order,
  PaymentOutbox,
  SettlementLedgerEntry,
  Verification,
  Voucher,
} from './domain/entities';
import { DelayedSettlementService } from './delayed-settlement.service';

describe('DelayedSettlementService', () => {
  const previousFlag = process.env.HUIFU_DELAYED_SETTLEMENT_ENABLED;
  const orderId = '01234567-0000-4000-8000-000000000000';
  const merchantId = 'abcdef12-0000-4000-8000-000000000000';
  const voucherId = '22222222-0000-4000-8000-000000000000';
  const verificationId = '33333333-0000-4000-8000-000000000000';

  afterEach(() => {
    jest.restoreAllMocks();
    if (previousFlag === undefined) delete process.env.HUIFU_DELAYED_SETTLEMENT_ENABLED;
    else process.env.HUIFU_DELAYED_SETTLEMENT_ENABLED = previousFlag;
  });

  function service(overrides: Record<string, unknown> = {}) {
    const dataSource = { transaction: jest.fn(async (callback: (manager: any) => unknown) => callback((overrides.manager as object) || {})) };
    const provider = {
      enabled: true,
      confirmPayment: jest.fn(),
      queryPaymentConfirmation: jest.fn(),
    };
    const outbox = { update: jest.fn() };
    const transactions = { findOneBy: jest.fn() };
    const orders = { findOneBy: jest.fn() };
    const paymentOutbox = { findOneBy: jest.fn() };
    const instance = new DelayedSettlementService(
      dataSource as never,
      provider as never,
      outbox as never,
      transactions as never,
      orders as never,
      paymentOutbox as never,
    );
    return { instance, dataSource, provider, outbox, transactions, orders, paymentOutbox };
  }

  it('writes one deterministic confirmation outbox row and does not enqueue twice', async () => {
    process.env.HUIFU_DELAYED_SETTLEMENT_ENABLED = 'true';
    const manager = {
      findOneBy: jest.fn()
        .mockResolvedValueOnce({ id: 'tx-1', orderId, merchantId })
        .mockResolvedValueOnce(null),
      save: jest.fn(),
    };
    const { instance } = service({ manager });
    const verification = { id: verificationId, amountFen: 3990 } as Verification;
    const voucher = { id: voucherId, orderId, merchantId } as Voucher;

    await instance.enqueueConfirmation(manager as never, verification, voucher);
    await instance.enqueueConfirmation(manager as never, verification, voucher);

    expect(manager.save).toHaveBeenCalledTimes(1);
    expect(manager.save).toHaveBeenCalledWith(DelayedSettlementConfirmationOutbox, expect.objectContaining({
      verificationId,
      idempotencyKey: `delay-confirm-${verificationId}`,
      amountFen: 3990,
      acctSplitBunch: [{ div_amt: '39.90' }],
      status: DelayedSettlementOutboxStatus.PENDING,
    }));
  });

  it('queries after a confirmation timeout instead of blindly submitting again', async () => {
    process.env.HUIFU_DELAYED_SETTLEMENT_ENABLED = 'true';
    const { instance, provider, outbox, transactions, orders, paymentOutbox } = service();
    const transaction = { id: 'tx-1', providerPaymentReference: 'pay-1' };
    const order = { id: orderId, orderNo: 'DG202609120001', merchantId, createdAt: new Date() };
    const route = { paymentProfileId: 'profile-1', providerMerchantId: '666600009999', provider: 'HUIFU' };
    transactions.findOneBy.mockResolvedValue(transaction);
    orders.findOneBy.mockResolvedValue(order);
    paymentOutbox.findOneBy.mockResolvedValue(route);
    provider.confirmPayment.mockRejectedValue(new Error('timeout'));
    provider.queryPaymentConfirmation.mockResolvedValue({ status: 'PROCESSING' });
    const row = {
      id: 'outbox-1', transactionId: transaction.id, verificationId,
      orderId, amountFen: 3990, idempotencyKey: `delay-confirm-${verificationId}`,
      acctSplitBunch: [{ div_amt: '39.90' }], attemptCount: 1,
      providerReference: null,
    } as DelayedSettlementConfirmationOutbox;

    const result = await (instance as any).processOne(row);

    expect(result).toBe('RETRY');
    expect(provider.confirmPayment).toHaveBeenCalledTimes(1);
    expect(provider.queryPaymentConfirmation).toHaveBeenCalledTimes(1);
    expect(outbox.update).toHaveBeenCalledWith('outbox-1', expect.objectContaining({ status: DelayedSettlementOutboxStatus.RETRY }));
  });

  it('creates CONFIRMED ledger only after provider confirmation succeeds and is idempotent', async () => {
    process.env.HUIFU_DELAYED_SETTLEMENT_ENABLED = 'true';
    const storedOutbox = {
      id: 'outbox-1', transactionId: 'tx-1', verificationId, voucherId,
      orderId, amountFen: 3990, idempotencyKey: `delay-confirm-${verificationId}`,
      acctSplitBunch: [{ div_amt: '39.90' }], status: DelayedSettlementOutboxStatus.PROCESSING,
      providerReference: null,
    };
    const transaction = { id: 'tx-1', providerPaymentReference: 'pay-1', status: DelayedSettlementTransactionStatus.PENDING_CONFIRMATION };
    const order = { id: orderId, orderNo: 'DG202609120001', merchantId, createdAt: new Date() };
    const route = { paymentProfileId: 'profile-1', providerMerchantId: '666600009999', provider: 'HUIFU' };
    const verification = { id: verificationId, amountFen: 3990 };
    const voucher = { id: voucherId, merchantId, faceValueFen: 3990, commissionRateSnapshot: '0.0800' };
    const saved: unknown[] = [];
    const manager = {
      findOne: jest.fn().mockImplementation((entity: unknown) => {
        if (entity === DelayedSettlementConfirmationOutbox) return storedOutbox;
        return null;
      }),
      findOneByOrFail: jest.fn().mockImplementation((entity: unknown) => entity === Verification ? verification : voucher),
      findOneBy: jest.fn().mockResolvedValue(transaction),
      save: jest.fn(async (_entity: unknown, value: unknown) => { saved.push(value); return value; }),
    };
    const { instance, provider, transactions, orders, paymentOutbox, dataSource } = service({ manager });
    transactions.findOneBy.mockResolvedValue(transaction);
    orders.findOneBy.mockResolvedValue(order);
    paymentOutbox.findOneBy.mockResolvedValue(route);
    provider.confirmPayment.mockResolvedValue({ providerReference: 'confirm-1' });
    provider.queryPaymentConfirmation.mockResolvedValue(null);

    await (instance as any).processOne(storedOutbox);
    await (instance as any).processOne(storedOutbox);

    expect(dataSource.transaction).toHaveBeenCalledTimes(2);
    expect(saved.filter((value) => (value as { entryType?: string }).entryType === 'CONFIRMED')).toHaveLength(1);
    expect(storedOutbox.status).toBe(DelayedSettlementOutboxStatus.CONFIRMED);
    expect(transaction.status).toBe(DelayedSettlementTransactionStatus.CONFIRMED);
  });

  it('does not create delayed records when the feature flag is off', async () => {
    delete process.env.HUIFU_DELAYED_SETTLEMENT_ENABLED;
    const manager = { findOneBy: jest.fn(), save: jest.fn() };
    const { instance } = service({ manager });

    await instance.enqueueConfirmation(manager as never, { id: verificationId, amountFen: 3990 } as Verification, { id: voucherId, orderId, merchantId } as Voucher);

    expect(manager.findOneBy).not.toHaveBeenCalled();
    expect(manager.save).not.toHaveBeenCalled();
  });
});
