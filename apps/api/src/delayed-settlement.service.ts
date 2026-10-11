import { Injectable, Inject } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, In, IsNull, LessThan, Repository } from 'typeorm';
import {
  DelayedSettlementConfirmationOutbox,
  DelayedSettlementOutboxStatus,
  DelayedSettlementTransaction,
  DelayedSettlementTransactionStatus,
  Order,
  PaymentOutbox,
  Voucher,
  Verification,
  SettlementLedgerEntry,
} from './domain/entities';
import { PAYMENT_PROVIDER, PaymentProvider, SettlementConfirmationRequest } from './payments/payment-provider';
import { huifuDelayedSettlementEnabled } from './runtime-config';
import { calculateServiceFeeFen } from './domain/fee';

const BATCH_SIZE = 20;
const PROCESSING_STALE_MS = 5 * 60_000;

@Injectable()
export class DelayedSettlementService {
  constructor(
    private readonly dataSource: DataSource,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
    @InjectRepository(DelayedSettlementConfirmationOutbox) private readonly outbox: Repository<DelayedSettlementConfirmationOutbox>,
    @InjectRepository(DelayedSettlementTransaction) private readonly transactions: Repository<DelayedSettlementTransaction>,
    @InjectRepository(Order) private readonly orders: Repository<Order>,
    @InjectRepository(PaymentOutbox) private readonly paymentOutbox: Repository<PaymentOutbox>,
  ) {}

  enabled(): boolean { return huifuDelayedSettlementEnabled(); }

  async confirmedForVoucher(voucherId: string): Promise<boolean> {
    if (!this.enabled()) return false;
    const outbox = await this.outbox.findOneBy({ voucherId });
    return outbox?.status === DelayedSettlementOutboxStatus.CONFIRMED;
  }

  /** 仅用于退款路由判断：订单实际存在延迟交易快照，避免用当前开关误判历史普通订单。 */
  async hasTransactionForOrder(orderId: string): Promise<boolean> {
    if (!this.enabled()) return false;
    return Boolean(await this.transactions.findOneBy({ orderId }));
  }

  /** 提供确认后退款所需的券级确认快照；不返回其他券或整单的分账信息。 */
  async confirmationContextForVoucher(voucherId: string): Promise<{
    paymentReference: string;
    confirmationRequestSeq: string | null;
    confirmationRequestDate: Date | null;
    acctSplitBunch: Array<{ div_amt: string }>;
  } | null> {
    if (!this.enabled()) return null;
    const outbox = await this.outbox.findOneBy({ voucherId });
    if (!outbox || outbox.status !== DelayedSettlementOutboxStatus.CONFIRMED) return null;
    const transaction = await this.transactions.findOneBy({ id: outbox.transactionId });
    if (!transaction) return null;
    return {
      paymentReference: transaction.providerPaymentReference,
      confirmationRequestSeq: outbox.confirmationRequestSeq || `c${outbox.idempotencyKey.replace(/[^A-Za-z0-9]/g, '').slice(0, 30)}`,
      confirmationRequestDate: outbox.confirmationRequestDate || outbox.createdAt || new Date(),
      acctSplitBunch: outbox.acctSplitBunch,
    };
  }

  /** 兼容旧调用方：订单级状态只表示订单至少有一张券已确认，不能用于逐券退款判定。 */
  async confirmedForOrder(orderId: string): Promise<boolean> {
    if (!this.enabled()) return false;
    return (await this.outbox.count({ where: { orderId, status: DelayedSettlementOutboxStatus.CONFIRMED } })) > 0;
  }
  async createSnapshot(manager: EntityManager, order: Order, paymentReference: string, provider: string): Promise<void> {
    if (!this.enabled() || String(provider || '').toUpperCase() !== 'HUIFU') return;
    const existing = await manager.findOneBy(DelayedSettlementTransaction, { orderId: order.id });
    if (existing) return;
    await manager.save(DelayedSettlementTransaction, {
      orderId: order.id,
      merchantId: order.merchantId,
      provider,
      providerPaymentReference: paymentReference,
      amountFen: order.amountFen,
      snapshotJson: JSON.stringify({ orderId: order.id, orderNo: order.orderNo, merchantId: order.merchantId, amountFen: order.amountFen, provider, providerPaymentReference: paymentReference }),
      status: DelayedSettlementTransactionStatus.PENDING_CONFIRMATION,
      confirmedAt: null,
    });
  }


  async enqueueConfirmation(manager: EntityManager, verification: Verification, voucher: Voucher): Promise<void> {
    if (!this.enabled()) return;
    const transaction = await manager.findOneBy(DelayedSettlementTransaction, { orderId: voucher.orderId });
    if (!transaction) return;
    const split = [{ div_amt: (verification.amountFen / 100).toFixed(2) }];
    const confirmationRequestSeq = `c${verification.id.replace(/[^A-Za-z0-9]/g, '').slice(0, 30)}`;
    const confirmationRequestDate = new Date();
    const existing = await manager.findOneBy(DelayedSettlementConfirmationOutbox, { verificationId: verification.id });
    if (existing) return;
    await manager.save(DelayedSettlementConfirmationOutbox, {
      transactionId: transaction.id,
      verificationId: verification.id,
      orderId: voucher.orderId,
      merchantId: voucher.merchantId,
      voucherId: voucher.id,
      amountFen: verification.amountFen,
      acctSplitBunch: split,
      idempotencyKey: `delay-confirm-${verification.id}`,
      status: DelayedSettlementOutboxStatus.PENDING,
      attemptCount: 0,
      lastAttemptAt: null,
      nextAttemptAt: new Date(),
      providerReference: null,
      confirmationRequestSeq,
      confirmationRequestDate,
      lastError: '',
    });
  }

  async processConfirmations(limit = BATCH_SIZE): Promise<{ confirmed: number; retried: number; queried: number }> {
    if (!this.enabled() || !this.provider.enabled) return { confirmed: 0, retried: 0, queried: 0 };
    const now = new Date();
    const staleBefore = new Date(now.getTime() - PROCESSING_STALE_MS);
    const candidates = await this.dataSource.transaction(async (manager) => {
      const rows = await manager.createQueryBuilder(DelayedSettlementConfirmationOutbox, 'outbox')
        .setLock('pessimistic_write')
        .where('(outbox.status IN (:...ready) AND outbox.nextAttemptAt <= :now) OR (outbox.status = :processing AND outbox.lastAttemptAt < :staleBefore)', {
          ready: [DelayedSettlementOutboxStatus.PENDING, DelayedSettlementOutboxStatus.RETRY], processing: DelayedSettlementOutboxStatus.PROCESSING, now, staleBefore,
        }).orderBy('outbox.createdAt', 'ASC').addOrderBy('outbox.id', 'ASC').take(Math.max(1, Math.min(limit, BATCH_SIZE))).getMany();
      for (const row of rows) {
        row.status = DelayedSettlementOutboxStatus.PROCESSING;
        row.attemptCount += 1;
        row.lastAttemptAt = now;
        await manager.save(DelayedSettlementConfirmationOutbox, row);
      }
      return rows;
    });
    let confirmed = 0;
    let retried = 0;
    let queried = 0;
    for (const row of candidates) {
      const result = await this.processOne(row);
      if (result === 'CONFIRMED') confirmed += 1;
      if (result === 'RETRY') retried += 1;
      if (result === 'QUERIED') queried += 1;
    }
    return { confirmed, retried, queried };
  }

  async markRefundedForVoucher(voucherId: string, providerReference: string): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const outbox = await manager.findOneBy(DelayedSettlementConfirmationOutbox, { voucherId });
      if (outbox && outbox.status !== DelayedSettlementOutboxStatus.REFUNDED) {
        outbox.status = DelayedSettlementOutboxStatus.REFUNDED;
        outbox.providerReference = providerReference;
        await manager.save(DelayedSettlementConfirmationOutbox, outbox);
      }
      if (outbox) {
        const transaction = await manager.findOneBy(DelayedSettlementTransaction, { id: outbox.transactionId });
        if (transaction) {
          transaction.status = DelayedSettlementTransactionStatus.REFUNDED;
          await manager.save(DelayedSettlementTransaction, transaction);
        }
      }
    });
  }
  private async processOne(row: DelayedSettlementConfirmationOutbox): Promise<'CONFIRMED' | 'RETRY' | 'QUERIED'> {
    const transaction = await this.transactions.findOneBy({ id: row.transactionId });
    const order = await this.orders.findOneBy({ id: row.orderId });
    const route = order ? await this.paymentOutbox.findOneBy({ orderId: order.id }) : null;
    if (!transaction || !order || !route) return this.retry(row, '延迟交易路由快照缺失');
    const request: SettlementConfirmationRequest = {
      orderId: order.id, orderNo: order.orderNo, merchantId: order.merchantId, amountFen: row.amountFen,
      paymentReference: transaction.providerPaymentReference, idempotencyKey: row.idempotencyKey,
      acctSplitBunch: row.acctSplitBunch, paymentProfileId: route.paymentProfileId, providerMerchantId: route.providerMerchantId,
      provider: route.provider, orderCreatedAt: order.createdAt,
      confirmationRequestSeq: row.confirmationRequestSeq,
      confirmationRequestDate: row.confirmationRequestDate,
    };
    if (row.attemptCount > 1) {
      const queried = await this.provider.queryPaymentConfirmation(request).catch(() => null);
      if (queried?.status === 'SUCCEEDED') { await this.finalizeConfirmation(row.id, queried.providerReference || row.providerReference || transaction.providerPaymentReference); return 'CONFIRMED'; }
      if (queried?.status === 'PROCESSING') return this.retry(row, '汇付确认处理中，已查单，等待下次补偿');
      if (queried) return this.retry(row, '汇付确认查单未成功，等待再次确认');
    }
    try {
      const result = await this.provider.confirmPayment(request);
      await this.finalizeConfirmation(row.id, result.providerReference);
      return 'CONFIRMED';
    } catch {
      const queried = await this.provider.queryPaymentConfirmation(request).catch(() => null);
      if (queried?.status === 'SUCCEEDED') { await this.finalizeConfirmation(row.id, queried.providerReference || transaction.providerPaymentReference); return 'CONFIRMED'; }
      return this.retry(row, queried?.status === 'PROCESSING' ? '确认请求处理中，已查单' : '确认请求失败，已先查单后等待重试');
    }
  }


  private async finalizeConfirmation(outboxId: string, providerReference: string): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const outbox = await manager.findOne(DelayedSettlementConfirmationOutbox, { where: { id: outboxId }, lock: { mode: 'pessimistic_write' } });
      if (!outbox || outbox.status === DelayedSettlementOutboxStatus.CONFIRMED) return;
      const verification = await manager.findOneByOrFail(Verification, { id: outbox.verificationId });
      const voucher = await manager.findOneByOrFail(Voucher, { id: outbox.voucherId });
      await manager.save(SettlementLedgerEntry, {
        merchantId: voucher.merchantId, voucherId: voucher.id, verificationId: verification.id,
        verifiedAmountFen: outbox.amountFen, serviceFeeFen: calculateServiceFeeFen(outbox.amountFen, voucher.commissionRateSnapshot),
        rateSnapshot: voucher.commissionRateSnapshot, entryType: 'CONFIRMED',
      });
      outbox.status = DelayedSettlementOutboxStatus.CONFIRMED;
      outbox.providerReference = providerReference;
      outbox.lastError = '';
      await manager.save(DelayedSettlementConfirmationOutbox, outbox);
      const transaction = await manager.findOneBy(DelayedSettlementTransaction, { id: outbox.transactionId });
      if (transaction) {
        const remaining = typeof manager.count === 'function'
          ? await manager.count(DelayedSettlementConfirmationOutbox, {
            where: [
              { transactionId: transaction.id, status: DelayedSettlementOutboxStatus.PENDING },
              { transactionId: transaction.id, status: DelayedSettlementOutboxStatus.PROCESSING },
              { transactionId: transaction.id, status: DelayedSettlementOutboxStatus.RETRY },
            ],
          })
          : 0;
        transaction.status = remaining === 0
          ? DelayedSettlementTransactionStatus.CONFIRMED
          : DelayedSettlementTransactionStatus.PENDING_CONFIRMATION;
        if (remaining === 0) transaction.confirmedAt = new Date();
        await manager.save(DelayedSettlementTransaction, transaction);
      }
    });
  }

  private async retry(row: DelayedSettlementConfirmationOutbox, message: string): Promise<'RETRY'> {
    await this.outbox.update(row.id, { status: DelayedSettlementOutboxStatus.RETRY, nextAttemptAt: new Date(Date.now() + Math.min(15 * 60_000, 30_000 * 2 ** Math.min(row.attemptCount, 5))), lastError: message });
    return 'RETRY';
  }
}
