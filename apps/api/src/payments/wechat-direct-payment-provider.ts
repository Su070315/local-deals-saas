import { BadGatewayException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { createDecipheriv, createSign, createVerify, randomBytes } from 'crypto';
import { readFileSync } from 'fs';
import { Repository } from 'typeorm';
import { MerchantPaymentProfile, Order } from '../domain/entities';
import { PaymentEventType } from '../domain/entities';
import { SensitiveDataService } from '../sensitive-data.service';
import type { NormalizedPaymentEvent, PaymentIntent, PaymentProvider, PaymentWebhookInput, RefundQueryResult, RefundRequest } from './payment-provider';

const API_BASE = 'https://api.mch.weixin.qq.com';

type WechatDirectCredential = {
  mchid: string;
  appId: string;
  apiV3Key: string;
  certSerialNo: string;
  privateKey: string;
  publicKey: string;
  notifyUrl: string;
  fromDb: boolean;
};

/**
 * 微信支付 APIv3 直连商户适配器（JSAPI/小程序支付）。
 *
 * - 统一下单：POST /v3/pay/transactions/jsapi → prepay_id → 组装小程序调起参数（payInfo JSON）
 * - 回调：验签（微信支付公钥）+ AES-256-GCM 解密（APIv3 密钥）
 * - 退款：POST /v3/refund/domestic/refunds
 * - 查询：GET /v3/pay/transactions/out-trade-no/{out_trade_no}
 *
 * 【多租户凭据（v2）】
 * - 优先按商户档案（providerMerchantId=mchid）解析该商户自己的 mchid / appid /
 *   APIv3Key(加密) / 证书序列号 / 私钥(加密) / 微信公钥；查不到回退全局 env（单商户兼容）。
 * - 回调通知 URL 按商户为 webhooks/wechat-direct/:mchid，按商户验签解密。
 *
 * 环境变量（兜底）：
 * - WECHATPAY_MCHID / WECHATPAY_APP_ID / WECHATPAY_API_V3_KEY / WECHATPAY_CERT_SERIAL_NO
 * - WECHATPAY_PRIVATE_KEY_PATH / WECHATPAY_PUBLIC_KEY_PATH / WECHATPAY_NOTIFY_URL
 */
@Injectable()
export class WechatDirectPaymentProvider implements PaymentProvider {
  readonly providerName = 'wechat_direct';
  readonly enabled = true;
  /** 兼容无档案商户（全局兜底）；有档案则按商户凭据 */
  readonly requiresMerchantProfile = false;

  // 全局 env 仅作兜底（单商户兼容）
  private readonly fallbackMchid: string;
  private readonly fallbackAppId: string;
  private readonly fallbackApiV3Key: string;
  private readonly fallbackCertSerialNo: string;
  private readonly fallbackPrivateKey: string;
  private readonly fallbackPublicKey: string;
  private readonly fallbackNotifyUrl: string;

  /** 全局兜底商户号（供路由层按引用回退匹配微信直连渠道，见 routing-payment-provider.providerForReference） */
  get defaultMchid(): string {
    return this.fallbackMchid;
  }

  constructor(
    @InjectRepository(Order) private readonly orders: Repository<Order>,
    @InjectRepository(MerchantPaymentProfile) private readonly profiles: Repository<MerchantPaymentProfile>,
    private readonly sensitiveData: SensitiveDataService,
  ) {
    this.fallbackMchid = (process.env.WECHATPAY_MCHID || '').trim();
    this.fallbackAppId = (process.env.WECHATPAY_APP_ID || '').trim();
    this.fallbackApiV3Key = (process.env.WECHATPAY_API_V3_KEY || '').trim();
    this.fallbackCertSerialNo = (process.env.WECHATPAY_CERT_SERIAL_NO || '').trim();
    this.fallbackPrivateKey = this.readKeyFile('WECHATPAY_PRIVATE_KEY_PATH', 'PRIVATE KEY');
    this.fallbackPublicKey = this.readKeyFile('WECHATPAY_PUBLIC_KEY_PATH', 'PUBLIC KEY');
    this.fallbackNotifyUrl = (process.env.WECHATPAY_NOTIFY_URL || `${process.env.PUBLIC_BASE_URL || ''}/api/payments/webhooks/wechat-direct`).replace(/\/$/, '');
  }

  /** 按 mchid 解析微信直连凭据：商户档案优先，全局 env 兜底。 */
  async resolveWechatCredential(mchid: string): Promise<WechatDirectCredential> {
    const key = String(mchid || '').trim();
    try {
      const profile = await this.profiles.findOne({ where: { provider: 'WECHAT_DIRECT', wechatMchid: key } });
      if (profile && profile.wechatMchid && profile.wechatPrivateKeyEnc && profile.wechatApiV3KeyEnc) {
        return {
          mchid: profile.wechatMchid,
          appId: profile.wechatAppId || this.fallbackAppId,
          apiV3Key: this.sensitiveData.decrypt(profile.wechatApiV3KeyEnc),
          certSerialNo: profile.wechatCertSerialNo || this.fallbackCertSerialNo,
          privateKey: this.sensitiveData.decrypt(profile.wechatPrivateKeyEnc),
          publicKey: profile.wechatPublicKey || this.fallbackPublicKey,
          notifyUrl: `${String(process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '')}/api/payments/webhooks/wechat-direct/${profile.wechatMchid}`,
          fromDb: true,
        };
      }
    } catch { /* 回退 env */ }
    return {
      mchid: this.fallbackMchid,
      appId: this.fallbackAppId,
      apiV3Key: this.fallbackApiV3Key,
      certSerialNo: this.fallbackCertSerialNo,
      privateKey: this.fallbackPrivateKey,
      publicKey: this.fallbackPublicKey,
      notifyUrl: this.fallbackNotifyUrl,
      fromDb: false,
    };
  }

  // ==========================================================================
  // PaymentProvider 接口实现
  // ==========================================================================

  /** 统一下单（JSAPI 小程序支付）。返回 prepay_id 与前端调起支付参数串。 */
  async createPayment(intent: PaymentIntent): Promise<{ paymentReference: string; expiresAt: Date; payInfo?: string }> {
    const openid = String(intent.customerOpenid || '').trim();
    if (!openid) throw new ServiceUnavailableException('付款顾客尚未授权登录，无法发起微信支付');
    // 多租户：按订单渠道商户号（mchid）解析该商户凭据；无档案回退全局
    const credential = await this.resolveWechatCredential(intent.providerMerchantId || '');
    const body = {
      appid: credential.appId,
      mchid: credential.mchid,
      description: '团购套餐',
      out_trade_no: intent.orderNo,
      notify_url: credential.notifyUrl,
      amount: { total: intent.amountFen, currency: 'CNY' },
      payer: { openid },
      attach: JSON.stringify({ merchantId: intent.merchantId, orderId: intent.orderId }).slice(0, 128),
    };
    const result = await this.apiRequest('POST', '/v3/pay/transactions/jsapi', body, credential);
    const prepayId = String(result.prepay_id || '');
    if (!prepayId || prepayId.length > 128) throw new BadGatewayException('微信支付未返回有效的预支付单号');
    return { paymentReference: prepayId, expiresAt: intent.expiresAt, payInfo: this.buildPayInfo(prepayId, credential) };
  }

  /** 解析微信支付异步回调：验签 + 解密。providerParam 为回调 URL 中的 mchid（多租户定位商户凭据）。 */
  async parseWebhook(input: PaymentWebhookInput, mchidParam?: string): Promise<NormalizedPaymentEvent> {
    const body = input.rawBody.toString('utf8');
    const timestamp = input.headers['wechatpay-timestamp'];
    const nonce = input.headers['wechatpay-nonce'];
    const signature = input.headers['wechatpay-signature'];
    if (!timestamp || !nonce || !signature) throw new BadGatewayException('微信支付回调缺少验签头');
    // 多租户：按回调 URL 中的 mchid 定位商户凭据；缺失时回退全局（单商户兼容）
    const credential = await this.resolveWechatCredential(mchidParam || '');
    // 微信支付公钥验签：message = timestamp\nnonce\nbody\n
    this.verifySignature(`${timestamp}\n${nonce}\n${body}\n`, signature, credential.publicKey);

    let resource: { ciphertext: string; nonce: string; associated_data?: string } | null = null;
    try {
      const parsed = JSON.parse(body) as { resource?: unknown };
      if (parsed.resource && typeof parsed.resource === 'object') {
        const r = parsed.resource as Record<string, unknown>;
        if (typeof r.ciphertext === 'string' && typeof r.nonce === 'string') {
          resource = { ciphertext: r.ciphertext, nonce: r.nonce, associated_data: typeof r.associated_data === 'string' ? r.associated_data : undefined };
        }
      }
    } catch { throw new BadGatewayException('微信支付回调不是有效 JSON'); }
    if (!resource) throw new BadGatewayException('微信支付回调缺少加密报文');
    let data: Record<string, unknown>;
    try { data = JSON.parse(this.decryptResource(resource, credential.apiV3Key)) as Record<string, unknown>; } catch { throw new BadGatewayException('微信支付回调报文解密失败'); }

    const orderNo = String(data.out_trade_no || '').trim();
    const transactionId = String(data.transaction_id || '').trim();
    if (!orderNo || !transactionId) throw new BadGatewayException('微信支付回调缺少订单号或流水号');
    const tradeState = String(data.trade_state || '');
    const eventType = tradeState === 'SUCCESS' ? PaymentEventType.PAYMENT_SUCCEEDED
      : tradeState === 'CLOSED' ? PaymentEventType.PAYMENT_CLOSED
        : PaymentEventType.PAYMENT_FAILED;
    const amountFen = Number((data.amount as { total?: unknown } | undefined)?.total || 0);
    let merchantId: string | undefined;
    try {
      const attach = String(data.attach || '');
      const parsed = JSON.parse(attach) as { merchantId?: unknown };
      merchantId = typeof parsed.merchantId === 'string' ? parsed.merchantId : undefined;
    } catch { /* attach 非 JSON 时忽略 */ }

    return {
      providerEventId: transactionId,
      eventType,
      orderNo,
      merchantId,
      providerMerchantId: String(data.mchid || credential.mchid || ''),
      amountFen,
      providerPaymentReference: transactionId,
      occurredAt: data.success_time ? new Date(String(data.success_time)) : new Date(),
    };
  }

  /** 主动查询支付结果。 */
  async queryPayment(input: Pick<PaymentIntent, 'orderId' | 'orderNo' | 'merchantId' | 'amountFen' | 'paymentProfileId' | 'providerMerchantId' | 'orderCreatedAt'> & { paymentReference: string | null }): Promise<NormalizedPaymentEvent | null> {
    const credential = await this.resolveWechatCredential(input.providerMerchantId || '');
    const encoded = encodeURIComponent(input.orderNo);
    const result = await this.apiRequest('GET', `/v3/pay/transactions/out-trade-no/${encoded}?mchid=${credential.mchid}`, undefined, credential);
    const tradeState = String(result.trade_state || '');
    if (tradeState === 'NOTPAY' || tradeState === 'USERPAYING') return null; // 未支付/支付中
    const transactionId = String(result.transaction_id || '');
    const eventType = tradeState === 'SUCCESS' ? PaymentEventType.PAYMENT_SUCCEEDED
      : tradeState === 'CLOSED' ? PaymentEventType.PAYMENT_CLOSED
        : PaymentEventType.PAYMENT_FAILED;
    return {
      providerEventId: transactionId || input.orderNo,
      eventType,
      orderNo: input.orderNo,
      merchantId: input.merchantId,
      providerMerchantId: credential.mchid,
      amountFen: Number((result.amount as { total?: unknown } | undefined)?.total || 0),
      providerPaymentReference: transactionId || input.orderNo,
      occurredAt: result.success_time ? new Date(String(result.success_time)) : new Date(),
    };
  }

  /** 退款（需查原订单号与订单总金额）。 */
  async refund(request: RefundRequest): Promise<{ paymentReference: string }> {
    const order = await this.orders.findOneBy({ id: request.orderId });
    if (!order || !order.orderNo || !order.amountFen) throw new ServiceUnavailableException('微信支付退款无法定位原订单');
    if (request.amountFen > order.amountFen) throw new BadGatewayException('退款金额不能超过订单金额');
    const credential = await this.resolveWechatCredential(request.providerMerchantId || '');
    const outRefundNo = `${request.voucherId.slice(0, 20)}_${request.idempotencyKey.replace(/[^A-Za-z0-9]/g, '').slice(-16)}`;
    const body = {
      out_trade_no: order.orderNo,
      out_refund_no: outRefundNo.slice(0, 64),
      reason: '团购退款',
      amount: { refund: request.amountFen, total: order.amountFen, currency: 'CNY' },
      notify_url: credential.notifyUrl,
    };
    const result = await this.apiRequest('POST', '/v3/refund/domestic/refunds', body, credential);
    const refundId = String(result.refund_id || '');
    if (!refundId) throw new BadGatewayException('微信支付未返回退款单号');
    // 微信退款创建响应为异步受理：PROCESSING/缺失视为受理成功（记录 reference 交查单确认），仅明确失败才抛错
    const status = String(result.status || '');
    if (status && ['ABNORMAL', 'CLOSED'].includes(status)) {
      throw new ServiceUnavailableException(`微信退款已明确失败（status=${status}）`);
    }
    return { paymentReference: refundId };
  }

  async confirmPayment(_request: import('./payment-provider').SettlementConfirmationRequest): Promise<{ providerReference: string }> { throw new ServiceUnavailableException('微信直连不支持汇付延迟交易确认'); }
  async queryPaymentConfirmation(_request: import('./payment-provider').SettlementConfirmationRequest): Promise<import('./payment-provider').SettlementConfirmationResult | null> { return null; }
  async confirmRefund(request: RefundRequest): Promise<import('./payment-provider').RefundOperationResult> {
    const result = await this.refund(request);
    return { status: 'SUCCEEDED', paymentReference: result.paymentReference };
  }
  async queryConfirmRefund(request: RefundRequest): Promise<RefundQueryResult | null> { return this.queryRefund(request); }


  async submitSettlement(input: { billId: string; amountFen: number }): Promise<{ reference: string }> {
    return { reference: `wechat_direct_settlement_${input.billId.slice(0, 8)}` };
  }

  /** 退款查询（微信退款单查询接口）。退款时记录的是 refund_id，但补偿场景只有 out_refund_no 可定位，用商户退款单号查询（直连模式无需 sub_mchid）。 */
  async queryRefund(request: RefundRequest): Promise<RefundQueryResult | null> {
    try {
      const credential = await this.resolveWechatCredential(request.providerMerchantId || '');
      const outRefundNo = `${request.voucherId.slice(0, 20)}_${request.idempotencyKey.replace(/[^A-Za-z0-9]/g, '').slice(-16)}`.slice(0, 64);
      const result = await this.apiRequest('GET', `/v3/refund/domestic/refunds/${encodeURIComponent(outRefundNo)}`, undefined, credential);
      const status = String(result.status || '');
      if (status === 'SUCCESS') return { status: 'SUCCEEDED', providerPaymentReference: String(result.refund_id || '') || null };
      if (status === 'ABNORMAL' || status === 'CLOSED') return { status: 'FAILED' };
      return { status: 'PROCESSING' };
    } catch {
      // 查询失败（含退款单不存在）：返回 null 让调用方退化为重提
      return null;
    }
  }

  // ==========================================================================
  // 内部方法
  // ==========================================================================

  /** 带 APIv3 签名认证的请求。多租户：用该商户凭据签名。 */
  private async apiRequest(method: 'GET' | 'POST', pathWithQuery: string, body?: Record<string, unknown>, credential?: WechatDirectCredential): Promise<Record<string, unknown>> {
    const c = credential || await this.resolveWechatCredential('');
    const bodyStr = body ? JSON.stringify(body) : '';
    const timestamp = String(Math.floor(Date.now() / 1000));
    const nonce = randomBytes(16).toString('hex');
    // APIv3 签名串：method\nurl\n时间戳\n随机串\n请求体\n（url 为路径+查询，不含域名）
    const message = `${method}\n${pathWithQuery}\n${timestamp}\n${nonce}\n${bodyStr}\n`;
    const signature = this.sign(message, c.privateKey);
    const authorization = `WECHATPAY2-SHA256-RSA2048 mchid="${c.mchid}",nonce_str="${nonce}",signature="${signature}",timestamp="${timestamp}",serial_no="${c.certSerialNo}"`;

    let response: Response;
    try {
      response = await fetch(`${API_BASE}${pathWithQuery}`, {
        method,
        headers: { 'Content-Type': 'application/json', Authorization: authorization },
        body: body ? bodyStr : undefined,
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      throw new ServiceUnavailableException('暂时无法连接微信支付网关，请稍后重试');
    }
    const text = await response.text();
    let parsed: Record<string, unknown>;
    try { parsed = text ? JSON.parse(text) as Record<string, unknown> : {}; } catch { throw new BadGatewayException('微信支付网关响应格式异常'); }
    if (!response.ok) {
      const code = String(parsed.code || response.status);
      const detail = String(parsed.message || '未知错误');
      throw new BadGatewayException(`微信支付请求失败（${code}）：${detail}`);
    }
    return parsed;
  }

  /** 组装小程序调起支付参数（wx.requestPayment 所需字段）。 */
  private buildPayInfo(prepayId: string, credential: WechatDirectCredential): string {
    const timeStamp = String(Math.floor(Date.now() / 1000));
    const nonceStr = randomBytes(16).toString('hex');
    const message = `${credential.appId}\n${timeStamp}\n${nonceStr}\nprepay_id=${prepayId}\n`;
    const paySign = this.sign(message, credential.privateKey);
    return JSON.stringify({ appId: credential.appId, timeStamp, nonceStr, package: `prepay_id=${prepayId}`, signType: 'RSA', paySign });
  }

  /** 商户私钥 RSA-SHA256 签名。 */
  private sign(message: string, privateKey?: string): string {
    try {
      const signer = createSign('RSA-SHA256');
      signer.update(message, 'utf8');
      return signer.sign(privateKey || this.fallbackPrivateKey, 'base64');
    } catch {
      throw new ServiceUnavailableException('支付签名服务暂不可用');
    }
  }

  /** 微信支付公钥验签。 */
  private verifySignature(message: string, signature: string, publicKey?: string): void {
    if (!signature || signature.length > 8192) throw new ServiceUnavailableException('微信支付回调签名缺失或过长');
    try {
      const verifier = createVerify('RSA-SHA256');
      verifier.update(message, 'utf8');
      if (!verifier.verify(publicKey || this.fallbackPublicKey, signature, 'base64')) throw new Error('签名不匹配');
    } catch {
      throw new ServiceUnavailableException('微信支付回调验签失败');
    }
  }

  /** AES-256-GCM 解密回调 resource（APIv3 密钥，ciphertext 末尾 16 字节为 authTag）。多租户：用该商户 APIv3Key。 */
  private decryptResource(resource: { ciphertext: string; nonce: string; associated_data?: unknown }, apiV3Key: string): string {
    const key = Buffer.from(apiV3Key, 'utf8');
    if (key.length !== 32) throw new BadGatewayException('APIv3 密钥格式不正确');
    const ciphertext = Buffer.from(resource.ciphertext, 'base64');
    if (ciphertext.length <= 16) throw new BadGatewayException('微信支付回调密文不合法');
    const authTag = ciphertext.subarray(ciphertext.length - 16);
    const data = ciphertext.subarray(0, ciphertext.length - 16);
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(resource.nonce, 'utf8'));
      decipher.setAuthTag(authTag);
      if (resource.associated_data) decipher.setAAD(Buffer.from(String(resource.associated_data), 'utf8'));
      return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
    } catch {
      throw new BadGatewayException('微信支付回调报文解密失败');
    }
  }

  private readKeyFile(envName: string, expectedLabel: string): string {
    const path = this.required(envName);
    try {
      const content = readFileSync(path, 'utf8').trim();
      if (!content.includes(`BEGIN ${expectedLabel}`) && !content.includes(`BEGIN RSA ${expectedLabel}`)) {
        throw new Error(`文件不是 ${expectedLabel} 格式`);
      }
      return content;
    } catch (error) {
      throw new ServiceUnavailableException(`微信支付密钥文件读取失败（${envName}）：${(error as Error).message}`);
    }
  }

  private required(name: string): string {
    const value = (process.env[name] || '').trim();
    if (!value) throw new ServiceUnavailableException(`微信直连支付未配置 ${name}，请在服务端环境变量中填入`);
    return value;
  }
}
