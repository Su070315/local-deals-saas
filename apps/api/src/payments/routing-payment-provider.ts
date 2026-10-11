import { Injectable, NotFoundException } from '@nestjs/common';
import type { NormalizedPaymentEvent, PaymentIntent, PaymentProvider, PaymentWebhookInput, RefundRequest, SettlementConfirmationRequest } from './payment-provider';
import { HuifuPaymentProvider } from './huifu-payment-provider';
import { TianquePaymentProvider } from './tianque-payment-provider';
import { WechatDirectPaymentProvider } from './wechat-direct-payment-provider';

/**
 * 支付渠道路由层：按商家的支付档案（merchant_payment_profiles）在微信直连 / 汇付 / 天阙之间分发。
 *
 * - 下单（paymentRoute）：无档案默认微信直连（全局商户号）；有档案按档案 provider 走。
 * - 支付执行（dispatch）：**优先使用订单持久化的 provider 字段路由**（S-03 修复），
 *   不再仅靠 providerMerchantId 与全局值匹配"猜渠道"；无 provider 字段时才回退按商户号匹配。
 * - 回调：按 webhook URL 中的渠道名分发，事件携带真实底层 provider（H-02）。
 */
@Injectable()
export class RoutingPaymentProvider implements PaymentProvider {
  readonly providerName = 'routing';
  readonly enabled: boolean;
  /** 路由层本身不依赖商户档案；具体渠道由底层 provider 决定 */
  readonly requiresMerchantProfile = false;

  constructor(
    readonly tianque: TianquePaymentProvider,
    readonly wechat: WechatDirectPaymentProvider,
    readonly huifu: HuifuPaymentProvider,
  ) {
    this.enabled = this.wechat.enabled || this.tianque.enabled || this.huifu.enabled;
  }

  /** 默认渠道：微信直连（无档案商家的兜底）。 */
  providerForMerchant(_merchantId: string): PaymentProvider {
    return this.wechat;
  }

  /**
   * 按持久化的 provider 名路由（HUIFU / TIANQUE / WECHAT_DIRECT）。
   * 未知渠道失败关闭，不做猜测。
   */
  providerForName(provider: string | null | undefined): PaymentProvider {
    const name = String(provider || '').toUpperCase();
    if (name.includes('HUIFU')) return this.huifu;
    if (name.includes('TIANQUE')) return this.tianque;
    if (name === 'WECHAT_DIRECT' || name === 'WECHAT' || name === 'WECHAT_DIRECT') return this.wechat;
    throw new NotFoundException('未知支付渠道，无法路由');
  }

  /** 回退匹配（旧数据无 provider 字段时）：按 providerMerchantId 与全局值匹配；天阙商家级 mno 无法匹配时按引用落入汇付。 */
  providerForReference(providerMerchantId: string | null | undefined): PaymentProvider {
    if (providerMerchantId && this.tianque.fallbackMno && providerMerchantId === this.tianque.fallbackMno) return this.tianque;
    if (providerMerchantId && providerMerchantId === this.wechat.defaultMchid) return this.wechat;
    return this.huifu;
  }

  /** 解析执行渠道：优先 provider 字段，其次 providerMerchantId 回退。 */
  private resolveProvider(provider: string | null | undefined, providerMerchantId: string | null | undefined): PaymentProvider {
    if (provider) return this.providerForName(provider);
    return providerMerchantId ? this.providerForReference(providerMerchantId) : this.providerForMerchant('');
  }

  async createPayment(intent: PaymentIntent) {
    return this.resolveProvider(intent.provider, intent.providerMerchantId).createPayment(intent);
  }

  async queryPayment(input: Pick<PaymentIntent, 'orderId' | 'orderNo' | 'merchantId' | 'amountFen' | 'paymentProfileId' | 'providerMerchantId' | 'provider' | 'orderCreatedAt'> & { paymentReference: string | null }) {
    const provider = this.resolveProvider(input.provider, input.providerMerchantId);
    const event = await provider.queryPayment(input);
    // M6：查单事件也携带真实底层 provider，保证 assertEventRoute 渠道校验对查单事件同样生效
    return event ? { ...event, provider: provider.providerName } : null;
  }

  /** 退款按订单记录的 provider 路由（优先持久化 provider 名，避免按商户号猜）。 */
  async refund(request: RefundRequest) {
    return this.resolveProvider(request.provider, request.providerMerchantId).refund(request);
  }

  /** 退款查单：按订单记录的 provider 路由；渠道不支持时返回 null（调用方退化为重提）。 */
  async queryRefund(request: RefundRequest) {
    const provider = this.resolveProvider(request.provider, request.providerMerchantId);
    return provider.queryRefund ? provider.queryRefund(request) : null;
  }

  async confirmPayment(request: SettlementConfirmationRequest) { return this.resolveProvider(request.provider, request.providerMerchantId).confirmPayment(request); }
  async queryPaymentConfirmation(request: SettlementConfirmationRequest) { return this.resolveProvider(request.provider, request.providerMerchantId).queryPaymentConfirmation(request); }
  async confirmRefund(request: RefundRequest) { return this.resolveProvider(request.provider, request.providerMerchantId).confirmRefund(request); }
  async queryConfirmRefund(request: RefundRequest) { return this.resolveProvider(request.provider, request.providerMerchantId).queryConfirmRefund(request); }
  async parseWebhook(): Promise<NormalizedPaymentEvent> {
    throw new NotFoundException('请使用渠道专属回调地址');
  }

  /** 按 webhook URL 中的 provider 参数分发到对应渠道的验签解析，并携带真实底层渠道名（H-02）。 */
  async parseWebhookFor(providerName: string, input: PaymentWebhookInput, providerParam?: string): Promise<NormalizedPaymentEvent> {
    if (providerName === this.wechat.providerName) return { ...await this.wechat.parseWebhook(input, providerParam), provider: this.wechat.providerName };
    if (providerName === this.tianque.providerName) return { ...await this.tianque.parseWebhook(input), provider: this.tianque.providerName };
    if (providerName === this.huifu.providerName) return { ...await this.huifu.parseWebhook(input), provider: this.huifu.providerName };
    throw new NotFoundException('未知支付渠道');
  }

  async submitSettlement(input: { billId: string; amountFen: number }) {
    return this.huifu.submitSettlement(input);
  }
}
