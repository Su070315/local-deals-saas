import { ServiceUnavailableException } from '@nestjs/common';
import { RefundPaymentStage, RefundStatus, VoucherStatus } from './domain/entities';
import { RefundService } from './refund.service';

 describe('RefundService delayed settlement refund state machine', () => {
  const voucherId = '22222222-0000-4000-8000-000000000000';
  const refundId = '33333333-0000-4000-8000-000000000000';
  const orderId = '44444444-0000-4000-8000-000000000000';
  const merchantId = '55555555-0000-4000-8000-000000000000';

  const makeFixture = (stage = RefundPaymentStage.DIRECT) => {
    process.env.HUIFU_DELAYED_SETTLEMENT_ENABLED = 'true';
    const refund = {
      id: refundId,
      voucherId,
      orderId,
      merchantId,
      amountFen: 3990,
      status: RefundStatus.PROCESSING,
      paymentStage: stage,
      paymentReference: null,
      confirmRefundRequestSeq: null,
      confirmRefundRequestDate: null,
      createdAt: new Date('2026-09-12T10:00:00.000Z'),
      attemptCount: 1,
    } as any;
    const voucher = {
      id: voucherId,
      orderId,
      merchantId,
      faceValueFen: 3990,
      verificationId: '66666666-0000-4000-8000-000000000000',
      status: VoucherStatus.REFUND_PENDING,
    } as any;
    const order = { id: orderId, orderNo: 'DG202609120001', merchantId, createdAt: new Date('2026-09-12T09:00:00.000Z') } as any;
    const route = { paymentProfileId: 'profile-1', providerMerchantId: '666600009999', provider: 'HUIFU' };
    const provider = {
      enabled: true,
      requiresMerchantProfile: false,
      confirmRefund: jest.fn(),
      queryConfirmRefund: jest.fn(),
      refund: jest.fn(),
      queryRefund: jest.fn(),
    };
    const delayedSettlement = {
      confirmedForVoucher: jest.fn().mockResolvedValue(true),
      hasTransactionForOrder: jest.fn().mockResolvedValue(true),
      confirmationContextForVoucher: jest.fn().mockResolvedValue({
        paymentReference: 'pay-original-1',
        confirmationRequestSeq: 'c-confirm-1',
        confirmationRequestDate: new Date('2026-09-12T09:30:00.000Z'),
        acctSplitBunch: [{ div_amt: '39.90' }],
      }),
      markRefundedForVoucher: jest.fn(),
    };
    const refunds = { update: jest.fn().mockResolvedValue(undefined), findOneBy: jest.fn().mockResolvedValue(refund) };
    const dataSource = { transaction: jest.fn(), getRepository: jest.fn() };
    const instance = new RefundService(
      dataSource as never,
      { write: jest.fn() } as never,
      { requirePlatformAccess: jest.fn() } as never,
      { completeApprovedExceptionRefundBySystem: jest.fn() } as never,
      { customerInbox: jest.fn(), merchantAdmins: jest.fn(), platformAdmins: jest.fn() } as never,
      delayedSettlement as never,
      provider as never,
      {} as never,
      refunds as never,
      { findOneBy: jest.fn().mockResolvedValue(route) } as never,
      {} as never,
    );
    (instance as any).prepare = jest.fn().mockResolvedValue({ refund, voucher, order, paymentRequired: true });
    (instance as any).merchantFundsInsufficient = jest.fn().mockResolvedValue(false);
    return { instance, refund, voucher, order, provider, delayedSettlement, refunds, route };
  };

  afterEach(() => {
    delete process.env.HUIFU_DELAYED_SETTLEMENT_ENABLED;
    jest.restoreAllMocks();
  });

  it('confirms the distributed amount before calling ordinary refund', async () => {
    const fixture = makeFixture();
    fixture.provider.confirmRefund.mockResolvedValue({ status: 'SUCCEEDED', paymentReference: 'confirm-refund-1' });
    fixture.provider.refund.mockResolvedValue({ paymentReference: 'ordinary-refund-1' });
    (fixture.instance as any).finalize = jest.fn().mockResolvedValue({ ...fixture.refund, status: RefundStatus.SUCCEEDED });

    await (fixture.instance as any).execute(fixture.voucher.id, { actorId: 'system', reason: 'TEST' });

    expect(fixture.provider.confirmRefund).toHaveBeenCalledTimes(1);
    expect(fixture.provider.refund).toHaveBeenCalledTimes(1);
    expect(fixture.provider.confirmRefund.mock.invocationCallOrder[0]).toBeLessThan(fixture.provider.refund.mock.invocationCallOrder[0]);
    expect(fixture.provider.confirmRefund).toHaveBeenCalledWith(expect.objectContaining({
      delayedSettlementReference: 'pay-original-1',
      confirmationRequestSeq: 'c-confirm-1',
      acctSplitBunch: [{ div_amt: '39.90' }],
    }));
    expect(fixture.refunds.update).toHaveBeenCalledWith(refundId, expect.objectContaining({
      confirmationRequestSeq: 'c-confirm-1',
      confirmRefundRequestSeq: expect.stringMatching(/^cr/),
    }));
  });

  it('does not call ordinary refund while confirmrefund is processing', async () => {
    const fixture = makeFixture();
    fixture.provider.confirmRefund.mockResolvedValue({ status: 'PROCESSING', paymentReference: 'confirm-refund-pending' });

    await expect((fixture.instance as any).execute(fixture.voucher.id, { actorId: 'system', reason: 'TEST' }))
      .rejects.toBeInstanceOf(ServiceUnavailableException);

    expect(fixture.provider.confirmRefund).toHaveBeenCalledTimes(1);
    expect(fixture.provider.refund).not.toHaveBeenCalled();
    expect(fixture.refunds.update).toHaveBeenCalledWith(refundId, expect.objectContaining({ paymentStage: RefundPaymentStage.CONFIRM_REFUND_PROCESSING }));
  });

  it('keeps ordinary stage pending when ordinary refund submission fails after confirmrefund succeeds', async () => {
    const fixture = makeFixture();
    fixture.provider.confirmRefund.mockResolvedValue({ status: 'SUCCEEDED', paymentReference: 'confirm-refund-1' });
    fixture.provider.refund.mockRejectedValue(new Error('ordinary refund unavailable'));
    (fixture.instance as any).finalize = jest.fn();

    await expect((fixture.instance as any).execute(fixture.voucher.id, { actorId: 'system', reason: 'TEST' }))
      .rejects.toBeInstanceOf(ServiceUnavailableException);

    expect(fixture.provider.confirmRefund).toHaveBeenCalledTimes(1);
    expect(fixture.provider.refund).toHaveBeenCalledTimes(1);
    expect(fixture.refunds.update).toHaveBeenCalledWith(refundId, expect.objectContaining({ paymentStage: RefundPaymentStage.ORDINARY_REFUND_PROCESSING }));
    expect((fixture.instance as any).finalize).not.toHaveBeenCalled();
  });

  it('does not block an unverified Huifu delayed refund on same-day merchant inflow', async () => {
    const fixture = makeFixture();
    fixture.voucher.verificationId = null;
    (fixture.instance as any).merchantFundsInsufficient = jest.fn().mockResolvedValue(true);
    fixture.provider.refund.mockResolvedValue({ paymentReference: 'ordinary-refund-unverified-1' });
    (fixture.instance as any).finalize = jest.fn().mockResolvedValue({ ...fixture.refund, status: RefundStatus.SUCCEEDED });

    await (fixture.instance as any).execute(fixture.voucher.id, { actorId: 'system', reason: 'TEST' });

    expect((fixture.instance as any).merchantFundsInsufficient).not.toHaveBeenCalled();
    expect(fixture.provider.confirmRefund).not.toHaveBeenCalled();
    expect(fixture.provider.refund).toHaveBeenCalledTimes(1);
    expect(fixture.provider.refund).toHaveBeenCalledWith(expect.objectContaining({
      voucherId,
      provider: 'HUIFU',
      amountFen: 3990,
    }));
  });
});
