import { BadGatewayException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { createSign, createVerify, randomUUID } from 'crypto';
import { Repository } from 'typeorm';
import { MerchantPaymentProfile, PaymentEventType } from '../domain/entities';
import { SensitiveDataService } from '../sensitive-data.service';
import type { NormalizedPaymentEvent, PaymentIntent, PaymentProvider, PaymentWebhookInput, RefundOperationResult, RefundQueryResult, RefundRequest, SettlementConfirmationRequest, SettlementConfirmationResult } from './payment-provider';

type HuifuApiResponse = Record<string, unknown>;

/** 单商户汇付直连凭据（多租户：每商户一套 sys_id/product_id/私钥/公钥） */
type HuifuCredential = {
  sysId: string;
  productId: string;
  privateKey: string;
  /** 汇付公钥（回调验签）；数据库未配置时回退全局 env */
  publicKey: string;
  feeType: string;
  /** 该商户绑定的微信小程序 APPID（档案优先，下单 sub_appid 用） */
  appletAppId: string;
  fromDb: boolean;
};

/**
 * 汇付天下支付适配器（直连商户模式，多租户凭据）。
 *
 * 报文结构（SPIN 统一格式）：
 * - 请求外层 { sign_type, sys_id, sign, data }，data 为业务参数 JSON 字符串
 * - sign 为对 data 字符串的 RSA-SHA256 签名（RSA2）
 * - 响应外层 { resp_code, resp_desc, sign_type, sign, data }，data 为业务参数 JSON 字符串
 *
 * 【多租户凭据解析（v2）】
 * - 优先：merchant_payment_profiles 表按 providerMerchantId(huifu_id) 查询该商户自己的
 *   huifu_sys_id / huifu_product_id / huifu_private_key_enc（AES-256-GCM 加密）/ huifu_public_key / huifu_fee_type；
 *   每个商户可以拥有独立的一套直连开发参数（sys_id=huifu_id、product_id、商户私钥、汇付公钥）。
 * - 兜底：查不到档案或档案未填凭据时回退全局环境变量（兼容单商户旧部署）：
 *   HUIFU_SYS_ID / HUIFU_PRODUCT_ID / HUIFU_ISV_PRIVATE_KEY / HUIFU_PUBLIC_KEY / HUIFU_WECHAT_FEE_TYPE。
 *
 * 回调验签按回调报文中的 huifu_id 找到对应商户公钥，多商户互不串签。
 */
@Injectable()
export class HuifuPaymentProvider implements PaymentProvider {
  readonly providerName = 'huifu';
  readonly enabled = true;
  readonly requiresMerchantProfile = true;

  private readonly baseUrl: string;
  // 全局 env 仅作兜底（兼容期/单商户），多租户优先读数据库档案
  private readonly fallbackSysId: string;
  private readonly fallbackProductId: string;
  private readonly fallbackPrivateKey: string;
  private readonly fallbackPublicKey: string;

  constructor(
    @InjectRepository(MerchantPaymentProfile) private readonly profiles: Repository<MerchantPaymentProfile>,
    private readonly sensitiveData: SensitiveDataService,
  ) {
    this.baseUrl = (process.env.HUIFU_BASE_URL || 'https://api.huifu.com').replace(/\/$/, '');
    this.fallbackSysId = (process.env.HUIFU_SYS_ID || '').trim();
    this.fallbackProductId = (process.env.HUIFU_PRODUCT_ID || '').trim();
    this.fallbackPrivateKey = this.formatPem(process.env.HUIFU_ISV_PRIVATE_KEY || '', 'private');
    this.fallbackPublicKey = this.formatPem(process.env.HUIFU_PUBLIC_KEY || '', 'public');
  }

  // ==========================================================================
  // 多租户凭据解析
  // ==========================================================================

  /**
   * 按汇付商户号解析直连凭据：数据库档案优先，全局 env 兜底。
   * 供支付/退款/绑定/查询/回调验签统一使用。
   */
  async resolveCredential(huifuId: string): Promise<HuifuCredential> {
    try {
      const profile = await this.profiles.findOne({
        where: { provider: 'HUIFU', providerMerchantId: huifuId },
      });
      if (profile && profile.huifuSysId && profile.huifuProductId && profile.huifuPrivateKeyEnc) {
        // 解密出的私钥/公钥必须 formatPem 包装（Node crypto 签名/验签要求 PEM 或 KeyObject，裸 Base64 会抛"签名服务暂不可用"）
        return {
          sysId: profile.huifuSysId,
          productId: profile.huifuProductId,
          privateKey: this.formatPem(this.sensitiveData.decrypt(profile.huifuPrivateKeyEnc), 'private'),
          publicKey: profile.huifuPublicKey ? this.formatPem(profile.huifuPublicKey, 'public') : this.fallbackPublicKey,
          feeType: profile.huifuFeeType || String(process.env.HUIFU_WECHAT_FEE_TYPE || ''),
          appletAppId: profile.wxAppletAppId || '',
          fromDb: true,
        };
      }
    } catch {
      /* 数据库查询失败时回退 env，保证兼容期可用 */
    }
    return {
      sysId: this.fallbackSysId,
      productId: this.fallbackProductId,
      privateKey: this.fallbackPrivateKey,
      publicKey: this.fallbackPublicKey,
      feeType: String(process.env.HUIFU_WECHAT_FEE_TYPE || ''),
      appletAppId: String(process.env.WECHAT_MINIPROGRAM_APP_ID || '').trim(),
      fromDb: false,
    };
  }

  // ==========================================================================
  // PaymentProvider 接口实现
  // ==========================================================================

  /**
   * 统一下单（jspay 小程序支付）。返回汇付全局流水号 hf_seq_id 与前端调起支付串 pay_info。
   *
   * 接口选择（2026-08-06 对照汇付官方 V3 聚合正扫文档修正）：
   * - 使用 POST /v3/trade/payment/jspay（聚合正扫 V3），文档明确「当主体为直连商户时，
   *   sys_id 填写商户 huifu_id」——直连身份即可调用，返回 pay_info 直接喂 wx.requestPayment，
   *   无需统一收银台权限（此前 /v2/trade/hosting/payment/preorder 返回 00000009 即因缺收银台权限）。
   * - 不使用 SPIN /top/trans/pullPayInfo（服务商协议，直连身份 40001 无效参数）。
   */
  async createPayment(intent: PaymentIntent): Promise<{ paymentReference: string; expiresAt: Date; payInfo?: string }> {
    const huifuId = this.requireProviderMerchantId(intent.providerMerchantId);
    const openid = String(intent.customerOpenid || '').trim();
    if (!openid) throw new ServiceUnavailableException('付款顾客尚未授权登录，无法发起微信支付');
    // 多租户：sub_appid 优先取该商户档案绑定的小程序 APPID，全局 env 仅兜底
    const credential = await this.resolveCredential(huifuId);
    const appid = String(credential.appletAppId || process.env.WECHAT_MINIPROGRAM_APP_ID || '').trim();
    if (!appid) throw new ServiceUnavailableException('该商户未配置微信小程序 APPID（支付档案），无法发起小程序支付');
    const now = new Date();
    const expireAt = new Date(Math.max(Date.now() + 60_000, intent.expiresAt.getTime() - 60_000));
    // H-04：req_seq_id 由持久化订单号稳定派生（同一订单重试同号，渠道侧按号幂等，避免重复建单）
    const reqSeq = String(intent.orderNo || intent.idempotencyKey || `order-${intent.orderId}`).replace(/[^A-Za-z0-9]/g, '').slice(0, 32);
    // V3 聚合正扫（jsapi）：data 为 JSON 对象，wx_data/risk_check_data 为 JSON 字符串子对象
    const data: Record<string, string> = {
      req_seq_id: reqSeq,
      req_date: iso8(now),
      huifu_id: huifuId,
      trans_amt: (intent.amountFen / 100).toFixed(2),
      goods_desc: '团购套餐',
      trade_type: 'T_MINIAPP',
      wx_data: JSON.stringify({ sub_appid: appid, sub_openid: openid }),
      notify_url: `${process.env.PUBLIC_BASE_URL || ''}/api/payments/webhooks/huifu`,
      time_expire: iso14(expireAt),
    };
    if (process.env.HUIFU_DELAYED_SETTLEMENT_ENABLED === 'true') data.delay_acct_flag = 'Y';
    const inner = await this.v2Request('/v3/trade/payment/jspay', data, credential);
    const transStat = String(inner.trans_stat || '').trim();
    // 同步受理：S 成功 / P 处理中（返回 pay_info 供前端拉起支付）/ 其他失败
    if (transStat === 'F') {
      const msg = String(inner.bank_message || inner.resp_desc || '交易失败');
      throw new ServiceUnavailableException(`汇付下单失败：${msg}`);
    }
    if (transStat !== 'P' && transStat !== 'S') {
      const respCode = String(inner.resp_code || '');
      const msg = String(inner.bank_message || inner.resp_desc || '未知错误');
      throw new ServiceUnavailableException(`汇付下单未受理（${respCode || 'unknown'}）：${msg}`);
    }
    const hfSeqId = this.optionalResponseString(inner, 'hf_seq_id', 64) || reqSeq;
    // pay_info：JSAPI 支付参数 JSON 字符串（appId/timeStamp/nonceStr/package/signType/paySign），
    // 前端直接 wx.requestPayment 调起（与微信直连模式一致），无需跳收银台小程序
    const payInfoRaw = this.optionalResponseString(inner, 'pay_info', 4096) || '';
    const payInfo = payInfoRaw ? JSON.stringify({ mode: 'huifu', pay_info: payInfoRaw, orderNo: intent.orderNo, hfSeqId }) : '';
    // A1：返回渠道实际生效的过期时间（time_expire=expireAt，即订单到期前 60s 保险窗口），
    // 与渠道侧一致，避免调用方按 intent.expiresAt 判断支付窗口时多出 60s 误差
    return { paymentReference: hfSeqId, expiresAt: expireAt, payInfo };
  }

  /** 解析汇付异步回调并验签。按回调报文 huifu_id 解析对应商户公钥验签。 */
  async parseWebhook(input: PaymentWebhookInput): Promise<NormalizedPaymentEvent> {
    const body = input.rawBody.toString('utf8');
    let outer: HuifuApiResponse;
    try { outer = JSON.parse(body) as HuifuApiResponse; }
    catch { throw new BadGatewayException('汇付回调不是有效 JSON'); }
    const signValue = String(outer.sign || outer.resp_sign || '').trim();
    if (!signValue) throw new BadGatewayException('汇付回调缺少签名');
    // 汇付 V3 交易通知使用 data；资金解冻通知使用 resp_data。
    // 字符串载荷必须按原字符串验签，不能 JSON.parse 后重新序列化，避免 0.00 等格式变化。
    const signedData = this.callbackPayload(outer);
    // resp_data 是延迟交易确认/确认退款等业务通知，必须与普通支付回调分流。
    const isDelayedSettlementCallback = signedData.source === 'resp_data';
    // 从 data/resp_data 解析 huifu_id，按回调商户号选择对应公钥。
    const callbackHuifuId = String(signedData.value.huifu_id || '').trim();
    const credential = await this.resolveCredential(callbackHuifuId);
    this.verifySignature(signedData.signaturePayload, signValue, credential.publicKey);
    const parsed = signedData.value;
    const fundFreezeStat = this.optionalResponseString(parsed, 'fund_freeze_stat', 16);
    const normalizedEventType = fundFreezeStat === 'FREEZE' || fundFreezeStat === 'UNFREEZE'
      ? PaymentEventType.FUND_CONTROL_UPDATED
      : isDelayedSettlementCallback
        ? PaymentEventType.DELAYED_SETTLEMENT_UPDATED
        : (() => {
          const eventType = this.responseString(parsed, 'trans_stat', 1, 16);
          return eventType === 'S' ? PaymentEventType.PAYMENT_SUCCEEDED :
            eventType === 'F' ? PaymentEventType.PAYMENT_FAILED : PaymentEventType.PAYMENT_CLOSED;
        })();
    // 官方支付通知原样返回 req_seq_id；下单时该字段由 orderNo 稳定派生。
    // 保留旧字段作为兼容回退，避免旧版本回调无法对账。
    const orderNo = [
      this.optionalResponseString(parsed, 'req_seq_id', 128),
      this.optionalResponseString(parsed, 'mer_ord_id', 128),
      this.optionalResponseString(parsed, 'out_order_no', 128),
      this.optionalResponseString(parsed, 'out_ord_id', 128),
      this.optionalResponseString(parsed, 'org_req_seq_id', 128),
    ].find((candidate) => /^DG\d{8}[A-F0-9]{16}$/.test(candidate || '')) || '';
    // A3：事件标识兜底覆盖 V3 聚合正扫回调字段（hf_seq_id 优先，其次微信订单号/支付凭证号）
    const eventId = this.optionalResponseString(parsed, 'hf_seq_id', 64)
      || this.optionalResponseString(parsed, 'trans_id', 64)
      || this.optionalResponseString(parsed, 'out_trans_id', 64)
      || this.optionalResponseString(parsed, 'party_order_id', 64)
      || '';
    if (!orderNo || !eventId) throw new BadGatewayException('汇付回调缺少订单号或流水号');
    const transAmount = this.optionalResponseString(parsed, 'trans_amt', 16);
    const unfreezeAmount = this.optionalResponseString(parsed, 'unfreeze_amt', 16);
    const amountFen = this.yuanToFen(transAmount || unfreezeAmount || '');
    const fundControl: NormalizedPaymentEvent['fundControl'] = fundFreezeStat === 'FREEZE' || fundFreezeStat === 'UNFREEZE'
      ? {
        status: fundFreezeStat as 'FREEZE' | 'UNFREEZE',
        frozenAt: this.parseHuifuTime(this.optionalResponseString(parsed, 'freeze_time', 14)),
        unfrozenAt: this.parseHuifuTime(this.optionalResponseString(parsed, 'unfreeze_time', 14)),
        unfrozenAmountFen: unfreezeAmount === null ? null : this.yuanToFenAllowZero(unfreezeAmount),
      }
      : undefined;
    return {
      providerEventId: eventId,
      eventType: normalizedEventType,
      orderNo,
      providerMerchantId: this.optionalResponseString(parsed, 'huifu_id', 64),
      amountFen,
      providerPaymentReference: eventId,
      occurredAt: fundControl?.unfrozenAt || fundControl?.frozenAt || this.parseHuifuTime(this.optionalResponseString(parsed, 'trans_time', 14)) || new Date(),
      fundControl,
      delayedSettlement: isDelayedSettlementCallback ? {
        status: String(parsed.trans_stat || parsed.confirm_stat || parsed.refund_stat || '').trim() === 'S' ? 'SUCCEEDED'
          : String(parsed.trans_stat || parsed.confirm_stat || parsed.refund_stat || '').trim() === 'F' ? 'FAILED' : 'PROCESSING',
        providerReference: this.optionalResponseString(parsed, 'hf_seq_id', 128),
        idempotencyKey: this.optionalResponseString(parsed, 'org_req_seq_id', 128),
      } : undefined,
    };
  }

  /** 主动查询支付结果（V3 聚合正扫订单查询，直连商户用 V3 scanpay/query；注意非 merge/query——那是合单支付查询，单笔交易用 merge/query 返回"交易不存在"）。 */
  async queryPayment(input: Pick<PaymentIntent, 'orderId' | 'orderNo' | 'merchantId' | 'amountFen' | 'paymentProfileId' | 'providerMerchantId' | 'orderCreatedAt'> & { paymentReference: string | null }): Promise<NormalizedPaymentEvent | null> {
    if (!input.paymentReference && !input.orderNo) return null;
    const huifuId = this.requireProviderMerchantId(input.providerMerchantId);
    const now = new Date();
    // 直连查单：org_req_seq_id = 下单时的 req_seq_id（H-04：由 orderNo 稳定派生，同订单同号）；
    // org_req_date = 原交易请求日期（下单日期），必填（实测缺失返回 21000000）
    const data = {
      req_seq_id: `q_${input.orderNo.slice(-20)}${now.getTime().toString().slice(-8)}`,
      req_date: iso8(now),
      huifu_id: huifuId,
      org_req_seq_id: String(input.orderNo || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 32),
      org_req_date: iso8(input.orderCreatedAt || now),
    };
    const credential = await this.resolveCredential(huifuId);
    const response = await this.v2Request('/v3/trade/payment/scanpay/query', data, credential);
    const transStat = this.responseString(response, 'trans_stat', 1, 16);
    if (transStat === 'P') return null; // 处理中
    const eventType = transStat === 'S' ? PaymentEventType.PAYMENT_SUCCEEDED :
      transStat === 'F' ? PaymentEventType.PAYMENT_FAILED : PaymentEventType.PAYMENT_CLOSED;
    const eventId = this.optionalResponseString(response, 'out_trans_id', 64)
      || this.optionalResponseString(response, 'org_hf_seq_id', 64)
      || this.optionalResponseString(response, 'hf_seq_id', 64)
      || this.optionalResponseString(response, 'trans_id', 64)
      || this.requiredEventId(response, input.paymentReference || input.orderNo);
    return {
      providerEventId: eventId,
      eventType,
      orderNo: input.orderNo,
      merchantId: input.merchantId,
      providerMerchantId: huifuId,
      amountFen: this.yuanToFen(this.responseString(response, 'trans_amt', 1, 16)),
      providerPaymentReference: eventId,
      occurredAt: new Date(),
    };
  }

  /**
   * 退款（V3 聚合正扫退款，直连商户用 V3 scanpay/refund——V3 scanpay 系列对直连可用，实测受理成功）。
   * 定位原交易：org_req_seq_id = 下单时的 req_seq_id（H-04：由 orderNo 稳定派生，同一订单下单/退款同号）；
   * org_req_date = 原交易请求日期（下单日期，必填——实测缺失返回 21000000）。
   * 金额字段为 ord_amt。
   * req_seq_id 由 voucherId 稳定派生（H-04 同款），保证 queryRefund 可按同一规则定位原退款请求。
   */
  async refund(request: RefundRequest): Promise<{ paymentReference: string }> {
    const huifuId = this.requireProviderMerchantId(request.providerMerchantId);
    // H10：退款金额必须为正（上限由退款服务按订单校验）
    if (!Number.isSafeInteger(request.amountFen) || request.amountFen <= 0) throw new BadGatewayException('退款金额不合法');
    const now = new Date();
    // 与 createPayment 的 req_seq_id 派生规则保持一致（H-04 幂等，含 orderId 兜底）
    const orgReqSeq = String(request.orderNo || request.idempotencyKey || `order-${request.orderId}`).replace(/[^A-Za-z0-9]/g, '').slice(0, 32);
    // 退款请求流水号：由 voucherId 完全稳定派生（同券重试同号=幂等，queryRefund 按同一规则定位原退款）
    const refundReqSeq = `r${String(request.voucherId).replace(/[^A-Za-z0-9]/g, '').slice(0, 30)}`;
    const data = {
      req_seq_id: refundReqSeq,
      req_date: iso8(now),
      huifu_id: huifuId,
      ord_amt: (request.amountFen / 100).toFixed(2),
      org_req_seq_id: orgReqSeq,
      org_req_date: iso8(request.orderCreatedAt || now),
      remark: `voucher-${request.voucherId.slice(0, 24)}`,
    };
    const credential = await this.resolveCredential(huifuId);
    const response = await this.v2Request('/v3/trade/payment/scanpay/refund', data, credential);
    const hfSeqId = this.optionalResponseString(response, 'hf_seq_id', 64) || '';
    if (!hfSeqId) {
      const respCode = String(response.resp_code || '');
      const desc = String(response.resp_desc || response.bank_message || '退款未受理');
      throw new BadGatewayException(`汇付退款未受理（${respCode}）：${desc}`);
    }
    return { paymentReference: hfSeqId };
  }

  /**
   * 退款查询（V3 聚合正扫退款查询，与退款提交配套）。
   * 定位原退款：org_req_seq_id = 退款提交时的 req_seq_id（由 voucherId 稳定派生）；
   * org_req_date = 原交易请求日期（必填）。
   */
  async queryRefund(request: RefundRequest): Promise<RefundQueryResult | null> {
    const huifuId = this.requireProviderMerchantId(request.providerMerchantId);
    const now = new Date();
    // 与 refund() 的 req_seq_id 派生规则保持一致（voucherId 稳定派生）
    const refundReqSeq = `r${String(request.voucherId).replace(/[^A-Za-z0-9]/g, '').slice(0, 30)}`;
    const data = {
      req_seq_id: `qr_${request.voucherId.slice(-16)}${now.getTime().toString().slice(-8)}`,
      req_date: iso8(now),
      huifu_id: huifuId,
      org_req_seq_id: refundReqSeq,
      org_req_date: iso8(request.orderCreatedAt || now),
    };
    try {
      const credential = await this.resolveCredential(huifuId);
      const response = await this.v2Request('/v3/trade/payment/scanpay/refundquery', data, credential);
      const transStat = String(response.trans_stat || '').trim();
      if (transStat === 'S') return { status: 'SUCCEEDED', providerPaymentReference: this.optionalResponseString(response, 'hf_seq_id', 64) || null };
      if (transStat === 'F') return { status: 'FAILED' };
      return { status: 'PROCESSING' };
    } catch {
      // 查询失败（含原退款未找到）：返回 null 让调用方退化为重提
      return null;
    }
  }

  async confirmPayment(request: SettlementConfirmationRequest): Promise<{ providerReference: string }> {
    const huifuId = this.requireProviderMerchantId(request.providerMerchantId);
    const splitAmountFen = request.acctSplitBunch.reduce((sum, item) => sum + this.yuanToFen(item.div_amt), 0);
    if (splitAmountFen !== request.amountFen) throw new BadGatewayException('汇付延迟交易分账金额与确认金额不一致');
    const credential = await this.resolveCredential(huifuId);
    const now = new Date();
    const data: Record<string, string> = {
      req_seq_id: request.confirmationRequestSeq || `c${String(request.idempotencyKey).replace(/[^A-Za-z0-9]/g, '').slice(0, 30)}`,
      req_date: iso8(request.confirmationRequestDate || now),
      huifu_id: huifuId,
      org_req_seq_id: String(request.orderNo).replace(/[^A-Za-z0-9]/g, '').slice(0, 32),
      org_req_date: iso8(request.orderCreatedAt || now),
      trans_amt: (request.amountFen / 100).toFixed(2),
      // 无分账业务：acct_infos 每笔必须携带必填的接收方 huifu_id（官方文档 Y），此处统一填交易商户自身
      acct_split_bunch: JSON.stringify({ acct_infos: request.acctSplitBunch.map((item) => ({ ...item, huifu_id: huifuId })) }),
    };
    const response = await this.v2Request('/v2/trade/payment/delaytrans/confirm', data, credential);
    const reference = this.optionalResponseString(response, 'hf_seq_id', 128) || this.optionalResponseString(response, 'confirm_seq_id', 128);
    const status = String(response.trans_stat || response.confirm_stat || '').trim();
    if (status === 'P') throw new ServiceUnavailableException('汇付延迟交易确认处理中');
    if (status === 'F' || !reference) throw new BadGatewayException(`汇付延迟交易确认失败：${String(response.resp_desc || response.bank_message || '未知错误')}`);
    return { providerReference: reference };
  }

  async queryPaymentConfirmation(request: SettlementConfirmationRequest): Promise<SettlementConfirmationResult | null> {
    const huifuId = this.requireProviderMerchantId(request.providerMerchantId);
    const credential = await this.resolveCredential(huifuId);
    const now = new Date();
    const data: Record<string, string> = {
      req_seq_id: `cq${String(request.idempotencyKey).replace(/[^A-Za-z0-9]/g, '').slice(0, 28)}`,
      req_date: iso8(now), huifu_id: huifuId,
      org_req_seq_id: request.confirmationRequestSeq || `c${String(request.idempotencyKey).replace(/[^A-Za-z0-9]/g, '').slice(0, 30)}`,
      org_req_date: iso8(request.confirmationRequestDate || now),
    };
    const response = await this.v2Request('/v3/trade/payment/delaytrans/confirmquery', data, credential);
    const status = String(response.trans_stat || response.confirm_stat || '').trim();
    if (status === 'S') return { status: 'SUCCEEDED', providerReference: this.optionalResponseString(response, 'hf_seq_id', 128) };
    if (status === 'F') return { status: 'FAILED' };
    return { status: 'PROCESSING' };
  }

  async confirmRefund(request: RefundRequest): Promise<RefundOperationResult> {
    const huifuId = this.requireProviderMerchantId(request.providerMerchantId);
    const confirmationSeq = String(request.confirmationRequestSeq || '').trim();
    if (!confirmationSeq || !request.confirmationRequestDate) throw new BadGatewayException('汇付确认后退款缺少原交易确认请求定位信息');
    const credential = await this.resolveCredential(huifuId);
    const now = new Date();
    const refundSeq = request.confirmRefundRequestSeq || `cr${String(request.voucherId).replace(/[^A-Za-z0-9]/g, '').slice(0, 28)}`;
    const refundDate = request.confirmRefundRequestDate || now;
    const data: Record<string, string> = {
      req_seq_id: refundSeq,
      req_date: iso8(refundDate), huifu_id: huifuId,
      org_req_seq_id: confirmationSeq,
      org_req_date: iso8(request.confirmationRequestDate),
      remark: `voucher-${request.voucherId.slice(0, 24)}`,
    };
    // 无分账业务：退给原分账接收方（交易商户自身）；huifu_id 为官方文档必填项
    if (request.acctSplitBunch?.length) data.acct_split_bunch = JSON.stringify({ acct_infos: request.acctSplitBunch.map((item) => ({ ...item, huifu_id: huifuId })) });
    const response = await this.v2Request('/v2/trade/payment/delaytrans/confirmrefund', data, credential);
    const reference = this.optionalResponseString(response, 'hf_seq_id', 128);
    const status = String(response.trans_stat || '').trim();
    const respCode = String(response.resp_code || '').trim();
    if (status === 'P' || respCode === '00000100') return { status: 'PROCESSING', paymentReference: reference };
    if (status === 'F' || !reference) throw new BadGatewayException(`汇付确认后退款失败：${String(response.resp_desc || '未知错误')}`);
    return { status: 'SUCCEEDED', paymentReference: reference };
  }

  async queryConfirmRefund(request: RefundRequest): Promise<RefundQueryResult | null> {
    const huifuId = this.requireProviderMerchantId(request.providerMerchantId);
    const refundSeq = String(request.confirmRefundRequestSeq || '').trim();
    const refundDate = request.confirmRefundRequestDate;
    if (!refundSeq || !refundDate) return null;
    const credential = await this.resolveCredential(huifuId);
    const data: Record<string, string> = {
      huifu_id: huifuId,
      org_req_seq_id: refundSeq,
      org_req_date: iso8(refundDate),
    };
    const response = await this.v2Request('/v2/trade/payment/delaytrans/confirmrefundquery', data, credential);
    const status = String(response.trans_stat || response.refund_stat || '').trim();
    if (status === 'S') return { status: 'SUCCEEDED', providerPaymentReference: this.optionalResponseString(response, 'org_hf_seq_id', 128) || this.optionalResponseString(response, 'hf_seq_id', 128) };
    if (status === 'F') return { status: 'FAILED' };
    return { status: 'PROCESSING' };
  }
  /**
   * 结算（汇付 D1 自动结算，无需主动提交；本地占位与 tianque/wechat-direct 保持一致）。
   * 注：交易链路（下单/查单/退款）已统一为 V3 聚合正扫接口，汇付不提供 V3 主动结算接口。
   */
  async submitSettlement(input: { billId: string; amountFen: number }): Promise<{ reference: string }> {
    return { reference: `huifu_settlement_${input.billId.slice(0, 8)}` };
  }

  /**
   * 汇付商户绑定微信小程序 APPID（V2 微信商户配置接口）。
   *
   * 【直连商户模式】
   * - 调用身份：sys_id = data.huifu_id = 目标商户自身（优先使用该商户在档案中的开发参数，
   *   未配置档案时回退全局 env 单商户配置）。
   * - 报文规则：与 SPIN 交易接口不同，data 必须是 JSON 对象（非字符串），只对 data
   *   第一层字段按 ASCII 排序后的紧凑 JSON 加签；req_date 为北京时间。
   * - fee_type 是商户已开通的微信业务费率类型（02=标准费率线下）。
   * - 绑定不可撤销，必须通过商户档案或 HUIFU_WECHAT_FEE_TYPE 显式配置汇付确认的实际开通值。
   */
  async bindAppletAppId(huifuId: string, appletAppId: string): Promise<{ applyNo?: string; note: string }> {
    const credential = await this.resolveCredential(huifuId);
    // 直连模式身份硬校验：sys_id 必须与目标商户一致，从代码层杜绝混搭身份
    if (credential.sysId !== huifuId) {
      return {
        note: `直连模式要求 sys_id(${credential.sysId}) 与 data.huifu_id(${huifuId}) 一致；` +
          `若该商户归属渠道，请使用渠道自身的 sys_id/product_id/私钥调用（当前部署不支持混搭身份）`,
      };
    }
    const now = new Date();
    const feeType = String(credential.feeType || process.env.HUIFU_WECHAT_FEE_TYPE || '').trim();
    if (!/^(0[1-9])$/.test(feeType)) {
      return { note: '未配置汇付确认的微信业务开通类型（商户档案 fee_type 或 HUIFU_WECHAT_FEE_TYPE），APPID 已保存但未提交绑定' };
    }
    const data: Record<string, string> = {
      req_seq_id: `bind${now.getTime().toString().slice(-16)}`,
      req_date: iso8(now),
      huifu_id: huifuId,
      fee_type: feeType,
      wx_applet_app_id: appletAppId,
    };
    const sortedData = this.sortTopLevel(data);
    const payload = JSON.stringify({
      sys_id: credential.sysId,
      product_id: credential.productId,
      data,
      sign: this.signWithKey(JSON.stringify(sortedData), credential.privateKey),
    });
    let response: Response;
    try {
      response = await fetch(this.apiUrl('/v2/merchant/busi/config'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      return { note: '汇付绑定接口暂时无法连接，APPID 已保存，请稍后重试' };
    }
    const text = await response.text();
    if (!text) {
      return { note: `汇付绑定接口返回空响应（HTTP ${response.status}），APPID 已保存，请稍后重试` };
    }
    try {
      const outer = JSON.parse(text) as HuifuApiResponse;
      const inner = this.innerData(outer);
      const applyNo = this.optionalResponseString(inner, 'apply_no', 32) || undefined;
      const respCode = String(inner.resp_code || outer.resp_code || '');
      const respDesc = this.optionalResponseString(inner, 'resp_desc', 256)
        || this.optionalResponseString(inner, 'sub_resp_desc', 256)
        || this.optionalResponseString(outer, 'resp_desc', 256)
        || '';
      if (response.ok && (respCode === '00000000' || respCode === '000000' || respCode === '0000')) {
        return { applyNo, note: '绑定申请已提交' + (applyNo ? `（申请单号 ${applyNo}）` : '') };
      }
      // 20002 数据权限认证失败：给出可操作的排查提示
      if (respCode === '20002') {
        return {
          note: `绑定未完成（20002 数据权限认证失败）：商户信息校验未通过。` +
            `请求身份为直连（sys_id=huifu_id=${huifuId}, product_id=${credential.productId}）。` +
            `请依次核查：① 该商户在汇付侧是否允许直连身份调用 busi/config（upper_huifu_id 是否非空、是否需要渠道身份）；` +
            `② 微信小程序支付是否已入驻开通（pay_scene=3）且 fee_type=${feeType} 与入驻记录一致；` +
            `③ ${credential.productId} 是否可用于本接口；确认后仍失败请携 req_seq_id 提交汇付工单。`,
        };
      }
      return { note: `绑定未完成${respCode ? `（${respCode}）` : ''}：${respDesc || `汇付网关 HTTP ${response.status}`}` };
    } catch {
      return { note: `汇付绑定接口响应格式异常（HTTP ${response.status}），APPID 已保存，请稍后重试` };
    }
  }

  /**
   * 查询汇付商户申请单审核状态（V2 申请单状态查询接口）。
   * 直连模式：sys_id = huifu_id = 目标商户自身（优先商户档案凭据）。
   * 返回 applyStatus：Y 审核通过 / P 审核中 / N 审核拒绝 / F 系统处理失败。
   */
  async queryBindStatus(huifuId: string, applyNo: string): Promise<{ applyNo: string; applyStatus: string; note: string; checkedAt: string }> {
    const checkedAt = new Date().toISOString();
    const credential = await this.resolveCredential(huifuId);
    if (credential.sysId !== huifuId) {
      return { applyNo, applyStatus: '', note: `直连模式要求 sys_id(${credential.sysId}) 与查询商户(${huifuId})一致`, checkedAt };
    }
    if (!applyNo) {
      return { applyNo, applyStatus: '', note: '尚无汇付申请单号（保存绑定后自动生成）', checkedAt };
    }
    const now = new Date();
    const data: Record<string, string> = {
      req_seq_id: `apply${now.getTime().toString().slice(-16)}`,
      req_date: iso8(now),
      huifu_id: huifuId,
      apply_no: applyNo,
    };
    const sortedData = this.sortTopLevel(data);
    const payload = JSON.stringify({
      sys_id: credential.sysId,
      product_id: credential.productId,
      data,
      sign: this.signWithKey(JSON.stringify(sortedData), credential.privateKey),
    });
    let text: string;
    let response: Response | null = null;
    try {
      response = await fetch(this.apiUrl('/v2/merchant/basicdata/status/query'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
        signal: AbortSignal.timeout(20_000),
      });
      text = await response.text();
    } catch {
      return { applyNo, applyStatus: '', note: '汇付状态查询暂时无法连接，请稍后重试', checkedAt };
    }
    if (!text) {
      // HTTP 922 = 阿里云盾 WAF 拦截（空响应体），非报文问题，提示汇付侧排查
      return { applyNo, applyStatus: '', note: `汇付网关拦截请求（HTTP ${response.status}，空响应），疑似汇付侧安全策略变更，请稍后重试或联系汇付排查`, checkedAt };
    }
    try {
      const outer = JSON.parse(text) as HuifuApiResponse;
      const inner = this.innerData(outer);
      const respCode = String(inner.resp_code || outer.resp_code || '');
      if (respCode && respCode !== '00000000') {
        return { applyNo, applyStatus: '', note: `汇付查询未成功（${respCode}）：${String(inner.resp_desc || outer.resp_desc || '')}`, checkedAt };
      }
      const applyStatus = String(inner.apply_status || '').trim();
      const statusText = applyStatus === 'Y' ? '已通过' : applyStatus === 'P' ? '审核中' : applyStatus === 'N' ? '已拒绝' : applyStatus === 'F' ? '处理失败' : '';
      // 微信配置结果：config_type=02 小程序配置；config_value S=成功/F=失败/B=部分成功
      let wxResult = '';
      try {
        const wxList = inner.wx_conf_result_list || inner.wx_config_list;
        const raw = typeof wxList === 'string' ? JSON.parse(wxList) : wxList;
        const arr = Array.isArray(raw) ? raw : [];
        const mini = arr.find((item: Record<string, unknown>) => String(item.config_type || item.configType || '') === '02')
          || arr.find((item: Record<string, unknown>) => String(item.config_type || item.configType || '') === '01');
        if (mini) {
          const stat = String(mini.config_value || mini.configStat || '');
          wxResult = stat === 'S' ? '，小程序配置已生效' : stat === 'F' ? '，小程序配置失败' : stat === 'B' ? '，小程序配置部分成功' : '';
        }
      } catch { /* 微信配置字段缺失时忽略 */ }
      const note = statusText ? `审核状态：${statusText}${wxResult}` : '申请单状态未知';
      return { applyNo, applyStatus, note, checkedAt };
    } catch {
      return { applyNo, applyStatus: '', note: `汇付状态查询响应格式异常（HTTP ${response.status}）：${text.slice(0, 120)}`, checkedAt };
    }
  }

  // ==========================================================================
  // 内部方法
  // ==========================================================================

  /**
   * V3 交易接口请求（api.huifu.com/v3/trade/*）：data 为 JSON 对象，仅对 data 排序后紧凑 JSON 加签（V2 协议规范），
   * 公共参数 sys_id/product_id/sign/data 全在 body。用于聚合正扫下单/查单/退款等 V3 交易接口。
   * 管理接口（/v2/merchant/* 绑定/状态查询）同样用本方法（报文格式一致）。
   */
  private async v2Request(path: string, data: Record<string, string>, credential: HuifuCredential): Promise<HuifuApiResponse> {
    const url = this.apiUrl(path);
    const payload = JSON.stringify({
      sys_id: credential.sysId,
      product_id: credential.productId,
      data,
      sign: this.signWithKey(JSON.stringify(this.sortTopLevel(data)), credential.privateKey),
    });
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      throw new ServiceUnavailableException('暂时无法连接汇付天下支付网关，请稍后重试');
    }
    const text = await response.text();
    if (text.length > 512 * 1024) throw new BadGatewayException('汇付天下支付网关响应数据过大');
    let value: HuifuApiResponse;
    try { value = JSON.parse(text) as HuifuApiResponse; }
    catch {
      // 空响应 / 非 JSON：多为网关层拦截（阿里云盾 HTTP 922）或网络中间件响应，非报文问题
      throw new BadGatewayException(
        text ? `汇付天下支付网关响应格式异常（HTTP ${response.status}）：${text.slice(0, 120)}`
          : `汇付天下支付网关请求被拦截（HTTP ${response.status}，空响应），疑似网关安全策略变更，请稍后重试或联系汇付排查`,
      );
    }
    if (!response.ok) {
      throw new BadGatewayException(`汇付天下支付网关请求失败（HTTP ${response.status}）：${String(value.resp_desc || '未知错误')}`);
    }
    // 同步响应验签（有 sign 时按 V2 规则：data 对象排序紧凑 JSON）
    const respSign = String(value.sign || value.resp_sign || '').trim();
    if (respSign) {
      const rawData = value.data;
      let signPayload = '';
      if (rawData && typeof rawData === 'object' && !Array.isArray(rawData)) {
        signPayload = JSON.stringify(this.sortTopLevel(rawData as Record<string, string>));
      } else if (typeof rawData === 'string' && rawData) {
        signPayload = rawData;
      }
      if (signPayload) {
        try { this.verifySignature(signPayload, respSign, credential.publicKey); }
        catch { throw new BadGatewayException('汇付天下支付网关响应验签失败'); }
      }
    }
    return this.innerData(value);
  }

  /** 从汇付响应外层取业务 data；资金解冻通知使用 resp_data。 */
  private innerData(value: HuifuApiResponse): HuifuApiResponse {
    return this.callbackPayload(value).value;
  }

  /**
   * 解析回调业务载荷，并保留签名前的原始字符串。
   * 官方解冻通知明确使用 resp_data；普通交易仍使用 data。
   */
  private callbackPayload(value: HuifuApiResponse): { value: HuifuApiResponse; signaturePayload: string; source: 'data' | 'resp_data' | 'outer' } {
    const source = value.data !== undefined ? 'data' : value.resp_data !== undefined ? 'resp_data' : 'outer';
    const raw = source === 'data' ? value.data : source === 'resp_data' ? value.resp_data : value;
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      return { value: raw as HuifuApiResponse, signaturePayload: JSON.stringify(raw), source };
    }
    if (typeof raw !== 'string' || !raw) {
      return { value, signaturePayload: JSON.stringify(value), source };
    }
    try { return { value: JSON.parse(raw) as HuifuApiResponse, signaturePayload: raw, source }; }
    catch { throw new BadGatewayException('汇付天下支付网关 data/resp_data 字段不是有效 JSON'); }
  }

  /** 汇付 V2 签名只排序 data 第一层，嵌套值保持原值。 */
  private sortTopLevel(data: Record<string, string>): Record<string, string> {
    return Object.fromEntries(Object.keys(data).sort().map((key) => [key, data[key]]));
  }

  /** RSA-SHA256 签名（用解析到的商户凭据私钥）。 */
  private signWithKey(payload: string, privateKey: string): string {
    try {
      const signer = createSign('RSA-SHA256');
      signer.update(payload, 'utf8');
      return signer.sign(privateKey, 'base64');
    } catch {
      throw new ServiceUnavailableException('支付签名服务暂不可用');
    }
  }

  /** RSA-SHA256 验签（用对应商户的汇付公钥）。 */
  private verifySignature(payload: string, signature: string, publicKey: string): void {
    if (!signature || signature.length > 8192) throw new ServiceUnavailableException('汇付回调签名缺失或过长');
    if (!publicKey) throw new ServiceUnavailableException('汇付回调验签公钥未配置');
    try {
      const verifier = createVerify('RSA-SHA256');
      verifier.update(payload, 'utf8');
      if (!verifier.verify(publicKey, signature, 'base64')) throw new Error('签名不匹配');
    } catch {
      throw new ServiceUnavailableException('汇付回调验签失败');
    }
  }

  /** 格式化裸 Base64 密钥。汇付下发私钥是 PKCS#8，公钥是 X.509 SubjectPublicKeyInfo。 */
  private formatPem(key: string, kind: 'private' | 'public'): string {
    const trimmed = key.trim();
    if (trimmed.startsWith('-----BEGIN')) return trimmed;
    const label = kind === 'private' ? 'PRIVATE KEY' : 'PUBLIC KEY';
    const chunks = trimmed.match(/.{1,64}/g) || [];
    return `-----BEGIN ${label}-----\n${chunks.join('\n')}\n-----END ${label}-----`;
  }

  private apiUrl(path: string): string {
    const url = new URL(path, this.baseUrl);
    if (url.protocol !== 'https:' && process.env.NODE_ENV === 'production') {
      throw new ServiceUnavailableException('汇付天下生产环境必须使用 HTTPS');
    }
    return url.toString();
  }

  private responseString(value: HuifuApiResponse, field: string, minLength: number, maxLength: number): string {
    const result = value[field];
    if (typeof result !== 'string' || result.length < minLength || result.length > maxLength) {
      throw new BadGatewayException(`汇付天下支付网关响应字段 ${field} 不合法`);
    }
    return result;
  }

  private optionalResponseString(value: HuifuApiResponse, field: string, maxLength: number): string | null {
    const result = value[field];
    if (result === undefined || result === null || result === '') return null;
    if (typeof result !== 'string' || result.length > maxLength) {
      throw new BadGatewayException(`Huifu response field ${field} is invalid`);
    }
    return result;
  }

  private requiredEventId(value: HuifuApiResponse, fallback: string): string {
    return String(value.hf_seq_id || value.trans_id || fallback);
  }

  private requireProviderMerchantId(value: string | null | undefined): string {
    if (!value || !/^[A-Za-z0-9_-]{6,64}$/.test(value)) {
      throw new ServiceUnavailableException('该商家的汇付收款档案尚未启用');
    }
    return value;
  }

  private yuanToFen(value: string): number {
    const parsed = parseFloat(value);
    if (!Number.isFinite(parsed) || parsed <= 0) throw new BadGatewayException('汇付天下支付网关返回金额不合法');
    const fen = Math.round(parsed * 100);
    if (!Number.isSafeInteger(fen)) throw new BadGatewayException('汇付天下支付网关返回金额超出范围');
    return fen;
  }

  private yuanToFenAllowZero(value: string): number {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0) throw new BadGatewayException('汇付天下支付网关返回解冻金额不合法');
    const fen = Math.round(parsed * 100);
    if (!Number.isSafeInteger(fen)) throw new BadGatewayException('汇付天下支付网关返回解冻金额超出范围');
    return fen;
  }

  private parseHuifuTime(value: string | null): Date | null {
    if (!value) return null;
    if (!/^\d{14}$/.test(value)) throw new BadGatewayException('汇付天下支付网关返回时间不合法');
    const year = Number(value.slice(0, 4));
    const month = Number(value.slice(4, 6));
    const day = Number(value.slice(6, 8));
    const hour = Number(value.slice(8, 10));
    const minute = Number(value.slice(10, 12));
    const second = Number(value.slice(12, 14));
    const date = new Date(Date.UTC(year, month - 1, day, hour - 8, minute, second));
    const checked = beijingTime(date);
    if (checked.year !== year || checked.month !== month || checked.day !== day || checked.hour !== hour || checked.minute !== minute || checked.second !== second) {
      throw new BadGatewayException('汇付天下支付网关返回时间不合法');
    }
    return date;
  }
}

/** 东八区（北京时间）时间格式——汇付要求标准北京时间，不能直接用 UTC */
function beijingTime(date: Date | string): { year: number; month: number; day: number; hour: number; minute: number; second: number } {
  const value = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(value.getTime())) throw new BadGatewayException('汇付时间参数不合法');
  const shifted = new Date(value.getTime() + 8 * 60 * 60 * 1000);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    second: shifted.getUTCSeconds(),
  };
}

function iso8(date: Date | string): string {
  const t = beijingTime(date);
  return `${t.year}${String(t.month).padStart(2, '0')}${String(t.day).padStart(2, '0')}`;
}

function iso14(date: Date): string {
  const t = beijingTime(date);
  return `${iso8(date)}${String(t.hour).padStart(2, '0')}${String(t.minute).padStart(2, '0')}${String(t.second).padStart(2, '0')}`;
}
