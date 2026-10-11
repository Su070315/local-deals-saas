import { createSign, createVerify, generateKeyPairSync } from 'crypto';
import { PaymentEventType } from '../domain/entities';
import { HuifuPaymentProvider } from './huifu-payment-provider';

describe('HuifuPaymentProvider merchant routing', () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const environment = ['HUIFU_BASE_URL', 'HUIFU_SYS_ID', 'HUIFU_PRODUCT_ID', 'HUIFU_ISV_PRIVATE_KEY', 'HUIFU_PUBLIC_KEY', 'HUIFU_WECHAT_FEE_TYPE', 'HUIFU_DELAYED_SETTLEMENT_ENABLED', 'PUBLIC_BASE_URL', 'WECHAT_MINIPROGRAM_APP_ID'] as const;
  const previous = Object.fromEntries(environment.map((name) => [name, process.env[name]]));

  beforeEach(() => {
    process.env.HUIFU_BASE_URL = 'https://huifu.example.test';
    process.env.HUIFU_SYS_ID = '666600009999';
    process.env.HUIFU_PRODUCT_ID = 'EDUSTD';
    process.env.HUIFU_ISV_PRIVATE_KEY = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    process.env.HUIFU_PUBLIC_KEY = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    process.env.HUIFU_WECHAT_FEE_TYPE = '01';
    process.env.PUBLIC_BASE_URL = 'https://api.example.test';
    process.env.WECHAT_MINIPROGRAM_APP_ID = 'wx_test_appid_0001';
    delete process.env.HUIFU_DELAYED_SETTLEMENT_ENABLED;
  });

  afterEach(() => { jest.restoreAllMocks(); });
  afterAll(() => {
    for (const name of environment) {
      const value = previous[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  const intent = { orderId: '01234567-0000-0000-0000-000000000000', orderNo: 'DG202607190123456789ABCDEF', merchantId: 'abcdef12-0000-0000-0000-000000000000', amountFen: 3990, expiresAt: new Date(Date.now() + 15 * 60_000), idempotencyKey: 'payment-key-0001', paymentProfileId: '11111111-0000-4000-8000-000000000000', providerMerchantId: '666600009999', customerOpenid: 'oX_test_openid_0001' };

  it('sends the V3 object envelope with the order merchant Huifu ID and customer openid on payment', async () => {
    const fetchMock = jest.spyOn(global, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/refund')) return new Response(JSON.stringify({ resp_code: '000000', data: JSON.stringify({ hf_seq_id: 'refund_12345678' }) }), { status: 200 });
      if (url.includes('/query')) return new Response(JSON.stringify({ resp_code: '000000', data: JSON.stringify({ hf_seq_id: 'trans_12345678', trans_stat: 'S', trans_amt: '39.90' }) }), { status: 200 });
      return new Response(JSON.stringify({ resp_code: '000000', data: JSON.stringify({ hf_seq_id: 'trans_12345678', trans_stat: 'S', trans_amt: '39.90', pay_info: '{"timeStamp":"1","nonceStr":"a","package":"prepay_id=x","signType":"RSA","paySign":"y"}' }) }), { status: 200 });
    });
    const provider = new HuifuPaymentProvider({} as never, {} as never);

    const created = await provider.createPayment(intent);
    await provider.queryPayment({ ...intent, paymentReference: 'trans_12345678' });
    await provider.refund({ voucherId: '22222222-0000-4000-8000-000000000000', orderId: intent.orderId, orderNo: intent.orderNo, amountFen: 3990, idempotencyKey: 'refund-key-0001', paymentProfileId: intent.paymentProfileId, providerMerchantId: intent.providerMerchantId });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(created.paymentReference).toBe('trans_12345678');
    expect(created.payInfo).toContain('prepay_id=x');

    const [, createInit] = fetchMock.mock.calls[0];
    const envelope = JSON.parse(String(createInit?.body)) as { sys_id?: string; product_id?: string; sign?: string; data?: Record<string, string> };
    expect(envelope.sys_id).toBe('666600009999');
    expect(envelope.product_id).toBe('EDUSTD');
    expect(typeof envelope.sign).toBe('string');
    expect(envelope.sign?.length).toBeGreaterThan(20);
    const data = envelope.data || {};
    expect(data.huifu_id).toBe('666600009999');
    expect(data.trade_type).toBe('T_MINIAPP');
    expect(data.req_seq_id).toBe('DG202607190123456789ABCDEF'.replace(/[^A-Za-z0-9]/g, '').slice(0, 32));
    expect(data.wx_data).toBe(JSON.stringify({ sub_appid: 'wx_test_appid_0001', sub_openid: 'oX_test_openid_0001' }));
  });

  it('adds delay settlement flag only when explicitly enabled', async () => {
    const fetchMock = jest.spyOn(global, 'fetch').mockImplementation(async () => new Response(JSON.stringify({
      resp_code: '000000',
      data: JSON.stringify({ hf_seq_id: 'delay_pay_12345678', trans_stat: 'P', pay_info: 'pay-info' }),
    }), { status: 200 }));
    const provider = new HuifuPaymentProvider({} as never, {} as never);

    await provider.createPayment(intent);
    let envelope = JSON.parse(String(fetchMock.mock.calls[0][1]?.body)) as { data: Record<string, string> };
    expect(envelope.data).not.toHaveProperty('delay_acct_flag');

    fetchMock.mockClear();
    process.env.HUIFU_DELAYED_SETTLEMENT_ENABLED = 'true';
    await provider.createPayment(intent);
    envelope = JSON.parse(String(fetchMock.mock.calls[0][1]?.body)) as { data: Record<string, string> };
    expect(envelope.data).toEqual(expect.objectContaining({
      delay_acct_flag: 'Y',
      trade_type: 'T_MINIAPP',
    }));
  });

  it('sends delay confirmation paths and stable split amount', async () => {
    process.env.HUIFU_DELAYED_SETTLEMENT_ENABLED = 'true';
    const fetchMock = jest.spyOn(global, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      const response = url.includes('confirmquery')
        ? { trans_stat: 'S', hf_seq_id: 'confirm_12345678' }
        : url.includes('confirmrefundquery')
          ? { trans_stat: 'S', hf_seq_id: 'confirm_refund_query_123' }
          : url.includes('confirmrefund')
            ? { trans_stat: 'S', hf_seq_id: 'confirm_refund_123456' }
            : { trans_stat: 'S', hf_seq_id: 'confirm_12345678' };
      return new Response(JSON.stringify({ resp_code: '000000', data: JSON.stringify(response) }), { status: 200 });
    });
    const provider = new HuifuPaymentProvider({} as never, {} as never);
    const confirmation = {
      orderId: intent.orderId,
      orderNo: intent.orderNo,
      merchantId: intent.merchantId,
      amountFen: 3990,
      paymentReference: 'pay_123456',
      idempotencyKey: 'delay-confirm-123456',
      acctSplitBunch: [{ div_amt: '39.90' }],
      confirmationRequestSeq: 'c333333333333333333333333333333',
      confirmationRequestDate: new Date('2026-07-19T10:00:00.000Z'),
      confirmRefundRequestSeq: 'cr22222222222222222222222222222',
      confirmRefundRequestDate: new Date('2026-07-20T10:00:00.000Z'),
      providerMerchantId: intent.providerMerchantId,
      orderCreatedAt: new Date('2026-07-19T10:00:00.000Z'),
    };

    await expect(provider.confirmPayment(confirmation)).resolves.toEqual({ providerReference: 'confirm_12345678' });
    await expect(provider.queryPaymentConfirmation(confirmation)).resolves.toEqual({ status: 'SUCCEEDED', providerReference: 'confirm_12345678' });
    await expect(provider.confirmRefund({ ...confirmation, voucherId: '22222222-0000-4000-8000-000000000000' })).resolves.toEqual({ status: 'SUCCEEDED', paymentReference: 'confirm_refund_123456' });
    await expect(provider.queryConfirmRefund({ ...confirmation, voucherId: '22222222-0000-4000-8000-000000000000' })).resolves.toEqual({ status: 'SUCCEEDED', providerPaymentReference: 'confirm_refund_query_123' });

    const confirmationCall = fetchMock.mock.calls.find(([input]) => String(input).includes('/delaytrans/confirm'));
    const confirmationEnvelope = JSON.parse(String(confirmationCall?.[1]?.body)) as { data: Record<string, string> };
    expect(JSON.parse(confirmationEnvelope.data.acct_split_bunch)).toEqual({ acct_infos: [{ div_amt: '39.90', huifu_id: '666600009999' }] });
    expect(confirmationEnvelope.data.trans_amt).toBe('39.90');
    expect(String(confirmationCall?.[0])).toContain('/v2/trade/payment/delaytrans/confirm');

    const confirmRefundCall = fetchMock.mock.calls.find(([input]) => String(input).includes('/delaytrans/confirmrefund'));
    const confirmRefundEnvelope = JSON.parse(String(confirmRefundCall?.[1]?.body)) as { data: Record<string, string> };
    expect(confirmRefundEnvelope.data).toEqual(expect.objectContaining({
      req_seq_id: 'cr22222222222222222222222222222',
      org_req_seq_id: 'c333333333333333333333333333333',
      org_req_date: '20260719',
    }));
    expect(JSON.parse(confirmRefundEnvelope.data.acct_split_bunch)).toEqual({ acct_infos: [{ div_amt: '39.90', huifu_id: '666600009999' }] });

    const confirmRefundQueryCall = fetchMock.mock.calls.find(([input]) => String(input).includes('/delaytrans/confirmrefundquery'));
    const confirmRefundQueryEnvelope = JSON.parse(String(confirmRefundQueryCall?.[1]?.body)) as { data: Record<string, string> };
    expect(confirmRefundQueryEnvelope.data).toEqual(expect.objectContaining({
      org_req_seq_id: 'cr22222222222222222222222222222',
      org_req_date: '20260720',
    }));
  });

  it('rejects delay confirmation when split amount does not equal confirmation amount', async () => {
    process.env.HUIFU_DELAYED_SETTLEMENT_ENABLED = 'true';
    const fetchMock = jest.spyOn(global, 'fetch');
    const provider = new HuifuPaymentProvider({} as never, {} as never);
    await expect(provider.confirmPayment({
      orderId: intent.orderId,
      orderNo: intent.orderNo,
      merchantId: intent.merchantId,
      amountFen: 3990,
      paymentReference: 'pay_123456',
      idempotencyKey: 'delay-confirm-123456',
      acctSplitBunch: [{ div_amt: '39.89' }],
      providerMerchantId: intent.providerMerchantId,
    })).rejects.toThrow('分账金额与确认金额不一致');
    expect(fetchMock).not.toHaveBeenCalled();
  });


  it('uses the official V2 object data envelope and signs only sorted data for applet binding', async () => {
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      data: { resp_code: '00000000', resp_desc: '成功', huifu_id: '666600009999' },
    }), { status: 200 }));
    const provider = new HuifuPaymentProvider({} as never, {} as never);

    const result = await provider.bindAppletAppId('666600009999', 'wx0000000000000000');

    expect(result.note).toBe('绑定申请已提交');
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('https://huifu.example.test/v2/merchant/busi/config');
    const envelope = JSON.parse(String(init?.body)) as {
      sys_id: string;
      product_id: string;
      data: Record<string, string>;
      sign: string;
    };
    expect(envelope.sys_id).toBe('666600009999');
    expect(envelope.product_id).toBe('EDUSTD');
    expect(typeof envelope.data).toBe('object');
    expect(envelope.data).toEqual(expect.objectContaining({
      huifu_id: '666600009999',
      fee_type: '01',
      wx_applet_app_id: 'wx0000000000000000',
    }));
    expect(envelope.data).not.toHaveProperty('bind_app_id_conf_list');
    expect(envelope.data).not.toHaveProperty('async_return_url');

    const sortedData = Object.fromEntries(Object.keys(envelope.data).sort().map((key) => [key, envelope.data[key]]));
    const verifier = createVerify('RSA-SHA256');
    verifier.update(JSON.stringify(sortedData), 'utf8');
    expect(verifier.verify(publicKey, envelope.sign, 'base64')).toBe(true);
  });

  it('accepts Huifu bare Base64 PKCS#8 private and X.509 public keys', async () => {
    process.env.HUIFU_ISV_PRIVATE_KEY = privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64');
    process.env.HUIFU_PUBLIC_KEY = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      data: { resp_code: '00000000', resp_desc: '成功' },
    }), { status: 200 }));
    const provider = new HuifuPaymentProvider({} as never, {} as never);

    const result = await provider.bindAppletAppId('666600009999', 'wx0000000000000000');

    expect(result.note).toBe('绑定申请已提交');
    const envelope = JSON.parse(String(fetchMock.mock.calls[0][1]?.body)) as { data: Record<string, string>; sign: string };
    const sortedData = Object.fromEntries(Object.keys(envelope.data).sort().map((key) => [key, envelope.data[key]]));
    const verifier = createVerify('RSA-SHA256');
    verifier.update(JSON.stringify(sortedData), 'utf8');
    expect(verifier.verify(publicKey, envelope.sign, 'base64')).toBe(true);
  });

  it('does not submit an irreversible binding without an explicit WeChat fee type', async () => {
    delete process.env.HUIFU_WECHAT_FEE_TYPE;
    const fetchMock = jest.spyOn(global, 'fetch');
    const provider = new HuifuPaymentProvider({} as never, {} as never);

    const result = await provider.bindAppletAppId('666600009999', 'wx0000000000000000');

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.note).toContain('HUIFU_WECHAT_FEE_TYPE');
  });

  it('uses configured WeChat fee type instead of treating 02 as an applet type', async () => {
    process.env.HUIFU_WECHAT_FEE_TYPE = '08';
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      data: { resp_code: '00000000', resp_desc: '成功' },
    }), { status: 200 }));
    const provider = new HuifuPaymentProvider({} as never, {} as never);

    await provider.bindAppletAppId('666600009999', 'wx0000000000000000');

    const envelope = JSON.parse(String(fetchMock.mock.calls[0][1]?.body)) as { data: Record<string, string> };
    expect(envelope.data.fee_type).toBe('08');
  });

  it('derives callback ownership from the provider merchant ID without inventing an internal merchant ID', async () => {
    const provider = new HuifuPaymentProvider({} as never, {} as never);
    const body = JSON.stringify({ sign_type: 'RSA2', sign: '', data: JSON.stringify({ hf_seq_id: 'trans_12345678', trans_stat: 'S', mer_ord_id: 'DG202607190123456789ABCDEF', trans_amt: '39.90', huifu_id: '666600009999' }) });
    const signer = createSign('RSA-SHA256');
    const dataRaw = JSON.parse(body).data;
    signer.update(dataRaw, 'utf8');
    const signed = JSON.parse(body) as { data: string; sign?: string };
    signed.sign = signer.sign(privateKey, 'base64');
    const event = await provider.parseWebhook({ rawBody: Buffer.from(JSON.stringify(signed)), headers: {} });

    expect(event).toEqual(expect.objectContaining({ eventType: PaymentEventType.PAYMENT_SUCCEEDED, orderNo: 'DG202607190123456789ABCDEF', providerMerchantId: '666600009999' }));
    expect(event.merchantId).toBeUndefined();
  });

  it('accepts the official resp_data freeze/unfreeze notification and prefers req_seq_id', async () => {
    const provider = new HuifuPaymentProvider({} as never, {} as never);
    const respData = JSON.stringify({
      resp_code: '00000000',
      resp_desc: '交易成功[000]',
      hf_seq_id: 'hf_unfreeze_123456',
      req_seq_id: 'DG202607190123456789ABCDEF',
      req_date: '20260719',
      huifu_id: '666600009999',
      notify_type: '3',
      fund_freeze_stat: 'UNFREEZE',
      unfreeze_amt: '39.90',
      freeze_time: '20260719120000',
      unfreeze_time: '20260720120000',
      trans_stat: 'S',
      trans_amt: '39.90',
    });
    const body = JSON.stringify({ resp_code: '00000000', resp_data: respData, sign: '' });
    const signer = createSign('RSA-SHA256');
    signer.update(respData, 'utf8');
    const signed = JSON.parse(body) as { resp_data: string; sign: string };
    signed.sign = signer.sign(privateKey, 'base64');
    const event = await provider.parseWebhook({ rawBody: Buffer.from(JSON.stringify(signed)), headers: {} });
    expect(event).toEqual(expect.objectContaining({
      eventType: PaymentEventType.FUND_CONTROL_UPDATED,
      orderNo: 'DG202607190123456789ABCDEF',
      providerEventId: 'hf_unfreeze_123456',
      amountFen: 3990,
      fundControl: {
        status: 'UNFREEZE',
        frozenAt: new Date('2026-07-19T04:00:00.000Z'),
        unfrozenAt: new Date('2026-07-20T04:00:00.000Z'),
        unfrozenAmountFen: 3990,
      },
    }));
  });

  it('classifies delayed confirmation resp_data as a non-payment event', async () => {
    const provider = new HuifuPaymentProvider({} as never, {} as never);
    const respData = JSON.stringify({
      hf_seq_id: 'hf_confirm_123456',
      org_req_seq_id: 'delay-confirm-333333333333',
      req_seq_id: 'DG202607190123456789ABCDEF',
      huifu_id: '666600009999',
      trans_stat: 'S',
      trans_amt: '39.90',
      confirm_stat: 'S',
    });
    const signer = createSign('RSA-SHA256');
    signer.update(respData, 'utf8');
    const signed = { resp_data: respData, sign: signer.sign(privateKey, 'base64') };
    const event = await provider.parseWebhook({ rawBody: Buffer.from(JSON.stringify(signed)), headers: {} });
    expect(event.eventType).toBe(PaymentEventType.DELAYED_SETTLEMENT_UPDATED);
    expect(event.delayedSettlement).toEqual(expect.objectContaining({ status: 'SUCCEEDED', providerReference: 'hf_confirm_123456' }));
    expect(event.orderNo).toBe('DG202607190123456789ABCDEF');
  });
  it('fails closed when an order has no merchant Huifu ID', async () => {
    const provider = new HuifuPaymentProvider({} as never, {} as never);
    await expect(provider.createPayment({ orderId: '01234567-0000-0000-0000-000000000000', orderNo: 'DG202607190123456789ABCDEF', merchantId: 'abcdef12-0000-0000-0000-000000000000', amountFen: 3990, expiresAt: new Date(Date.now() + 15 * 60_000), idempotencyKey: 'payment-key-0001' })).rejects.toThrow('汇付收款档案尚未启用');
  });

  it('fails closed when a real-payment order has no customer openid', async () => {
    const provider = new HuifuPaymentProvider({} as never, {} as never);
    await expect(provider.createPayment({ ...intent, customerOpenid: '' })).rejects.toThrow('付款顾客尚未授权登录');
  });
});
