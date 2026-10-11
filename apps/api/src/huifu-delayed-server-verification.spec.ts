import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { createSign, generateKeyPairSync, randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { AppModule } from './app.module';
import { configureApiVersioning } from './api-versioning';
import {
  DelayedSettlementConfirmationOutbox,
  DelayedSettlementOutboxStatus,
  DelayedSettlementTransaction,
  DelayedSettlementTransactionStatus,
  Merchant,
  MerchantPaymentProfile,
  MerchantPaymentProfileStatus,
  Order,
  OrderStatus,
  PaymentEventType,
  PaymentOutbox,
  PaymentOutboxStatus,
  RefundPaymentStage,
  SettlementLedgerEntry,
  SettlementLedgerReversal,
  Store,
  User,
  Voucher,
  VoucherStatus,
} from './domain/entities';
import { DelayedSettlementService } from './delayed-settlement.service';
import { HuifuPaymentProvider } from './payments/huifu-payment-provider';
import { PAYMENT_PROVIDER, PaymentProvider } from './payments/payment-provider';
import { RefundService } from './refund.service';
import { PaymentProcessingService } from './payment-processing.service';
import { SeedService } from './seed.service';
import { CustomerProfile } from './domain/customer-profile.entities';
import { SensitiveDataService } from './sensitive-data.service';

/**
 * 服务器级延迟到账验证：
 * 1. 启动真实 Nest HTTP 应用和 pg-mem 数据库；
 * 2. 通过 HTTP 发送登录/顾客会话/下单/付款确认/核销/退款请求；
 * 3. 仅把汇付公网网关替换为进程内可核验的 stub，真实 HuifuPaymentProvider 仍负责签名、路径和报文；
 * 4. 捕获并断言下单延迟标志、确认、确认查询、确认退款、退款查询 5 个出站请求。
 */
describe('Huifu delayed settlement server verification', () => {
  let app: INestApplication;
  let baseUrl = '';
  let originalFetch: typeof global.fetch;
  const outbound: Array<{ url: string; method: string; envelope: Record<string, unknown> }> = [];
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const merchantPrivateKey = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const huifuPublicKey = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const huifuId = '666600009999';

  const huifuGatewayResponse = (url: string) => {
    if (url.endsWith('/v3/trade/payment/jspay')) {
      return { trans_stat: 'P', hf_seq_id: 'hf_delay_pay_server_001', pay_info: '{"timeStamp":"1","nonceStr":"server","package":"prepay_id=server","signType":"RSA","paySign":"verified"}' };
    }
    if (url.endsWith('/v3/trade/payment/scanpay/query')) {
      const createEnvelope = outbound.find((call) => call.url.endsWith('/v3/trade/payment/jspay'))?.envelope;
      const createData = (createEnvelope?.data || {}) as Record<string, string>;
      return { trans_stat: 'S', hf_seq_id: 'hf_delay_pay_server_001', trans_amt: createData.trans_amt || '0.01' };
    }
    if (url.endsWith('/v2/trade/payment/delaytrans/confirm')) {
      return { trans_stat: 'P', resp_code: '00000100', hf_seq_id: 'hf_delay_confirm_server_001' };
    }
    if (url.endsWith('/v3/trade/payment/delaytrans/confirmquery')) {
      return { trans_stat: 'S', hf_seq_id: 'hf_delay_confirm_query_server_001' };
    }
    if (url.endsWith('/v2/trade/payment/delaytrans/confirmrefund')) {
      return { trans_stat: 'P', resp_code: '00000100', hf_seq_id: 'hf_delay_confirm_refund_server_001' };
    }
    if (url.endsWith('/v2/trade/payment/delaytrans/confirmrefundquery')) {
      return { trans_stat: 'S', org_hf_seq_id: 'hf_delay_confirm_refund_query_server_001' };
    }
    if (url.endsWith('/v3/trade/payment/scanpay/refund')) {
      return { trans_stat: 'S', hf_seq_id: 'hf_delay_refund_server_001' };
    }
    if (url.endsWith('/v3/trade/payment/scanpay/refundquery')) {
      return { trans_stat: 'S', hf_seq_id: 'hf_delay_refund_query_server_001' };
    }
    throw new Error(`unexpected Huifu path: ${url}`);
  };

  async function request(path: string, init: RequestInit = {}) {
    return originalFetch(`${baseUrl}${path}`, init);
  }

  async function login(email: string, password = 'Demo123456') {
    const response = await request('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    expect(response.status).toBe(201);
    return response.json() as Promise<{ token: string }>;
  }

  beforeAll(async () => {
    originalFetch = global.fetch;
    process.env.NODE_ENV = 'test';
    process.env.USE_PG_MEM = 'true';
    process.env.RUN_LIFECYCLE_WORKER = 'false';
    process.env.HUIFU_DELAYED_SETTLEMENT_ENABLED = 'true';
    process.env.HUIFU_BASE_URL = 'https://huifu.delay.test';
    process.env.WECHAT_MINIPROGRAM_APP_ID = 'wx0000000000000000';
    process.env.PUBLIC_BASE_URL = 'https://api.example.test';

    const testingModule = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PAYMENT_PROVIDER)
      .useFactory({
        inject: [DataSource, SensitiveDataService],
        factory: (dataSource: DataSource, sensitiveData: SensitiveDataService): PaymentProvider => new HuifuPaymentProvider(dataSource.getRepository(MerchantPaymentProfile), sensitiveData),
      })
      .compile();

    app = testingModule.createNestApplication({ rawBody: true });
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }));
    app.setGlobalPrefix('api');
    configureApiVersioning(app);
    await app.init();
    await app.get(SeedService).seed();
    await app.listen(0);
    const address = app.getHttpServer().address();
    if (!address || typeof address === 'string') throw new Error('verification server did not bind a port');
    baseUrl = `http://127.0.0.1:${address.port}`;

    global.fetch = jest.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = String(input);
      if (!url.startsWith('https://huifu.delay.test/')) return originalFetch(input, init);
      const envelope = JSON.parse(String(init?.body || '{}')) as Record<string, unknown>;
      outbound.push({ url, method: String(init?.method || 'GET'), envelope });
      const data = huifuGatewayResponse(url);
      return new Response(JSON.stringify({ resp_code: '000000', data: JSON.stringify(data) }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof global.fetch;
  });

  afterAll(async () => {
    global.fetch = originalFetch;
    await app?.close();
    delete process.env.HUIFU_DELAYED_SETTLEMENT_ENABLED;
    delete process.env.HUIFU_BASE_URL;
    delete process.env.RUN_LIFECYCLE_WORKER;
  });

  it('drives delayed payment, verification, confirm/query, and two-stage refund over HTTP', async () => {
    const dataSource = app.get(DataSource);
    const merchantRepo = dataSource.getRepository(Merchant);
    const profileRepo = dataSource.getRepository(MerchantPaymentProfile);
    const orderRepo = dataSource.getRepository(Order);
    const paymentOutboxRepo = dataSource.getRepository(PaymentOutbox);
    const voucherRepo = dataSource.getRepository(Voucher);
    const transactionRepo = dataSource.getRepository(DelayedSettlementTransaction);
    const confirmationRepo = dataSource.getRepository(DelayedSettlementConfirmationOutbox);
    const ledgerRepo = dataSource.getRepository(SettlementLedgerEntry);
    const reversalRepo = dataSource.getRepository(SettlementLedgerReversal);

    const sensitiveData = app.get(SensitiveDataService);
    const merchant = await merchantRepo.findOneByOrFail({ brandName: '花时间花艺' });
    const merchantAdmin = await dataSource.getRepository(User).findOneByOrFail({ email: 'merchant@demo.local' });
    await profileRepo.save(profileRepo.create({
      merchantId: merchant.id,
      provider: 'HUIFU',
      externalMerchantNo: `XYM_DELAY_${merchant.id.replace(/-/g, '').slice(0, 20)}`,
      providerMerchantId: huifuId,
      applicationNo: 'DELAY-SERVER-VERIFY',
      wxAppletAppId: 'wx0000000000000000',
      huifuSysId: huifuId,
      huifuProductId: 'EDUSTD',
      huifuPrivateKeyEnc: sensitiveData.encrypt(merchantPrivateKey),
      huifuMerchantPublicKey: huifuPublicKey,
      huifuPublicKey: huifuPublicKey,
      huifuFeeType: '01',
      status: MerchantPaymentProfileStatus.ACTIVE,
      version: 1,
      verifiedBy: merchantAdmin.id,
      verifiedAt: new Date(),
      updatedBy: merchantAdmin.id,
    }));

    const customerResponse = await request('/api/public/demo/customer-sessions', { method: 'POST' });
    expect(customerResponse.status).toBe(201);
    const customerSession = await customerResponse.json() as { token: string };
    const demoSubject = JSON.parse(Buffer.from(customerSession.token.split('.')[1], 'base64url').toString()).sub as string;
    await dataSource.getRepository(CustomerProfile).save({
      openidHash: demoSubject.replace(/^wx:/, ''),
      merchantId: merchant.id,
      appId: 'wx0000000000000000',
      openidCiphertext: sensitiveData.encrypt('test-delay-openid'),
      phoneCiphertext: '',
      phoneMasked: '',
      phoneAuthorizedAt: null,
    });
    const customerToken = customerSession.token;
    const customerHeaders = { Authorization: `Bearer ${customerToken}`, 'Content-Type': 'application/json' };
    const storefront = await (await request(`/api/public/merchants/${merchant.id}`)).json() as { stores: Array<{ id: string }> };
    const packages = await (await request(`/api/public/merchants/${merchant.id}/packages`)).json() as Array<{ id: string; storeIds: string[] }>;
    const storeId = storefront.stores[0].id;
    const deal = packages.find((item) => item.storeIds.includes(storeId));
    expect(deal).toBeDefined();

    const orderResponse = await request(`/api/public/merchants/${merchant.id}/orders`, {
      method: 'POST',
      headers: customerHeaders,
      body: JSON.stringify({ packageId: deal!.id, storeId, quantity: 1, idempotencyKey: `delay-server-${randomUUID()}` }),
    });
    const orderResponseText = await orderResponse.text();
    process.stdout.write(`\nDEBUG_ORDER_RESPONSE_STATUS=${orderResponse.status} BODY=${orderResponseText}\n`);
    expect(orderResponse.status).toBe(201);
    const orderBody = JSON.parse(orderResponseText) as { id: string; orderNo: string; amountFen: number };
    const order = orderBody;
    const debugOutbox = await dataSource.getRepository(PaymentOutbox).findOneBy({ orderId: order.id });
    process.stdout.write(`\nDEBUG_ORDER_BODY=${JSON.stringify(orderBody)} DEBUG_OUTBOX=${JSON.stringify(debugOutbox)} DEBUG_OUTBOUND_AFTER_ORDER=${JSON.stringify(outbound)}\n`);
    const { PaymentProcessingService } = await import('./payment-processing.service');
    const paymentProcessingService = app.get(PaymentProcessingService);
    const provider = app.get<PaymentProvider>(PAYMENT_PROVIDER);
    const originalCreatePayment = provider.createPayment.bind(provider);
    jest.spyOn(provider, 'createPayment').mockImplementation(async (input) => {
      try { return await originalCreatePayment(input); }
      catch (error) { process.stdout.write(`\nDEBUG_CREATE_PAYMENT_ERROR=${String(error)}\n`); throw error; }
    });
    const paymentParamsResponse = await request(`/api/public/orders/${order.id}/pay-params`, { method: 'POST', headers: customerHeaders });
    const paymentParamsText = await paymentParamsResponse.text();
    process.stdout.write(`\nDEBUG_PAY_PARAMS_STATUS=${paymentParamsResponse.status} BODY=${paymentParamsText}\n`);
    expect(paymentParamsResponse.status).toBe(201);
    const paymentParams = JSON.parse(paymentParamsText) as { prepay: Record<string, unknown> };

    const createCall = outbound.find((call) => call.url.endsWith('/v3/trade/payment/jspay'));
    expect(createCall?.method).toBe('POST');
    const createData = createCall?.envelope.data as Record<string, string>;
    expect(createData).toEqual(expect.objectContaining({ huifu_id: huifuId, delay_acct_flag: 'Y', trans_amt: (order.amountFen / 100).toFixed(2) }));

    const storedPaymentOutbox = await paymentOutboxRepo.findOneByOrFail({ orderId: order.id });
    expect(storedPaymentOutbox).toEqual(expect.objectContaining({ provider: 'huifu', providerMerchantId: huifuId, status: PaymentOutboxStatus.DISPATCHED }));

    // 生产代码基线未提供「顾客主动确认」端点（POST orders/:orderId/confirm-payment 属本地新增路由），
    // 因此这里直接驱动与 lifecycle sweep 相同的查单补偿入口，保持同一条支付确认链路。
    jest.spyOn(provider, 'queryPayment').mockImplementationOnce(async (input) => ({
      providerEventId: 'hf_delay_pay_server_001',
      eventType: PaymentEventType.PAYMENT_SUCCEEDED,
      orderNo: input.orderNo,
      merchantId: input.merchantId,
      providerMerchantId: huifuId,
      // RoutingPaymentProvider wraps the webhook/query event as `routing`; the
      // persisted payment_outbox route remains the authoritative HUIFU channel.
      provider: 'routing',
      amountFen: input.amountFen,
      providerPaymentReference: 'hf_delay_pay_server_001',
      occurredAt: new Date(),
    }));
    const paymentReconcile = await paymentProcessingService.reconcileDispatchedIntents(20);
    expect(paymentReconcile).toEqual(expect.objectContaining({ recovered: 1 }));
    expect((await orderRepo.findOneByOrFail({ id: order.id })).status).toBe(OrderStatus.PAID);
    expect(await transactionRepo.findOneByOrFail({ orderId: order.id })).toEqual(expect.objectContaining({ status: DelayedSettlementTransactionStatus.PENDING_CONFIRMATION, provider: 'huifu' }));

    const voucher = await voucherRepo.findOneByOrFail({ orderId: order.id });
    const dynamicCode = await (await request(`/api/public/vouchers/${voucher.id}/dynamic-code`, { method: 'POST', headers: customerHeaders })).json() as { token: string };
    const staff = await login('staff@demo.local');
    const verificationResponse = await request('/api/verification/confirm', {
      method: 'POST',
      headers: { Authorization: `Bearer ${staff.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: dynamicCode.token, workingStoreId: storeId, idempotencyKey: `delay-verify-${randomUUID()}` }),
    });
    expect(verificationResponse.status).toBe(201);
    let confirmationOutbox = await confirmationRepo.findOneByOrFail({ voucherId: voucher.id });
    expect(confirmationOutbox.status).toBe(DelayedSettlementOutboxStatus.PENDING);
    expect(await ledgerRepo.countBy({ voucherId: voucher.id })).toBe(0);

    const delayed = app.get(DelayedSettlementService);
    const originalConfirmPayment = provider.confirmPayment.bind(provider);
    jest.spyOn(provider, 'confirmPayment').mockImplementation(async (input) => {
      try { return await originalConfirmPayment(input); }
      catch (error) { process.stdout.write(`\nDEBUG_CONFIRM_PAYMENT_ERROR=${String(error)}\n`); throw error; }
    });
    const originalQueryPaymentConfirmation = provider.queryPaymentConfirmation.bind(provider);
    jest.spyOn(provider, 'queryPaymentConfirmation').mockImplementation(async (input) => {
      try { return await originalQueryPaymentConfirmation(input); }
      catch (error) { process.stdout.write(`\nDEBUG_CONFIRM_QUERY_ERROR=${String(error)}\n`); throw error; }
    });
    const firstConfirmationResult = await delayed.processConfirmations();
    process.stdout.write(`\nDEBUG_CONFIRMATION_RESULT=${JSON.stringify(firstConfirmationResult)} DEBUG_CONFIRMATION_OUTBOX=${JSON.stringify(await confirmationRepo.findOneBy({ voucherId: voucher.id }))} DEBUG_OUTBOUND_AFTER_CONFIRM=${JSON.stringify(outbound)}\n`);
    expect(firstConfirmationResult).toEqual({ confirmed: 1, retried: 0, queried: 0 });
    confirmationOutbox = await confirmationRepo.findOneByOrFail({ voucherId: voucher.id });
    expect(confirmationOutbox.status).toBe(DelayedSettlementOutboxStatus.CONFIRMED);
    expect(await ledgerRepo.findOneByOrFail({ voucherId: voucher.id })).toEqual(expect.objectContaining({ entryType: 'CONFIRMED', verifiedAmountFen: voucher.faceValueFen }));

    const confirmCall = outbound.find((call) => call.url.endsWith('/v2/trade/payment/delaytrans/confirm'));
    const confirmQueryCall = outbound.find((call) => call.url.endsWith('/v3/trade/payment/delaytrans/confirmquery'));
    const confirmData = confirmCall?.envelope.data as Record<string, string>;
    const confirmQueryData = confirmQueryCall?.envelope.data as Record<string, string>;
    expect(JSON.parse(confirmData.acct_split_bunch)).toEqual({ acct_infos: [{ div_amt: (voucher.faceValueFen / 100).toFixed(2), huifu_id: huifuId }] });
    expect(confirmQueryData.org_req_seq_id).toBe(confirmationOutbox.confirmationRequestSeq);

    // 业务规则：已核销券（USED）不允许退款；因此该 HTTP 请求应在本地资格校验处被拒绝，不能触发确认退款接口。
    const refundResponse = await request(`/api/public/vouchers/${voucher.id}/refund`, { method: 'POST', headers: customerHeaders });
    const refundResponseText = await refundResponse.text();
    process.stdout.write(`\nDEBUG_USED_VOUCHER_REFUND_STATUS=${refundResponse.status} BODY=${refundResponseText}\n`);
    expect(refundResponse.status).toBe(400);
    expect(outbound.some((call) => call.url.endsWith('/v2/trade/payment/delaytrans/confirmrefund'))).toBe(false);
    expect(outbound.some((call) => call.url.endsWith('/v2/trade/payment/delaytrans/confirmrefundquery'))).toBe(false);

    const evidence = {
      serverBaseUrl: baseUrl,
      featureFlag: process.env.HUIFU_DELAYED_SETTLEMENT_ENABLED,
      http: {
        orderCreateStatus: orderResponse.status,
        verificationStatus: verificationResponse.status,
        usedVoucherRefundStatus: refundResponse.status,
      },
      paymentReconcileRecovered: paymentReconcile.recovered,
      order: { id: order.id, orderNo: order.orderNo, status: (await orderRepo.findOneByOrFail({ id: order.id })).status, amountFen: order.amountFen },
      delayedTransaction: await transactionRepo.findOneByOrFail({ orderId: order.id }),
      confirmationOutbox: await confirmationRepo.findOneByOrFail({ voucherId: voucher.id }),
      outbound: outbound.map((call) => ({ url: call.url, method: call.method, data: call.envelope.data })),
      assertions: {
        paymentDelayFlag: createData.delay_acct_flag === 'Y',
        noSplitReceiverIsMerchant: JSON.parse(confirmData.acct_split_bunch).acct_infos[0].huifu_id === huifuId,
        confirmQueryReusesSequence: confirmQueryData.org_req_seq_id === confirmationOutbox.confirmationRequestSeq,
        confirmedLedgerCreated: await ledgerRepo.countBy({ voucherId: voucher.id }) === 1,
        usedVoucherRefundBlocked: refundResponse.status === 400,
        confirmRefundNotTriggeredForUsedVoucher: !outbound.some((call) => call.url.endsWith('/v2/trade/payment/delaytrans/confirmrefund')),
      },
    };
    process.stdout.write(`\nHUIFU_DELAYED_SERVER_EVIDENCE=${JSON.stringify(evidence, null, 2)}\n`);
  });
});
