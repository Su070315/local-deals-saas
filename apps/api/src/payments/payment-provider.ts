import { Injectable } from '@nestjs/common';

import { PaymentEventType } from '../domain/entities';

export type PaymentIntent = {
  orderId: string;
  orderNo: string;
  merchantId: string;
  amountFen: number;
  expiresAt: Date;
  idempotencyKey: string;
  paymentProfileId?: string | null;
  providerMerchantId?: string | null;
  /** 订单在路由层确定的真实渠道（HUIFU / TIANQUE / WECHAT_DIRECT），执行阶段强制使用，禁止按商户号猜测 */
  provider?: string | null;
  /** JSAPI 支付需把付款顾客在该商户小程序下的 openid 传给支付渠道 */
  customerOpenid?: string | null;
  /** 订单创建时间（渠道查单/退款需定位原交易日期 org_req_date，由路由层传入） */
  orderCreatedAt?: Date | null;
};
export type NormalizedPaymentEvent = {
  providerEventId: string;
  eventType: PaymentEventType;
  orderNo: string;
  merchantId?: string;
  providerMerchantId?: string | null;
  /** 产生该事件的真实底层渠道（HUIFU / TIANQUE / WECHAT_DIRECT），用于路由核对 */
  provider?: string | null;
  amountFen: number;
  providerPaymentReference: string;
  occurredAt: Date;
  /** 汇付微信小程序资金管控事实；仅用于 FREEZE/UNFREEZE 通知，不触发支付入账。 */
  fundControl?: {
    status: 'FREEZE' | 'UNFREEZE';
    frozenAt?: Date | null;
    unfrozenAt?: Date | null;
    unfrozenAmountFen?: number | null;
  };
  /** 汇付确认通知使用 resp_data；仅作为延迟结算事实，不触发普通订单入账。 */
  delayedSettlement?: {
    status: 'SUCCEEDED' | 'PROCESSING' | 'FAILED';
    providerReference?: string | null;
    idempotencyKey?: string | null;
  };
};
export type SettlementConfirmationRequest = {
  orderId: string;
  orderNo: string;
  merchantId: string;
  amountFen: number;
  paymentReference: string;
  idempotencyKey: string;
  acctSplitBunch: Array<{ div_amt: string }>;
  paymentProfileId?: string | null;
  providerMerchantId?: string | null;
  provider?: string | null;
  orderCreatedAt?: Date | null;
  /** 首次确认请求的稳定请求号/日期；重试和确认后退款查询必须复用。 */
  confirmationRequestSeq?: string | null;
  confirmationRequestDate?: Date | null;
};
export type SettlementConfirmationResult = { status: 'SUCCEEDED' | 'PROCESSING' | 'FAILED'; providerReference?: string | null };

export type RefundRequest = {
  voucherId: string;
  amountFen: number;
  orderId: string;
  orderNo: string;
  idempotencyKey: string;
  paymentProfileId?: string | null;
  providerMerchantId?: string | null;
  provider?: string | null;
  /** 原订单创建时间（退款提交/查单定位原交易需 org_req_date，由退款服务传入） */
  orderCreatedAt?: Date | null;
  /** 已确认延迟交易的原支付流水；用于审计与渠道对账。 */
  delayedSettlementReference?: string | null;
  /** 原交易确认请求号；confirmrefund 的 org_req_seq_id 必须引用它。 */
  confirmationRequestSeq?: string | null;
  /** 原交易确认请求日期；confirmrefund 的 org_req_date 必须引用它。 */
  confirmationRequestDate?: Date | null;
  /** 确认退款本次对应的已确认分账明细。 */
  acctSplitBunch?: Array<{ div_amt: string }>;
  /** 当前确认退款请求号；同一退款重试必须保持不变。 */
  confirmRefundRequestSeq?: string | null;
  /** 当前确认退款请求日期；confirmrefundquery 必须使用同一日期。 */
  confirmRefundRequestDate?: Date | null;
  /** 汇付返回的确认退款全局流水号；仅用于查询和对账，不替代原请求号。 */
  confirmRefundProviderReference?: string | null;
};

export type RefundOperationResult = {
  status: 'SUCCEEDED' | 'FAILED' | 'PROCESSING';
  paymentReference?: string | null;
};
export type RefundQueryResult = { status: 'SUCCEEDED' | 'FAILED' | 'PROCESSING'; providerPaymentReference?: string | null };
export type PaymentWebhookInput = { rawBody: Buffer; headers: Readonly<Record<string, string | undefined>> };

export interface PaymentProvider {
  readonly providerName: string;
  readonly enabled: boolean;
  readonly requiresMerchantProfile: boolean;
  createPayment(intent: PaymentIntent): Promise<{ paymentReference: string; expiresAt: Date; payInfo?: string }>;
  parseWebhook(input: PaymentWebhookInput): Promise<NormalizedPaymentEvent>;
  queryPayment(input: Pick<PaymentIntent, 'orderId' | 'orderNo' | 'merchantId' | 'amountFen' | 'paymentProfileId' | 'providerMerchantId' | 'orderCreatedAt'> & { paymentReference: string | null }): Promise<NormalizedPaymentEvent | null>;
  refund(request: RefundRequest): Promise<{ paymentReference: string }>;
  /** 主动查询退款结果（渠道已受理但回调丢失时用于对账）；不支持查询时返回 null */
  queryRefund?(request: RefundRequest): Promise<RefundQueryResult | null>;
  confirmPayment(request: SettlementConfirmationRequest): Promise<{ providerReference: string }>;
  queryPaymentConfirmation(request: SettlementConfirmationRequest): Promise<SettlementConfirmationResult | null>;
  confirmRefund(request: RefundRequest): Promise<RefundOperationResult>;
  queryConfirmRefund(request: RefundRequest): Promise<RefundQueryResult | null>;
  submitSettlement(input: { billId: string; amountFen: number }): Promise<{ reference: string }>;
}

/** Deliberately separate from PaymentProvider so no real adapter can expose a customer-controlled success path. */
export interface DemoPaymentProvider extends PaymentProvider {
  createDemoPaymentEvent(intent: PaymentIntent): Promise<NormalizedPaymentEvent>;
}

export function isDemoPaymentProvider(provider: PaymentProvider): provider is DemoPaymentProvider {
  return typeof (provider as Partial<DemoPaymentProvider>).createDemoPaymentEvent === 'function';
}

@Injectable()
export class MockPaymentProvider implements DemoPaymentProvider {
  readonly providerName = 'mock';
  readonly enabled = true;
  readonly requiresMerchantProfile = false;
  private refundFailure: Error | null = null;
  private readonly demoEvents = new Map<string, NormalizedPaymentEvent>();

  failNextRefund(message = '模拟退款通道暂不可用') {
    this.refundFailure = new Error(message);
  }

  async createPayment(intent: PaymentIntent) {
    return { paymentReference: `mock_intent_${intent.orderId.slice(0, 8)}`, expiresAt: intent.expiresAt };
  }

  async createDemoPaymentEvent(intent: PaymentIntent): Promise<NormalizedPaymentEvent> {
    const suffix = intent.idempotencyKey.replace(/[^A-Za-z0-9]/g, '').slice(-12) || intent.orderId.replace(/-/g, '').slice(-12);
    const providerEventId = `mock_event_${intent.orderId.slice(0, 8)}_${suffix}`;
    const existing = this.demoEvents.get(providerEventId);
    if (existing) return existing;
    // Derive the mock provider timestamp from persisted order data. A fresh
    // MockPaymentProvider exists in every API replica, so Date.now() would make
    // the same provider event ID carry different content across processes and
    // incorrectly turn a safe payment replay into a 409 conflict.
    const occurredAt = new Date(intent.expiresAt.getTime() - 15 * 60_000);
    const event: NormalizedPaymentEvent = {
      providerEventId,
      eventType: PaymentEventType.PAYMENT_SUCCEEDED,
      orderNo: intent.orderNo,
      merchantId: intent.merchantId,
      amountFen: intent.amountFen,
      providerPaymentReference: `mock_pay_${intent.orderId.slice(0, 8)}_${suffix}`,
      occurredAt,
    };
    this.demoEvents.set(providerEventId, event);
    return event;
  }

  async parseWebhook(_input: PaymentWebhookInput): Promise<NormalizedPaymentEvent> {
    throw new Error('模拟支付不接收外部回调');
  }

  async queryPayment(_input: Pick<PaymentIntent, 'orderId' | 'orderNo' | 'merchantId' | 'amountFen' | 'paymentProfileId' | 'providerMerchantId' | 'orderCreatedAt'> & { paymentReference: string | null }): Promise<NormalizedPaymentEvent | null> {
    return null;
  }

  async refund(request: RefundRequest) {
    const failure = this.refundFailure;
    this.refundFailure = null;
    if (failure) throw failure;
    return { paymentReference: `mock_refund_${request.voucherId.slice(0, 8)}_${request.idempotencyKey.replace(/-/g, '').slice(-8)}` };
  }

  async queryRefund(_request: RefundRequest): Promise<RefundQueryResult | null> {
    return null;
  }

  async submitSettlement(input: { billId: string; amountFen: number }) {
    return { reference: `mock_settlement_${input.billId.slice(0, 8)}` };
  }

  async confirmPayment(_request: SettlementConfirmationRequest): Promise<{ providerReference: string }> { return { providerReference: 'mock-confirmation' }; }
  async queryPaymentConfirmation(_request: SettlementConfirmationRequest): Promise<SettlementConfirmationResult | null> { return null; }
  async confirmRefund(request: RefundRequest): Promise<RefundOperationResult> {
    const result = await this.refund(request);
    return { status: 'SUCCEEDED', paymentReference: result.paymentReference };
  }
  async queryConfirmRefund(request: RefundRequest): Promise<RefundQueryResult | null> { return this.queryRefund(request); }
}

/**
 * Shared environments may run administrative workflows before a payment
 * contract is signed. This provider keeps those deployments fail-closed: no
 * payment intent, refund or webhook can be accidentally treated as real.
 */
@Injectable()
export class UnavailablePaymentProvider implements PaymentProvider {
  readonly providerName = 'unconfigured';
  readonly enabled = false;
  readonly requiresMerchantProfile = false;

  private unavailable(): never { throw new Error('支付通道尚未签约并启用'); }

  async createPayment(_intent: PaymentIntent): Promise<{ paymentReference: string; expiresAt: Date }> { return this.unavailable(); }
  async parseWebhook(_input: PaymentWebhookInput): Promise<NormalizedPaymentEvent> { return this.unavailable(); }
  async queryPayment(_input: Pick<PaymentIntent, 'orderId' | 'orderNo' | 'merchantId' | 'amountFen' | 'paymentProfileId' | 'providerMerchantId' | 'orderCreatedAt'> & { paymentReference: string | null }): Promise<NormalizedPaymentEvent | null> { return this.unavailable(); }
  async refund(_request: RefundRequest): Promise<{ paymentReference: string }> { return this.unavailable(); }
  async submitSettlement(_input: { billId: string; amountFen: number }): Promise<{ reference: string }> { return this.unavailable(); }
  async confirmPayment(_request: SettlementConfirmationRequest): Promise<{ providerReference: string }> { return this.unavailable(); }
  async queryPaymentConfirmation(_request: SettlementConfirmationRequest): Promise<SettlementConfirmationResult | null> { return null; }
  async confirmRefund(_request: RefundRequest): Promise<RefundOperationResult> { return this.unavailable(); }
  async queryConfirmRefund(_request: RefundRequest): Promise<RefundQueryResult | null> { return null; }
}

export const PAYMENT_PROVIDER = Symbol('PAYMENT_PROVIDER');
