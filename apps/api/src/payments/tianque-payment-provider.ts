import { BadGatewayException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { createSign, createVerify, randomUUID } from 'crypto';
import { Repository } from 'typeorm';
import { MerchantPaymentProfile, Order } from '../domain/entities';
import { PaymentEventType } from '../domain/entities';
import { SensitiveDataService } from '../sensitive-data.service';
import type { NormalizedPaymentEvent, PaymentIntent, PaymentProvider, PaymentWebhookInput, RefundQueryResult, RefundRequest } from './payment-provider';

type TianqueResponse = Record<string, unknown>;

/** 单商户天阙直连凭据（多租户：每商户一套 mno/orgId/私钥/公钥） */
type TianqueCredential = {
  mno: string;
  orgId: string;
  privateKey: string;
  publicKey: string;
  signAlg: 'sha256' | 'sha1';
  fromDb: boolean;
};

/**
 * 天阙开放平台（随行付聚合支付）适配器。
 *
 * - 小程序收银台：POST /order/appletScanPre（appletSource=01 半屏收银台），
 *   返回 appId + path 供来源小程序 wx.openEmbeddedMiniProgram 拉起收银台小程序
 * - 支付结果查询：POST /query/tradeQuery
 * - 退款：POST /order/refund
 * - 异步通知：仅交易成功推送，验签后需应答 {"code":"success","msg":"成功"}
 *
 * 报文结构（天阙统一格式）：
 * - 请求外层 { orgId, reqId, reqData(业务JSON), timestamp(yyyyMMddHHmmss), version, signType, sign }
 * - sign 对除 sign 外字段按参数名 ASCII 排序 → key=value& 拼接 → 己方 RSA 私钥签名
 * - 响应/回调：去掉 sign 后同样排序拼接，用天阙公钥验签（回调为平铺字段，无 reqData/respData 包裹）
 *
 * 【多租户凭据解析（v2）】
 * - 优先：merchant_payment_profiles 表按 providerMerchantId(mno) 查询该商户的
 *   tianque_mno / tianque_org_id / tianque_private_key_enc(加密) / tianque_public_key / tianque_sign_alg；
 *   每个商户可拥有独立的一套天阙开发参数。
 * - 兜底：查不到档案或档案未填凭据时回退全局环境变量（兼容单商户旧部署）：
 *   TIANQUE_ORG_ID / TIANQUE_MNO / TIANQUE_PRIVATE_KEY / TIANQUE_PUBLIC_KEY / TIANQUE_SIGN_ALG。
 *
 * 回调验签按回调报文中的 mno 找到对应商户公钥。
 */
@Injectable()
export class TianquePaymentProvider implements PaymentProvider {
  readonly providerName = 'tianque';
  /** 未配置天阙参数时仅禁用本渠道（路由层自动回退微信直连），不影响其他渠道 */
  readonly enabled: boolean;
  /** 天阙支持按商户档案多租户；同时兼容全局单商户（requiresMerchantProfile 仍为 true，路由按档案分发） */
  readonly requiresMerchantProfile = true;

  private readonly baseUrl: string;
  private readonly notifyUrl: string;
  // 全局 env 仅作兜底（兼容期/单商户），多租户优先读数据库档案
  private readonly fallbackOrgId: string;
  /** 全局默认 mno（供路由层判断"全局天阙通道"与"商家级 mno"差异） */
  readonly fallbackMno: string;
  private readonly fallbackPrivateKey: string;
  private readonly fallbackPublicKey: string;
  private readonly fallbackSignAlg: 'sha256' | 'sha1';

  constructor(
    @InjectRepository(Order) private readonly orders: Repository<Order>,
    @InjectRepository(MerchantPaymentProfile) private readonly profiles: Repository<MerchantPaymentProfile>,
    private readonly sensitiveData: SensitiveDataService,
  ) {
    this.baseUrl = (process.env.TIANQUE_BASE_URL || 'https://paas.tianquetech.com').replace(/\/$/, '');
    this.fallbackOrgId = String(process.env.TIANQUE_ORG_ID || '').trim();
    this.fallbackMno = String(process.env.TIANQUE_MNO || '').trim();
    this.fallbackPrivateKey = this.formatPem(String(process.env.TIANQUE_PRIVATE_KEY || '').trim(), 'PRIVATE KEY');
    this.fallbackPublicKey = this.formatPem(String(process.env.TIANQUE_PUBLIC_KEY || '').trim(), 'PUBLIC KEY');
    this.fallbackSignAlg = String(process.env.TIANQUE_SIGN_ALG || 'sha256').trim() === 'sha1' ? 'sha1' : 'sha256';
    this.notifyUrl = (process.env.TIANQUE_NOTIFY_URL || `${process.env.PUBLIC_BASE_URL || ''}/api/payments/webhooks/tianque`).replace(/\/$/, '');
    this.enabled = Boolean(this.fallbackOrgId && this.fallbackMno && this.fallbackPrivateKey && this.fallbackPublicKey);
  }

  /**
   * 按天阙商户号（mno）解析直连凭据：数据库档案优先，全局 env 兜底。
   */
  async resolveTianqueCredential(mno: string): Promise<TianqueCredential> {
    try {
      const profile = await this.profiles.findOne({
        where: { provider: 'TIANQUE', providerMerchantId: mno },
      });
      if (profile && profile.tianqueMno && profile.tianquePrivateKeyEnc) {
        return {
          mno: profile.tianqueMno,
          orgId: profile.tianqueOrgId || this.fallbackOrgId,
          // 解密出的私钥/公钥必须 formatPem 包装（Node crypto 要求 PEM/KeyObject）
          privateKey: this.formatPem(this.sensitiveData.decrypt(profile.tianquePrivateKeyEnc), 'PRIVATE KEY'),
          publicKey: profile.tianquePublicKey ? this.formatPem(profile.tianquePublicKey, 'PUBLIC KEY') : this.fallbackPublicKey,
          signAlg: profile.tianqueSignAlg === 'sha1' ? 'sha1' : 'sha256',
          fromDb: true,
        };
      }
    } catch {
      /* 数据库查询失败时回退 env */
    }
    return {
      mno: this.fallbackMno,
      orgId: this.fallbackOrgId,
      privateKey: this.fallbackPrivateKey,
      publicKey: this.fallbackPublicKey,
      signAlg: this.fallbackSignAlg,
      fromDb: false,
    };
  }

  private requireConfigured(credential?: TianqueCredential): void {
    const c = credential || { orgId: this.fallbackOrgId, mno: this.fallbackMno, privateKey: this.fallbackPrivateKey, publicKey: this.fallbackPublicKey, signAlg: this.fallbackSignAlg, fromDb: false } as TianqueCredential;
    if (!c.orgId || !c.mno || !c.privateKey || !c.publicKey) {
      throw new ServiceUnavailableException('天阙支付未配置完整（商户档案或 TIANQUE_ORG_ID/MNO/PRIVATE_KEY/PUBLIC_KEY），请联系平台管理员');
    }
  }

  // ==========================================================================
  // PaymentProvider 接口实现
  // ==========================================================================

  /** 小程序收银台预下单（半屏收银台 appletSource=01）。返回 uuid 与拉起参数。 */
  async createPayment(intent: PaymentIntent): Promise<{ paymentReference: string; expiresAt: Date; payInfo?: string }> {
    const mno = String(intent.providerMerchantId || '').trim() || this.fallbackMno;
    const credential = await this.resolveTianqueCredential(mno);
    this.requireConfigured(credential);
    const reqData = {
      mno: credential.mno,
      ordNo: intent.orderNo,
      amt: (intent.amountFen / 100).toFixed(2),
      appletSource: '01',
      subject: '团购套餐',
      trmIp: '127.0.0.1',
      timeExpire: '15',
      limitPay: '00',
      identityFlag: '01',
      ledgerAccountFlag: '01',
      notifyUrl: this.notifyUrl,
    };
    const respData = await this.tianquePost('/order/appletScanPre', reqData, credential);
    const bizCode = this.responseString(respData, 'bizCode', 1, 16);
    if (bizCode !== '0000') {
      throw new BadGatewayException(`天阙下单失败（${bizCode}）：${this.optionalResponseString(respData, 'bizMsg', 256) || '未知错误'}`);
    }
    const uuid = this.responseString(respData, 'uuid', 8, 64);
    const appId = this.optionalResponseString(respData, 'appId', 64);
    const path = this.optionalResponseString(respData, 'path', 512);
    if (!appId || !path) throw new BadGatewayException('天阙未返回收银台小程序拉起参数');
    const payInfo = JSON.stringify({ mode: 'tianque', appId, path, uuid });
    return { paymentReference: uuid, expiresAt: intent.expiresAt, payInfo };
  }

  /** 解析天阙支付结果异步通知：验签（回调为平铺字段，按回调 mno 解析对应商户公钥）。 */
  async parseWebhook(input: PaymentWebhookInput): Promise<NormalizedPaymentEvent> {
    const body = input.rawBody.toString('utf8');
    let outer: TianqueResponse;
    try { outer = JSON.parse(body) as TianqueResponse; }
    catch { throw new BadGatewayException('天阙回调不是有效 JSON'); }
    const signValue = String(outer.sign || '').trim();
    if (!signValue) throw new BadGatewayException('天阙回调缺少签名');
    const callbackMno = String(outer.mno || this.fallbackMno || '').trim();
    const credential = await this.resolveTianqueCredential(callbackMno);
    this.requireConfigured(credential);
    this.verifySignature(outer, signValue, credential.publicKey, credential.signAlg);
    const orderNo = this.optionalResponseString(outer, 'ordNo', 128) || '';
    const uuid = this.optionalResponseString(outer, 'uuid', 64)
      || this.optionalResponseString(outer, 'transactionId', 64)
      || '';
    if (!orderNo || !uuid) throw new BadGatewayException('天阙回调缺少订单号或流水号');
    const amt = this.optionalResponseString(outer, 'amt', 32)
      || this.optionalResponseString(outer, 'totalOffstAmt', 32)
      || this.optionalResponseString(outer, 'oriTranAmt', 32)
      || '';
    const amountFen = amt ? this.yuanToFen(amt) : 0;
    const eventType = PaymentEventType.PAYMENT_SUCCEEDED; // 天阙仅交易成功推送回调
    return {
      providerEventId: uuid,
      eventType,
      orderNo,
      merchantId: undefined,
      providerMerchantId: callbackMno,
      amountFen,
      providerPaymentReference: uuid,
      occurredAt: new Date(),
    };
  }

  /** 主动查询支付结果。 */
  async queryPayment(input: Pick<PaymentIntent, 'orderId' | 'orderNo' | 'merchantId' | 'amountFen' | 'paymentProfileId' | 'providerMerchantId' | 'orderCreatedAt'> & { paymentReference: string | null }): Promise<NormalizedPaymentEvent | null> {
    const mno = String(input.providerMerchantId || '').trim() || this.fallbackMno;
    const credential = await this.resolveTianqueCredential(mno);
    this.requireConfigured(credential);
    const reqData = { mno: credential.mno, ordNo: input.orderNo };
    const respData = await this.tianquePost('/query/tradeQuery', reqData, credential);
    const tranSts = this.responseString(respData, 'tranSts', 1, 16);
    if (tranSts === 'PAYING') return null; // 支付中
    const eventType = tranSts === 'SUCCESS' ? PaymentEventType.PAYMENT_SUCCEEDED
      : (tranSts === 'CLOSED' || tranSts === 'CANCELED') ? PaymentEventType.PAYMENT_CLOSED
        : PaymentEventType.PAYMENT_FAILED;
    const uuid = this.optionalResponseString(respData, 'uuid', 64)
      || this.optionalResponseString(respData, 'transactionId', 64)
      || input.paymentReference
      || input.orderNo;
    const amt = this.optionalResponseString(respData, 'oriTranAmt', 32)
      || this.optionalResponseString(respData, 'totalOffstAmt', 32)
      || '';
    return {
      providerEventId: uuid,
      eventType,
      orderNo: input.orderNo,
      merchantId: input.merchantId,
      providerMerchantId: credential.mno,
      amountFen: amt ? this.yuanToFen(amt) : input.amountFen,
      providerPaymentReference: uuid,
      occurredAt: new Date(),
    };
  }

  /** 退款。 */
  async refund(request: RefundRequest): Promise<{ paymentReference: string }> {
    const mno = String(request.providerMerchantId || '').trim() || this.fallbackMno;
    const credential = await this.resolveTianqueCredential(mno);
    this.requireConfigured(credential);
    const order = await this.orders.findOneBy({ id: request.orderId });
    if (!order || !order.orderNo) throw new ServiceUnavailableException('天阙退款无法定位原订单');
    // H10：退款金额必须为正且不超过订单金额
    if (!Number.isSafeInteger(request.amountFen) || request.amountFen <= 0 || request.amountFen > order.amountFen) {
      throw new BadGatewayException('退款金额不合法或超过订单金额');
    }
    const refundOrdNo = `R${request.voucherId.replace(/[^A-Za-z0-9_]/g, '').slice(0, 20)}${request.idempotencyKey.replace(/[^A-Za-z0-9_]/g, '').slice(-12)}`.slice(0, 64);
    const reqData = {
      mno: credential.mno,
      ordNo: refundOrdNo,
      origOrderNo: order.orderNo,
      origUuid: '',
      origSxfUuid: '',
      amt: (request.amountFen / 100).toFixed(2),
      notifyUrl: this.notifyUrl,
      refundReason: '团购退款',
    };
    const respData = await this.tianquePost('/order/refund', reqData, credential);
    const bizCode = this.responseString(respData, 'bizCode', 1, 16);
    if (bizCode !== '0000') {
      throw new BadGatewayException(`天阙退款失败（${bizCode}）：${this.optionalResponseString(respData, 'bizMsg', 256) || '未知错误'}`);
    }
    return { paymentReference: this.optionalResponseString(respData, 'uuid', 64) || refundOrdNo };
  }

  /** 天阙暂无主动退款查询接口，返回 null 让补偿逻辑退化为重提。 */
  async queryRefund(_request: RefundRequest): Promise<RefundQueryResult | null> {
    return null;
  }

  async confirmPayment(_request: import('./payment-provider').SettlementConfirmationRequest): Promise<{ providerReference: string }> { throw new ServiceUnavailableException('天阙不支持汇付延迟交易确认'); }
  async queryPaymentConfirmation(_request: import('./payment-provider').SettlementConfirmationRequest): Promise<import('./payment-provider').SettlementConfirmationResult | null> { return null; }
  async confirmRefund(request: RefundRequest): Promise<import('./payment-provider').RefundOperationResult> {
    const result = await this.refund(request);
    return { status: 'SUCCEEDED', paymentReference: result.paymentReference };
  }
  async queryConfirmRefund(request: RefundRequest): Promise<RefundQueryResult | null> { return this.queryRefund(request); }


  async submitSettlement(input: { billId: string; amountFen: number }): Promise<{ reference: string }> {
    return { reference: `tianque_settlement_${input.billId.slice(0, 8)}` };
  }

  // ==========================================================================
  // 内部方法
  // ==========================================================================

  /** 发送天阙报文，返回解析后的 respData 业务对象。多租户：按商户凭据签名。 */
  private async tianquePost(path: string, reqData: Record<string, unknown>, credential?: TianqueCredential): Promise<TianqueResponse> {
    const c = credential || await this.resolveTianqueCredential(String((reqData as Record<string, unknown>).mno || '').trim() || this.fallbackMno);
    const url = this.apiUrl(path);
    const timestamp = this.timestamp14(new Date());
    const reqId = randomUUID().replace(/-/g, '').slice(0, 32);
    const outer = { orgId: c.orgId, reqId, reqData, timestamp, version: '1.0', signType: 'RSA' };
    const sign = this.sign(this.buildSignString(outer), c.privateKey, c.signAlg);
    const payload = JSON.stringify({ ...outer, sign });

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      throw new ServiceUnavailableException('暂时无法连接天阙支付网关，请稍后重试');
    }

    const text = await response.text();
    if (text.length > 512 * 1024) throw new BadGatewayException('天阙支付网关响应数据过大');

    let value: TianqueResponse;
    try { value = JSON.parse(text) as TianqueResponse; }
    catch { throw new BadGatewayException('天阙支付网关响应格式异常'); }

    if (!response.ok) {
      throw new BadGatewayException(`天阙支付网关请求失败（HTTP ${response.status}）：${String(value.msg || '未知错误')}`);
    }

    const code = String(value.code || '');
    if (code && code !== '0000') {
      throw new BadGatewayException(`天阙支付网关返回错误（${code}）：${String(value.msg || '未知错误')}`);
    }

    // 响应验签（code=0000 时 sign 必返）——用该商户的天阙公钥
    const respSign = String(value.sign || '').trim();
    if (respSign) this.verifySignature(value, respSign, c.publicKey, c.signAlg);

    const respData = value.respData;
    if (typeof respData === 'string' && respData) {
      try { return JSON.parse(respData) as TianqueResponse; }
      catch { throw new BadGatewayException('天阙 respData 不是有效 JSON'); }
    }
    if (respData && typeof respData === 'object') return respData as TianqueResponse;
    return {};
  }

  /** 对除 sign 外字段按参数名 ASCII 排序 → key=value& 拼接（值去前后空格，嵌套对象为紧凑 JSON 字符串）。 */
  private buildSignString(value: Record<string, unknown>): string {
    const keys = Object.keys(value).filter((key) => key !== 'sign').sort();
    return keys.map((key) => {
      const raw = value[key];
      const stringValue = typeof raw === 'object' && raw !== null
        ? JSON.stringify(raw)
        : String(raw === undefined || raw === null ? '' : raw);
      return `${key}=${stringValue.trim()}`;
    }).join('&');
  }

  /** RSA 签名（PKCS1 v1.5，SHA256 或 SHA1）。多租户：用该商户私钥。 */
  private sign(payload: string, privateKey?: string, signAlg?: 'sha256' | 'sha1'): string {
    try {
      const algorithm = (signAlg || this.fallbackSignAlg) === 'sha1' ? 'RSA-SHA1' : 'RSA-SHA256';
      const signer = createSign(algorithm);
      signer.update(payload, 'utf8');
      return signer.sign(privateKey || this.fallbackPrivateKey, 'base64');
    } catch {
      throw new ServiceUnavailableException('天阙支付签名服务暂不可用');
    }
  }

  /** RSA 验签。多租户：用对应商户的天阙公钥。 */
  private verifySignature(value: Record<string, unknown>, signature: string, publicKey?: string, signAlg?: 'sha256' | 'sha1'): void {
    if (!signature || signature.length > 8192) throw new ServiceUnavailableException('天阙回调签名缺失或过长');
    const payload = this.buildSignString(value);
    try {
      const algorithm = (signAlg || this.fallbackSignAlg) === 'sha1' ? 'RSA-SHA1' : 'RSA-SHA256';
      const verifier = createVerify(algorithm);
      verifier.update(payload, 'utf8');
      if (!verifier.verify(publicKey || this.fallbackPublicKey, signature, 'base64')) throw new Error('签名不匹配');
    } catch {
      throw new ServiceUnavailableException('天阙回调验签失败');
    }
  }

  /** 格式化 PEM 密钥（自动补全头尾）。 */
  private formatPem(key: string, expectedLabel: string): string {
    const trimmed = key.trim();
    if (trimmed.startsWith('-----BEGIN')) return trimmed;
    const label = expectedLabel;
    const chunks = trimmed.match(/.{1,64}/g) || [];
    return `-----BEGIN ${label}-----\n${chunks.join('\n')}\n-----END ${label}-----`;
  }

  private apiUrl(path: string): string {
    const url = new URL(path, this.baseUrl);
    if (url.protocol !== 'https:' && process.env.NODE_ENV === 'production') {
      throw new ServiceUnavailableException('天阙生产环境必须使用 HTTPS');
    }
    return url.toString();
  }

  private responseString(value: TianqueResponse, field: string, minLength: number, maxLength: number): string {
    const result = value[field];
    if (typeof result !== 'string' || result.length < minLength || result.length > maxLength) {
      throw new BadGatewayException(`天阙支付网关响应字段 ${field} 不合法`);
    }
    return result;
  }

  private optionalResponseString(value: TianqueResponse, field: string, maxLength: number): string | null {
    const result = value[field];
    if (result === undefined || result === null || result === '') return null;
    if (typeof result !== 'string' || result.length > maxLength) {
      throw new BadGatewayException(`天阙支付网关响应字段 ${field} 不合法`);
    }
    return result;
  }

  private yuanToFen(value: string): number {
    const parsed = parseFloat(value);
    if (!Number.isFinite(parsed) || parsed <= 0) throw new BadGatewayException('天阙支付网关返回金额不合法');
    const fen = Math.round(parsed * 100);
    if (!Number.isSafeInteger(fen)) throw new BadGatewayException('天阙支付网关返回金额超出范围');
    return fen;
  }

  private timestamp14(date: Date): string {
    const pad = (value: number) => String(value).padStart(2, '0');
    return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  }
}
