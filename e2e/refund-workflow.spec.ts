import { expect, test } from '@playwright/test';

test('exception refund requires one finance approver and another finance executor', async ({ browser }) => {
  test.setTimeout(120_000);
  const apiBase = 'http://127.0.0.1:3001/api/v1';
  const suffix = Date.now().toString(36);
  const brandName = `异常退款回归商家-${suffix}`;
  const merchantEmail = `exception-refund-${suffix}@demo.local`;
  const merchantPassword = 'ExceptionRefundPassword123';
  const executorEmail = `refund-executor-${suffix}@demo.local`;
  const executorPassword = 'RefundExecutorPassword123';
  const requestContent = '门店临时停业且无法转店履约，申请对该张未使用券执行异常补偿退款。';
  const approvalNote = '已核对停业事实、券状态和补偿依据，批准本次异常退款。';
  const executionNote = '独立复核审批人与券状态后执行模拟退款，并完成工单结案。';

  const platformLogin = await fetch(`${apiBase}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'http://127.0.0.1:5173' },
    body: JSON.stringify({ email: 'platform@demo.local', password: 'Demo123456' }),
  });
  expect(platformLogin.status).toBe(201);
  const platformToken = (await platformLogin.json() as { token: string }).token;
  const platformHeaders = { Authorization: `Bearer ${platformToken}`, 'Content-Type': 'application/json' };
  const agencies = await (await fetch(`${apiBase}/agencies`, { headers: platformHeaders })).json() as Array<{ id: string; active: boolean }>;
  const agency = agencies.find((item) => item.active);
  expect(agency).toBeTruthy();

  const createdResponse = await fetch(`${apiBase}/merchants`, {
    method: 'POST',
    headers: { ...platformHeaders, 'Idempotency-Key': `merchant_exception_refund_${suffix}` },
    body: JSON.stringify({
      agencyId: agency!.id,
      legalName: `异常退款浏览器回归主体-${suffix}`,
      brandName,
      contractNumber: `REFUND-E2E-${suffix.toUpperCase()}`,
      contractEndsAt: '2030-12-31',
      rate: 0.08,
      adminName: '异常退款回归管理员',
      adminEmail: merchantEmail,
      adminPassword: merchantPassword,
    }),
  });
  const created = await createdResponse.json() as { id?: string; message?: string | string[] };
  expect(createdResponse.status, JSON.stringify(created)).toBe(201);
  const merchantId = created.id!;

  const executorResponse = await fetch(`${apiBase}/demo/platform-finance-users`, {
    method: 'POST',
    headers: platformHeaders,
    body: JSON.stringify({ name: '异常退款执行财务', email: executorEmail, password: executorPassword }),
  });
  expect(executorResponse.status, JSON.stringify(await executorResponse.clone().json())).toBe(201);

  const merchantLogin = await fetch(`${apiBase}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'http://127.0.0.1:5175' },
    body: JSON.stringify({ email: merchantEmail, password: merchantPassword }),
  });
  expect(merchantLogin.status).toBe(201);
  const merchantToken = (await merchantLogin.json() as { token: string }).token;
  const merchantHeaders = { Authorization: `Bearer ${merchantToken}`, 'Content-Type': 'application/json' };
  const storeResponse = await fetch(`${apiBase}/merchants/${merchantId}/stores`, {
    method: 'POST',
    headers: merchantHeaders,
    body: JSON.stringify({ name: '异常退款回归门店', address: '广州市天河区测试路 18 号', phone: '020-88887777', businessHours: '09:00-21:00', openForSale: true }),
  });
  expect(storeResponse.status).toBe(201);
  const store = await storeResponse.json() as { id: string };
  const packageResponse = await fetch(`${apiBase}/merchants/${merchantId}/packages`, {
    method: 'POST',
    headers: merchantHeaders,
    body: JSON.stringify({ title: '异常退款回归套餐', description: '仅用于异常退款跨端浏览器回归。', priceFen: 1_280, saleLimit: 10, perCustomerLimit: 2, storeIds: [store.id], validFrom: '2026-01-01', validTo: '2030-12-31', status: 'ON_SALE' }),
  });
  expect(packageResponse.status).toBe(201);
  const deal = await packageResponse.json() as { id: string };
  const customerSession = await (await fetch(`${apiBase}/public/demo/customer-sessions`, { method: 'POST' })).json() as { token: string };
  const customerHeaders = { Authorization: `Bearer ${customerSession.token}`, 'Content-Type': 'application/json' };
  const orderResponse = await fetch(`${apiBase}/public/merchants/${merchantId}/orders`, {
    method: 'POST',
    headers: customerHeaders,
    body: JSON.stringify({ packageId: deal.id, storeId: store.id, quantity: 1, idempotencyKey: `refund_order_${suffix}` }),
  });
  expect(orderResponse.status).toBe(201);
  const order = await orderResponse.json() as { id: string };
  const paymentResponse = await fetch(`${apiBase}/public/orders/${order.id}/mock-confirm`, { method: 'POST', headers: customerHeaders });
  expect(paymentResponse.status).toBe(201);
  const voucher = (await paymentResponse.json() as { vouchers: Array<{ id: string; code: string }> }).vouchers[0];

  const merchantContext = await browser.newContext();
  const approverContext = await browser.newContext();
  const executorContext = await browser.newContext();
  const merchantPage = await merchantContext.newPage();
  const approverPage = await approverContext.newPage();
  const executorPage = await executorContext.newPage();
  for (const page of [merchantPage, approverPage, executorPage]) page.setDefaultTimeout(10_000);

  const selectMerchant = async (page: typeof approverPage) => {
    const selector = page.getByLabel('当前商家').first();
    if (!(await selector.textContent())?.includes(brandName)) {
      await selector.click();
      await page.locator('.ant-select-dropdown:visible .ant-select-item-option').filter({ hasText: brandName }).click();
    }
    await expect(selector).toContainText(brandName);
  };

  try {
    await merchantPage.goto('http://127.0.0.1:5175');
    await merchantPage.getByLabel('账号').fill(merchantEmail);
    await merchantPage.getByLabel('密码').fill(merchantPassword);
    await merchantPage.getByRole('button', { name: '登录' }).click();
    await merchantPage.getByText('售后工单', { exact: true }).first().click();
    await expect(merchantPage.getByRole('heading', { name: '售后工单' })).toBeVisible();
    await merchantPage.getByRole('button', { name: '异常退款申请' }).click();
    const requestDialog = merchantPage.getByRole('dialog', { name: '异常退款申请' });
    await requestDialog.locator('.ant-select-selector').click();
    await merchantPage.locator('.ant-select-dropdown:visible .ant-select-item-option').filter({ hasText: voucher.code }).click();
    await requestDialog.getByLabel('申请说明').fill(requestContent);
    await requestDialog.getByRole('button', { name: /确\s*认/ }).click();
    await expect(merchantPage.getByText('异常退款申请已提交', { exact: true }).last()).toBeVisible();
    const merchantTicketRow = () => merchantPage.getByRole('row').filter({ hasText: requestContent }).first();
    await expect(merchantTicketRow()).toContainText('待独立复核');

    await approverPage.goto('http://127.0.0.1:5173');
    await approverPage.getByLabel('账号').fill('platform@demo.local');
    await approverPage.getByLabel('密码').fill('Demo123456');
    await approverPage.getByRole('button', { name: '登录' }).click();
    await selectMerchant(approverPage);
    await approverPage.getByText('售后工单', { exact: true }).first().click();
    const approverTicketRow = () => approverPage.getByRole('row').filter({ hasText: requestContent }).first();
    await expect(approverTicketRow()).toBeVisible();
    await approverTicketRow().getByRole('button', { name: '批准退款' }).click();
    const approvalDialog = approverPage.getByRole('dialog', { name: '独立审批异常退款' });
    await approvalDialog.getByLabel('审批意见').fill(approvalNote);
    await approvalDialog.getByRole('button', { name: '确认通过' }).click();
    await expect(approverPage.getByText('异常退款已批准，需由另一名财务账号执行', { exact: true }).last()).toBeVisible();
    await expect(approverTicketRow()).toContainText('已批准');
    await expect(approverTicketRow()).toContainText('待其他财务执行');

    await executorPage.goto('http://127.0.0.1:5173');
    await executorPage.getByLabel('账号').fill(executorEmail);
    await executorPage.getByLabel('密码').fill(executorPassword);
    await executorPage.getByRole('button', { name: '登录' }).click();
    await selectMerchant(executorPage);
    await executorPage.getByText('异常退款审批', { exact: true }).first().click();
    const executorTicketRow = () => executorPage.getByRole('row').filter({ hasText: requestContent }).first();
    await expect(executorTicketRow()).toContainText('已批准');
    await executorTicketRow().getByRole('button', { name: '执行退款' }).click();
    const executionDialog = executorPage.getByRole('dialog', { name: '执行异常退款' });
    await executionDialog.getByLabel('执行备注').fill(executionNote);
    await executionDialog.getByRole('button', { name: '确认执行退款' }).click();
    await expect(executorPage.getByText('退款已执行，券已失效并完成结案', { exact: true }).last()).toBeVisible();
    await expect(executorTicketRow()).toContainText('已处理');
    await expect(executorTicketRow()).toContainText('平台已完成本次异常退款处理');

    await merchantPage.reload();
    await merchantPage.getByText('售后工单', { exact: true }).first().click();
    await expect(merchantTicketRow()).toContainText('已批准');
    await expect(merchantTicketRow()).toContainText('已处理');

    const vouchersResponse = await fetch(`${apiBase}/vouchers?merchantId=${merchantId}&page=1&pageSize=100`, { headers: merchantHeaders });
    expect(vouchersResponse.status).toBe(200);
    const vouchers = await vouchersResponse.json() as { items: Array<{ id: string; status: string; refundStatus: string | null }> };
    expect(vouchers.items.find((item) => item.id === voucher.id)).toEqual(expect.objectContaining({ status: 'REFUNDED', refundStatus: 'SUCCEEDED' }));
    const customerVouchers = await (await fetch(`${apiBase}/public/vouchers`, { headers: customerHeaders })).json() as Array<{ id: string; status: string }>;
    expect(customerVouchers.find((item) => item.id === voucher.id)).toEqual(expect.objectContaining({ status: 'REFUNDED' }));
  } finally {
    await merchantContext.close();
    await approverContext.close();
    await executorContext.close();
  }
});
