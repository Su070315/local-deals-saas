import { randomUUID } from 'node:crypto';

const REQUEST_TIMEOUT_MS = 20_000;
const DEFAULT_PASSWORD = 'Demo123456';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function jsonHeaders(token, origin, extra = {}) {
  return {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    Origin: origin,
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...extra,
  };
}

function parseBody(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch { return text.slice(0, 500); }
}

/**
 * Exercises the request path through the workspace Nginx proxies. The two API
 * replicas behind the internal gateway are intentionally not addressed
 * directly: this keeps the check close to the production client path while
 * still forcing concurrent requests onto separate Node processes.
 */
export async function runDockerConcurrencySmoke({ workspaceBaseUrls, suffix = randomUUID().slice(0, 8) }) {
  const platformOrigin = 'http://platform.localhost:5173';
  const merchantOrigin = 'http://merchant.localhost:5175';
  const verifierOrigin = 'http://verify.localhost:5176';
  const platformBase = workspaceBaseUrls.platform;
  const merchantBase = workspaceBaseUrls.merchant;
  const verifyBase = workspaceBaseUrls.verify;

  async function request(base, path, init = {}) {
    const response = await fetch(`${base}/api/v1${path}`, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    const text = await response.text();
    return { status: response.status, body: parseBody(text), headers: response.headers };
  }

  async function login(base, origin, email, password = DEFAULT_PASSWORD) {
    const response = await request(base, '/auth/login', {
      method: 'POST',
      headers: jsonHeaders('', origin),
      body: JSON.stringify({ email, password }),
    });
    assert(response.status === 201 && response.body?.token, `${email} 登录失败（${response.status}）`);
    return response.body;
  }

  async function customerSession() {
    const response = await request(merchantBase, '/public/demo/customer-sessions', { method: 'POST', headers: jsonHeaders('', merchantOrigin) });
    assert(response.status === 201 && response.body?.token, `演示顾客会话创建失败（${response.status}）`);
    return response.body.token;
  }

  async function createPackage(token, merchantId, storeId, title, saleLimit) {
    const response = await request(merchantBase, `/merchants/${merchantId}/packages`, {
      method: 'POST',
      headers: jsonHeaders(token, merchantOrigin),
      body: JSON.stringify({
        title,
        description: 'Docker 并发与故障演练临时套餐',
        priceFen: 101,
        saleLimit,
        perCustomerLimit: 0,
        storeIds: [storeId],
        validFrom: '2026-01-01',
        validTo: '2027-12-31',
        status: 'ON_SALE',
      }),
    });
    assert(response.status === 201 && response.body?.id, `创建并发演练套餐失败（${response.status}）`);
    return response.body;
  }

  async function createOrder(customerToken, merchantId, packageId, storeId, key) {
    return request(merchantBase, `/public/merchants/${merchantId}/orders`, {
      method: 'POST',
      headers: jsonHeaders(customerToken, merchantOrigin),
      body: JSON.stringify({ packageId, storeId, quantity: 1, idempotencyKey: key }),
    });
  }

  async function confirmPayment(customerToken, orderId) {
    return request(merchantBase, `/public/orders/${orderId}/mock-confirm`, {
      method: 'POST',
      headers: jsonHeaders(customerToken, merchantOrigin),
    });
  }

  const merchantAdmin = await login(merchantBase, merchantOrigin, 'merchant@demo.local');
  const platformOperator = await login(platformBase, platformOrigin, 'platform-operations@demo.local');
  const platformReviewer = await login(platformBase, platformOrigin, 'platform@demo.local');
  const merchantsResponse = await request(merchantBase, '/merchants', { headers: jsonHeaders(merchantAdmin.token, merchantOrigin) });
  assert(merchantsResponse.status === 200 && Array.isArray(merchantsResponse.body), `商家列表读取失败（${merchantsResponse.status}）`);
  const merchant = merchantsResponse.body.find((item) => item.brandName === '花时间花艺');
  assert(merchant?.id, '未找到演示商家');
  const storesResponse = await request(merchantBase, `/merchants/${merchant.id}/stores`, { headers: jsonHeaders(merchantAdmin.token, merchantOrigin) });
  assert(storesResponse.status === 200 && storesResponse.body?.[0]?.id, `门店读取失败（${storesResponse.status}）`);
  const store = storesResponse.body[0];
  const customerToken = await customerSession();

  const limitedPackage = await createPackage(merchantAdmin.token, merchant.id, store.id, `Docker 并发限量 ${suffix}`, 1);
  const orderResponses = await Promise.all(Array.from({ length: 8 }, (_, index) => createOrder(
    customerToken,
    merchant.id,
    limitedPackage.id,
    store.id,
    `docker-stock-${suffix}-${index}`,
  )));
  const successfulOrders = orderResponses.filter((response) => response.status === 201);
  assert(successfulOrders.length === 1, `限量库存并发下单应恰好成功 1 次，实际 ${successfulOrders.length} 次`);
  assert(orderResponses.every((response) => response.status === 201 || response.status === 400), `库存并发下单出现意外状态：${orderResponses.map((response) => response.status).join(',')}`);
  const orderId = successfulOrders[0].body?.id;
  assert(orderId, '并发下单成功响应缺少订单 ID');

  const paymentResponses = await Promise.all(Array.from({ length: 6 }, () => confirmPayment(customerToken, orderId)));
  assert(paymentResponses.every((response) => response.status === 201), `并发模拟支付确认未全部幂等成功：${paymentResponses.map((response) => response.status).join(',')}`);
  const paymentVoucherIds = new Set(paymentResponses.flatMap((response) => (response.body?.vouchers || []).map((voucher) => voucher.id)));
  assert(paymentVoucherIds.size === 1, `并发支付确认生成了 ${paymentVoucherIds.size} 张相同订单券，预期 1 张`);
  const voucherId = [...paymentVoucherIds][0];

  const controlPackage = await createPackage(merchantAdmin.token, merchant.id, store.id, `Docker 止售恢复 ${suffix}`, 10);
  const initialControl = await request(platformBase, '/platform/runtime-controls/sales', { headers: jsonHeaders(platformOperator.token, platformOrigin) });
  assert(initialControl.status === 200 && initialControl.body?.status === 'ENABLED', `全局销售控制初始状态异常（${initialControl.status}）`);
  const pauseKey = `docker-sales-pause-${suffix}`;
  const pauseBody = { expectedVersion: initialControl.body.version, note: 'Docker 并发演练：暂停新订单' };
  const pauseResponses = await Promise.all(Array.from({ length: 4 }, () => request(platformBase, '/platform/runtime-controls/sales/pause', {
    method: 'POST',
    headers: jsonHeaders(platformOperator.token, platformOrigin, { 'Idempotency-Key': pauseKey }),
    body: JSON.stringify(pauseBody),
  })));
  assert(pauseResponses.every((response) => response.status === 201), `全局止售同键并发未全部幂等成功：${pauseResponses.map((response) => response.status).join(',')}`);
  const pausedVersions = new Set(pauseResponses.map((response) => response.body?.version));
  assert(pausedVersions.size === 1 && pauseResponses[0].body?.status === 'PAUSED', '全局止售并发结果版本或状态不一致');

  const blockedOrderResponses = await Promise.all(Array.from({ length: 4 }, (_, index) => createOrder(
    customerToken,
    merchant.id,
    controlPackage.id,
    store.id,
    `docker-paused-${suffix}-${index}`,
  )));
  assert(blockedOrderResponses.every((response) => response.status === 503), `全局止售期间仍有新订单进入：${blockedOrderResponses.map((response) => response.status).join(',')}`);

  const dynamicCode = await request(merchantBase, `/public/vouchers/${voucherId}/dynamic-code`, {
    method: 'POST',
    headers: jsonHeaders(customerToken, merchantOrigin),
  });
  assert(dynamicCode.status === 201 && dynamicCode.body?.token, `止售期间生成动态码失败（${dynamicCode.status}）`);
  const verifier = await login(verifyBase, verifierOrigin, 'staff@demo.local');
  const verificationAttempts = await Promise.all(Array.from({ length: 6 }, async (_, index) => {
    const idempotencyKey = `docker-verify-${suffix}-${index}`;
    const response = await request(verifyBase, '/verification/confirm', {
      method: 'POST',
      headers: jsonHeaders(verifier.token, verifierOrigin),
      body: JSON.stringify({ token: dynamicCode.body.token, workingStoreId: store.id, idempotencyKey }),
    });
    return { idempotencyKey, response };
  }));
  const verificationResponses = verificationAttempts.map((attempt) => attempt.response);
  const successfulVerifications = verificationResponses.filter((response) => response.status === 201);
  assert(successfulVerifications.length === 1, `并发核销应恰好成功 1 次，实际 ${successfulVerifications.length} 次`);
  assert(verificationResponses.every((response) => response.status === 201 || response.status === 400), `并发核销出现意外状态：${verificationResponses.map((response) => response.status).join(',')}`);
  const verificationId = successfulVerifications[0].body?.id;
  assert(verificationId, '核销成功响应缺少核销 ID');

  const successfulVerificationAttempt = verificationAttempts.find((attempt) => attempt.response.status === 201);
  const replayKey = successfulVerificationAttempt?.idempotencyKey;
  assert(replayKey, '未能确定成功核销使用的幂等键');
  const replayResponses = await Promise.all(Array.from({ length: 4 }, () => request(verifyBase, '/verification/confirm', {
    method: 'POST',
    headers: jsonHeaders(verifier.token, verifierOrigin),
    body: JSON.stringify({ token: dynamicCode.body.token, workingStoreId: store.id, idempotencyKey: replayKey }),
  })));
  assert(replayResponses.every((response) => response.status === 201), `同一核销幂等键并发重试未全部成功：${replayResponses.map((response) => response.status).join(',')}`);
  assert(new Set(replayResponses.map((response) => response.body?.id)).size === 1, '同一核销幂等键返回了多个核销 ID');

  const pausedVersion = pauseResponses[0].body.version;
  const resumeRequestKey = `docker-sales-resume-request-${suffix}`;
  const resumeRequestResponses = await Promise.all(Array.from({ length: 3 }, () => request(platformBase, '/platform/runtime-controls/sales/resume-request', {
    method: 'POST',
    headers: jsonHeaders(platformOperator.token, platformOrigin, { 'Idempotency-Key': resumeRequestKey }),
    body: JSON.stringify({ expectedVersion: pausedVersion, note: 'Docker 并发演练：申请恢复新订单' }),
  })));
  assert(resumeRequestResponses.every((response) => response.status === 201), `恢复申请同键并发未全部幂等成功：${resumeRequestResponses.map((response) => response.status).join(',')}`);
  assert(resumeRequestResponses.every((response) => response.body?.status === 'RESUME_PENDING'), '恢复申请并发结果状态不一致');
  const pendingVersion = resumeRequestResponses[0].body.version;

  const approveKey = `docker-sales-resume-approve-${suffix}`;
  const approveResponses = await Promise.all(Array.from({ length: 3 }, () => request(platformBase, '/platform/runtime-controls/sales/resume-approve', {
    method: 'POST',
    headers: jsonHeaders(platformReviewer.token, platformOrigin, { 'Idempotency-Key': approveKey }),
    body: JSON.stringify({ expectedVersion: pendingVersion, note: 'Docker 并发演练：独立账号复核恢复' }),
  })));
  assert(approveResponses.every((response) => response.status === 201), `恢复复核同键并发未全部幂等成功：${approveResponses.map((response) => response.status).join(',')}`);
  assert(approveResponses.every((response) => response.body?.status === 'ENABLED' && response.body?.enabled === true), '恢复复核并发结果未回到 ENABLED');

  const afterResume = await createOrder(customerToken, merchant.id, controlPackage.id, store.id, `docker-resumed-${suffix}`);
  assert(afterResume.status === 201, `恢复后新订单未恢复（${afterResume.status}）`);

  return {
    suffix,
    limitedStock: { attempts: orderResponses.length, successful: successfulOrders.length, rejected: orderResponses.length - successfulOrders.length },
    paymentConfirmation: { attempts: paymentResponses.length, successful: paymentResponses.length, uniqueVoucherCount: paymentVoucherIds.size },
    pausedSales: { attempts: blockedOrderResponses.length, blocked: blockedOrderResponses.length, pauseReplayAttempts: pauseResponses.length, version: pausedVersion },
    concurrentVerification: { attempts: verificationResponses.length, successful: successfulVerifications.length, replayAttempts: replayResponses.length, verificationIdPresent: Boolean(verificationId) },
    resumedSales: { resumeRequestReplayAttempts: resumeRequestResponses.length, resumeApproveReplayAttempts: approveResponses.length, resumedOrderCreated: true },
  };
}
