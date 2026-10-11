import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';

const workspaces = [
  { name: '平台管理端', port: 5173, email: 'platform@demo.local', overview: '平台概览' },
  { name: '代理运营端', port: 5174, email: 'agency@demo.local', overview: '代理概览' },
  { name: '商户经营端', port: 5175, email: 'merchant@demo.local', overview: '经营概览' },
  { name: '门店核销端', port: 5176, email: 'staff@demo.local', overview: '核销概览' },
];

async function confirmSensitiveAction(page: Page) {
  await page.getByRole('button', { name: '身份确认' }).click();
  const dialog = page.getByRole('dialog', { name: '身份确认' });
  await dialog.getByLabel('当前密码').fill('Demo123456');
  const responsePromise = page.waitForResponse((response) => response.url().includes('/api/v1/auth/sensitive-action/verify') && response.request().method() === 'POST');
  await dialog.getByRole('button', { name: /确\s*认/ }).click();
  expect((await responsePromise).status()).toBe(201);
}

for (const workspace of workspaces) {
  test(`${workspace.name} accepts only its normal operator workflow`, async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${workspace.port}`);
    await expect(page.getByRole('heading', { name: workspace.name })).toBeVisible();
    await page.getByLabel('账号').fill(workspace.email);
    await page.getByLabel('密码').fill('Demo123456');
    await page.getByRole('button', { name: '登录' }).click();
    await expect(page.getByText(workspace.overview, { exact: true }).first()).toBeVisible();
    await expect(page.getByText('模拟交易', { exact: true })).toBeVisible();
    await context.close();
  });
}

test('platform workspace rejects an agency account without revealing its role', async ({ page }) => {
  await page.goto('http://127.0.0.1:5173');
  await page.getByLabel('账号').fill('agency@demo.local');
  await page.getByLabel('密码').fill('Demo123456');
  await page.getByRole('button', { name: '登录' }).click();
  await expect(page.getByRole('alert')).toContainText('账号或密码不正确');
  await expect(page.getByRole('heading', { name: '平台管理端' })).toBeVisible();
});

test('platform notification queue is available only to platform duties and stays redacted', async ({ page }) => {
  await page.goto('http://127.0.0.1:5173');
  await page.getByLabel('账号').fill('platform@demo.local');
  await page.getByLabel('密码').fill('Demo123456');
  await page.getByRole('button', { name: '登录' }).click();
  const notificationMenu = page.getByText('通知队列', { exact: true }).first();
  await expect(notificationMenu).toBeVisible();
  const responsePromise = page.waitForResponse((response) => response.url().includes('/api/v1/platform/notifications') && response.request().method() === 'GET');
  await notificationMenu.click();
  const response = await responsePromise;
  expect(response.status()).toBe(200);
  const payload = JSON.stringify(await response.json());
  expect(payload).not.toContain('recipientCiphertext');
  expect(payload).not.toContain('payload":');
  await expect(page.getByRole('heading', { name: '通知队列' })).toBeVisible();
  await expect(page.getByText('通知投递队列', { exact: true })).toBeVisible();

  await page.goto('http://127.0.0.1:5175');
  await page.getByLabel('账号').fill('merchant@demo.local');
  await page.getByLabel('密码').fill('Demo123456');
  await page.getByRole('button', { name: '登录' }).click();
  await expect(page.getByText('通知队列', { exact: true })).toHaveCount(0);
});

test('platform global sales control pauses sales and requires an independent operator review', async ({ browser }) => {
  const operatorContext = await browser.newContext();
  const operatorPage = await operatorContext.newPage();
  await operatorPage.goto('http://127.0.0.1:5173');
  await operatorPage.getByLabel('账号').fill('platform@demo.local');
  await operatorPage.getByLabel('密码').fill('Demo123456');
  await operatorPage.getByRole('button', { name: '登录' }).click();
  await confirmSensitiveAction(operatorPage);
  await operatorPage.getByText('全局销售控制', { exact: true }).first().click();
  await expect(operatorPage.getByRole('heading', { name: '全局销售控制' })).toBeVisible();

  const enabledStatus = operatorPage.getByText('新订单开放', { exact: true }).first();
  await expect(enabledStatus).toBeVisible();
  await operatorPage.getByRole('button', { name: '暂停全局新订单' }).click();
  await operatorPage.getByLabel('全局销售控制操作说明').fill('浏览器回归验证支付链路异常时的全局止售。');
  const pauseResponse = operatorPage.waitForResponse((response) => response.url().includes('/api/v1/platform/runtime-controls/sales/pause') && response.request().method() === 'POST');
  await operatorPage.getByRole('button', { name: '确认提交' }).click();
  expect((await pauseResponse).status()).toBe(201);
  await expect(operatorPage.getByText('全局止售', { exact: true }).first()).toBeVisible();
  await operatorPage.getByRole('button', { name: '申请恢复新订单' }).click();
  await operatorPage.getByLabel('全局销售控制操作说明').fill('浏览器回归验证支付链路恢复后的恢复申请。');
  const resumeRequestResponse = operatorPage.waitForResponse((response) => response.url().includes('/api/v1/platform/runtime-controls/sales/resume-request') && response.request().method() === 'POST');
  await operatorPage.getByRole('button', { name: '确认提交' }).click();
  expect((await resumeRequestResponse).status()).toBe(201);
  await expect(operatorPage.getByText('等待恢复复核', { exact: true }).first()).toBeVisible();

  const reviewerEmail = `platform-operations-${Date.now()}@demo.local`;
  const fixtureResponse = await operatorPage.evaluate(async (email) => {
    const token = sessionStorage.getItem('deals_token');
    const response = await fetch('/api/v1/demo/platform-operations-users', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '浏览器回归平台运营', email, password: 'Demo123456' }),
    });
    return response.status;
  }, reviewerEmail);
  expect(fixtureResponse).toBe(201);

  const reviewerContext = await browser.newContext();
  const reviewerPage = await reviewerContext.newPage();
  await reviewerPage.goto('http://127.0.0.1:5173');
  await reviewerPage.getByLabel('账号').fill(reviewerEmail);
  await reviewerPage.getByLabel('密码').fill('Demo123456');
  await reviewerPage.getByRole('button', { name: '登录' }).click();
  await confirmSensitiveAction(reviewerPage);
  await reviewerPage.getByText('全局销售控制', { exact: true }).first().click();
  await expect(reviewerPage.getByText('等待恢复复核', { exact: true }).first()).toBeVisible();
  await expect(reviewerPage.getByRole('button', { name: '复核并恢复新订单' })).toBeVisible();
  await reviewerPage.getByRole('button', { name: '复核并恢复新订单' }).click();
  await reviewerPage.getByLabel('全局销售控制操作说明').fill('独立确认支付链路恢复，恢复全局新订单。');
  const resumeApproveResponse = reviewerPage.waitForResponse((response) => response.url().includes('/api/v1/platform/runtime-controls/sales/resume-approve') && response.request().method() === 'POST');
  await reviewerPage.getByRole('button', { name: '确认提交' }).click();
  expect((await resumeApproveResponse).status()).toBe(201);
  await expect(reviewerPage.getByText('新订单开放', { exact: true }).first()).toBeVisible();

  await operatorPage.getByRole('button', { name: '刷新全局销售控制' }).click();
  await expect(operatorPage.getByText('新订单开放', { exact: true }).first()).toBeVisible();
  await reviewerContext.close();
  await operatorContext.close();
});

test('merchant report renders analytics once and remains contained on mobile', async ({ page }) => {
  let analyticsRequests = 0;
  page.on('request', (request) => { if (request.url().includes('/api/v1/reports/analytics')) analyticsRequests += 1; });
  await page.goto('http://127.0.0.1:5175');
  await page.getByLabel('账号').fill('merchant@demo.local');
  await page.getByLabel('密码').fill('Demo123456');
  await page.getByRole('button', { name: '登录' }).click();
  await page.getByText('经营报表', { exact: true }).first().click();
  await expect(page.getByRole('heading', { name: '经营报表' })).toBeVisible();
  await expect(page.getByText('每日金额趋势', { exact: true })).toBeVisible();
  await expect(page.getByText('门店对比', { exact: true })).toBeVisible();
  await expect(page.getByText('套餐对比', { exact: true })).toBeVisible();
  await expect.poll(() => analyticsRequests).toBe(1);
  await page.screenshot({ path: 'test-results/reporting-desktop.png', fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByText('核销率', { exact: true })).toBeVisible();
  await expect.poll(() => page.locator('.sider').evaluate((element) => element.getBoundingClientRect().width)).toBeLessThanOrEqual(70);
  const pageWidth = await page.evaluate(() => ({ client: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }));
  expect(pageWidth.scroll).toBeLessThanOrEqual(pageWidth.client);
  await page.screenshot({ path: 'test-results/reporting-mobile.png', fullPage: true });
});

test('merchant receives a persistent diagnostic panel for a report service failure', async ({ page }) => {
  await page.goto('http://127.0.0.1:5175');
  await page.getByLabel('账号').fill('merchant@demo.local');
  await page.getByLabel('密码').fill('Demo123456');
  await page.getByRole('button', { name: '登录' }).click();
  await page.route('**/api/v1/reports/analytics**', (route) => route.fulfill({
    status: 503,
    headers: { 'x-request-id': 'e2e-diagnostic-123', 'x-release-id': 'e2e-api-release' },
    contentType: 'application/json',
    body: JSON.stringify({ message: '报表服务暂不可用' }),
  }));
  await page.getByText('经营报表', { exact: true }).first().click();

  const panel = page.getByRole('dialog', { name: /问题诊断/ });
  await expect(panel).toContainText('问题诊断');
  await expect(panel).toContainText('报表服务暂不可用');
  await expect(panel).toContainText('e2e-diagnostic-123');
  await expect(panel).toContainText('e2e-api-release');
  await expect(panel).toContainText('停止重复提交');
  await expect(page.getByRole('button', { name: /问题诊断 OPS-/ })).toBeVisible();

  await panel.getByRole('button', { name: /关\s*闭/ }).click();
  await expect(panel).toBeHidden();
  await page.getByRole('button', { name: /问题诊断 OPS-/ }).click();
  await expect(panel).toBeVisible();
});

test('merchant domain tables load independently and stay contained on mobile', async ({ page }) => {
  await page.goto('http://127.0.0.1:5175');
  await page.getByLabel('账号').fill('merchant@demo.local');
  await page.getByLabel('密码').fill('Demo123456');
  await page.getByRole('button', { name: '登录' }).click();

  for (const [menu, heading, column] of [
    ['门店管理', '门店管理', '门店'],
    ['套餐管理', '套餐管理', '套餐'],
    ['核销员工', '核销员工', '姓名'],
    ['订单', '订单', '订单号'],
    ['券与核销', '券与核销', '券码'],
  ] as const) {
    await page.getByText(menu, { exact: true }).first().click();
    await expect(page.getByRole('heading', { name: heading })).toBeVisible();
    await expect(page.getByRole('columnheader', { name: column }).or(page.locator('.data-panel .ant-empty-description'))).toBeVisible();
  }

  await page.setViewportSize({ width: 390, height: 844 });
  const pageWidth = await page.evaluate(() => ({ client: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }));
  expect(pageWidth.scroll).toBeLessThanOrEqual(pageWidth.client);
});

test('merchant edits a package with live preview and restores the previous published version', async ({ page }) => {
  const originalTitle = '单支鲜花花束';
  const changedTitle = `${originalTitle}·回归${Date.now()}`;
  const changedDescription = '浏览器回归验证顾客端预览、保存和历史版本恢复。';

  await page.goto('http://127.0.0.1:5175');
  await page.getByLabel('账号').fill('merchant@demo.local');
  await page.getByLabel('密码').fill('Demo123456');
  await page.getByRole('button', { name: '登录' }).click();
  await page.getByText('套餐管理', { exact: true }).first().click();
  await expect(page.getByRole('heading', { name: '套餐管理' })).toBeVisible();

  const targetRow = () => page.getByRole('row').filter({ hasText: originalTitle }).first();
  await expect(targetRow()).toBeVisible();

  // Seed data predates normal create-audit entries. Saving the current values
  // once creates a restorable baseline while leaving the commercial state unchanged.
  await targetRow().getByRole('button', { name: /编\s*辑/ }).click();
  let editor = page.getByRole('dialog', { name: '编辑套餐' });
  await expect(editor.getByText('顾客端发布预览', { exact: true })).toBeVisible();
  await editor.getByRole('button', { name: /确\s*认/ }).click();
  await expect(page.getByText('已保存', { exact: true }).last()).toBeVisible();
  await expect(targetRow()).toBeVisible();

  await targetRow().getByRole('button', { name: /编\s*辑/ }).click();
  editor = page.getByRole('dialog', { name: '编辑套餐' });
  await editor.getByLabel('套餐名称').fill(changedTitle);
  await editor.getByLabel('套餐简介').fill(changedDescription);
  const preview = editor.locator('.ant-card').filter({ hasText: '顾客端发布预览' });
  await expect(preview).toContainText(changedTitle);
  await expect(preview).toContainText(changedDescription);
  await editor.getByRole('button', { name: /确\s*认/ }).click();
  await expect(page.getByText('已保存', { exact: true }).last()).toBeVisible();

  const changedRow = page.getByRole('row').filter({ hasText: changedTitle }).first();
  await expect(changedRow).toBeVisible();
  await changedRow.getByRole('button', { name: /版\s*本/ }).click();

  const history = page.getByRole('dialog', { name: `${changedTitle} · 历史版本` });
  await expect(history).toBeVisible();
  const baselineVersion = history.getByRole('row').filter({ has: page.getByText(originalTitle, { exact: true }) }).first();
  await expect(baselineVersion).toBeVisible();
  await baselineVersion.getByRole('button', { name: /恢\s*复/ }).click();
  const confirmation = page.locator('.ant-popconfirm').filter({ hasText: /恢复到版本 \d+？/ });
  await expect(confirmation).toBeVisible();
  await confirmation.locator('.ant-btn-primary').click();

  await expect(page.getByText('套餐配置已恢复为新版本', { exact: true }).last()).toBeVisible();
  const main = page.getByRole('main');
  const restoredRow = main.getByRole('row').filter({ has: page.getByText(originalTitle, { exact: true }) });
  await expect(restoredRow).toContainText('任选时令鲜花一束，到店凭券领取。');
  await expect(main.getByText(changedTitle, { exact: true })).toHaveCount(0);
});

test('merchant opens the independently split store and staff editors', async ({ page }) => {
  await page.goto('http://127.0.0.1:5175');
  await page.getByLabel('账号').fill('merchant@demo.local');
  await page.getByLabel('密码').fill('Demo123456');
  await page.getByRole('button', { name: '登录' }).click();

  await page.getByText('门店管理', { exact: true }).first().click();
  const storeRow = page.getByRole('row').filter({ hasText: '花时间花艺 - 珠江新城店' });
  await storeRow.getByRole('button', { name: /编\s*辑/ }).click();
  const storeEditor = page.getByRole('dialog', { name: '编辑门店' });
  await expect(storeEditor.getByLabel('门店名称')).toHaveValue('花时间花艺 - 珠江新城店');
  await expect(storeEditor.getByText('填写准确坐标后，顾客可在小程序直接打开地图导航。')).toBeVisible();
  await storeEditor.getByRole('button', { name: /取\s*消/ }).click();
  await expect(storeEditor).toBeHidden();

  await page.getByText('核销员工', { exact: true }).first().click();
  const staffRow = page.getByRole('row').filter({ hasText: 'staff@demo.local' });
  await staffRow.getByRole('button', { name: /编\s*辑.*重\s*置\s*密\s*码/ }).click();
  const staffEditor = page.getByRole('dialog', { name: '编辑核销员' });
  await expect(staffEditor.getByLabel('员工姓名')).toHaveValue('珠江新城核销员');
  await expect(staffEditor.getByLabel('登录账号')).toBeDisabled();
  await expect(staffEditor.getByText('授权门店', { exact: true })).toBeVisible();
  await staffEditor.getByRole('button', { name: /取\s*消/ }).click();
  await expect(staffEditor).toBeHidden();
});

test('customer support is replied to and resolved through the merchant workspace', async ({ page }) => {
  const apiBase = 'http://127.0.0.1:3001/api/v1';
  const merchantsResponse = await fetch(`${apiBase}/public/merchants`);
  expect(merchantsResponse.status).toBe(200);
  const merchant = (await merchantsResponse.json() as Array<{ id: string; brandName: string }>).find((item) => item.brandName === '花时间花艺');
  expect(merchant).toBeTruthy();

  const sessionResponse = await fetch(`${apiBase}/public/demo/customer-sessions`, { method: 'POST' });
  expect(sessionResponse.status).toBe(201);
  const customerToken = (await sessionResponse.json() as { token: string }).token;
  const content = `顾客跨端售后回归-${Date.now()}`;
  const createResponse = await fetch(`${apiBase}/public/support-tickets`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${customerToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ merchantId: merchant!.id, content, idempotencyKey: `support_e2e_${Date.now()}` }),
  });
  expect(createResponse.status).toBe(201);
  const ticketId = (await createResponse.json() as { id: string }).id;

  await page.goto('http://127.0.0.1:5175');
  await page.getByLabel('账号').fill('merchant@demo.local');
  await page.getByLabel('密码').fill('Demo123456');
  await page.getByRole('button', { name: '登录' }).click();
  await page.getByText('售后工单', { exact: true }).first().click();
  await expect(page.getByRole('heading', { name: '售后工单' })).toBeVisible();

  const ticketRow = () => page.getByRole('row').filter({ hasText: content }).first();
  await expect(ticketRow()).toBeVisible();
  await ticketRow().getByRole('button', { name: /^回\s*复$/ }).click();
  const replyDialog = page.getByRole('dialog', { name: '回复顾客售后' });
  await replyDialog.getByLabel('回复顾客').fill('商家已收到问题，正在核对门店当班记录。');
  await replyDialog.getByRole('button', { name: /确\s*认/ }).click();
  await expect(page.getByText('回复已发送，工单保持处理中', { exact: true }).last()).toBeVisible();
  await expect(ticketRow()).toContainText('1 条');

  await ticketRow().getByRole('button', { name: /回\s*复\s*并\s*结\s*案/ }).click();
  const resolutionDialog = page.getByRole('dialog', { name: '回复并结案' });
  await resolutionDialog.getByLabel('结案回复').fill('已与门店确认并完成处理，顾客可按原券规则到店使用。');
  await resolutionDialog.getByRole('button', { name: /确\s*认/ }).click();
  await expect(page.getByText('工单已完成处理', { exact: true }).last()).toBeVisible();
  await expect(ticketRow()).toContainText('已处理');

  const historyResponse = await fetch(`${apiBase}/public/support-tickets`, { headers: { Authorization: `Bearer ${customerToken}` } });
  expect(historyResponse.status).toBe(200);
  const resolved = (await historyResponse.json() as Array<{ id: string; status: string; resolutionNote: string; replies: Array<{ content: string }> }>).find((ticket) => ticket.id === ticketId);
  expect(resolved).toEqual(expect.objectContaining({ status: 'RESOLVED', resolutionNote: '已与门店确认并完成处理，顾客可按原券规则到店使用。' }));
  expect(resolved?.replies.map((reply) => reply.content)).toEqual([
    '商家已收到问题，正在核对门店当班记录。',
    '已与门店确认并完成处理，顾客可按原券规则到店使用。',
  ]);
});

test('merchant exports an order, verifies the downloaded artifact and revokes it from history', async ({ page }) => {
  const apiBase = 'http://127.0.0.1:3001/api/v1';
  const merchant = (await (await fetch(`${apiBase}/public/merchants`)).json() as Array<{ id: string; brandName: string }>).find((item) => item.brandName === '花时间花艺');
  expect(merchant).toBeTruthy();
  const storefront = await (await fetch(`${apiBase}/public/merchants/${merchant!.id}`)).json() as { stores: Array<{ id: string }> };
  const operatorLogin = await fetch(`${apiBase}/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'http://127.0.0.1:5175' },
    body: JSON.stringify({ email: 'merchant@demo.local', password: 'Demo123456' }),
  });
  expect(operatorLogin.status).toBe(201);
  const operatorToken = (await operatorLogin.json() as { token: string }).token;
  const operatorHeaders = { Authorization: `Bearer ${operatorToken}`, 'Content-Type': 'application/json' };
  const fixtureTitle = `导出回归套餐-${Date.now()}`;
  const packageResponse = await fetch(`${apiBase}/merchants/${merchant!.id}/packages`, {
    method: 'POST', headers: operatorHeaders,
    body: JSON.stringify({ title: fixtureTitle, description: '仅用于浏览器导出闭环回归。', priceFen: 990, saleLimit: 100, perCustomerLimit: 5, storeIds: [storefront.stores[0].id], validFrom: '2026-01-01', validTo: '2030-12-31', status: 'ON_SALE' }),
  });
  expect(packageResponse.status).toBe(201);
  const deal = await packageResponse.json() as { id: string; version: number };

  try {
    const session = await (await fetch(`${apiBase}/public/demo/customer-sessions`, { method: 'POST' })).json() as { token: string };
    const customerHeaders = { Authorization: `Bearer ${session.token}`, 'Content-Type': 'application/json' };
    const created = await fetch(`${apiBase}/public/merchants/${merchant!.id}/orders`, {
      method: 'POST', headers: customerHeaders, body: JSON.stringify({ packageId: deal.id, storeId: storefront.stores[0].id, quantity: 1, idempotencyKey: `order_e2e_${Date.now()}` }),
    });
    const createdBody = await created.json() as { id?: string; orderNo?: string; message?: string | string[] };
    expect(created.status, JSON.stringify(createdBody)).toBe(201);
    const order = createdBody as { id: string; orderNo: string };
    expect((await fetch(`${apiBase}/public/orders/${order.id}/mock-confirm`, { method: 'POST', headers: customerHeaders })).status).toBe(201);

  await page.goto('http://127.0.0.1:5175');
  await page.getByLabel('账号').fill('merchant@demo.local');
  await page.getByLabel('密码').fill('Demo123456');
  await page.getByRole('button', { name: '登录' }).click();
  await page.getByText('订单', { exact: true }).first().click();
  await expect(page.getByRole('heading', { name: '订单' })).toBeVisible();
  await expect(page.getByRole('row').filter({ hasText: order.orderNo })).toBeVisible();

  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出订单' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^orders-\d{8}-\d{8}\.csv$/);
  const artifactPath = await download.path();
  expect(artifactPath).toBeTruthy();
  expect(await readFile(artifactPath!, 'utf8')).toContain(order.orderNo);
  await expect(page.getByText('导出文件已开始下载', { exact: true }).last()).toBeVisible();

  await page.getByRole('button', { name: '导出记录' }).click();
  const history = page.getByRole('dialog', { name: '导出记录' });
  await expect(history).toBeVisible();
  const jobRow = history.getByRole('row').filter({ hasText: '订单' }).first();
  await expect(jobRow).toContainText('可下载');
  await expect(jobRow).toContainText('1/3');
  await jobRow.getByRole('button', { name: /撤\s*回/ }).click();
  const confirmation = page.locator('.ant-popconfirm').filter({ hasText: '确认撤回并删除此导出文件？' });
  await confirmation.locator('.ant-btn-primary').click();
  await expect(page.getByText('导出文件已撤回并清除', { exact: true }).last()).toBeVisible();
    await expect(jobRow).toContainText('已撤回');
  } finally {
    const currentPackages = await (await fetch(`${apiBase}/merchants/${merchant!.id}/packages`, { headers: operatorHeaders })).json() as Array<{ id: string; version: number; status: string }>;
    const current = currentPackages.find((item) => item.id === deal.id);
    if (current && current.status === 'ON_SALE') {
      await fetch(`${apiBase}/merchants/${merchant!.id}/packages/${deal.id}/status`, {
        method: 'POST', headers: operatorHeaders, body: JSON.stringify({ status: 'OFF_SALE', expectedVersion: current.version }),
      });
    }
  }
});

test('merchant exit completes across the merchant and platform workspaces', async ({ browser }) => {
  test.setTimeout(120_000);
  const apiBase = 'http://127.0.0.1:3001/api/v1';
  const suffix = Date.now().toString(36);
  const brandName = `离场回归商家-${suffix}`;
  const merchantEmail = `exit-e2e-${suffix}@demo.local`;
  const merchantPassword = 'ExitWorkflowPassword123';

  const platformLogin = await fetch(`${apiBase}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'http://127.0.0.1:5173' },
    body: JSON.stringify({ email: 'platform@demo.local', password: 'Demo123456' }),
  });
  expect(platformLogin.status).toBe(201);
  const platformToken = (await platformLogin.json() as { token: string }).token;
  const platformHeaders = { Authorization: `Bearer ${platformToken}`, 'Content-Type': 'application/json' };
  const agenciesResponse = await fetch(`${apiBase}/agencies`, { headers: platformHeaders });
  expect(agenciesResponse.status).toBe(200);
  const agencies = await agenciesResponse.json() as Array<{ id: string; active: boolean }>;
  const agency = agencies.find((item) => item.active);
  expect(agency).toBeTruthy();

  const createdResponse = await fetch(`${apiBase}/merchants`, {
    method: 'POST',
    headers: { ...platformHeaders, 'Idempotency-Key': `merchant_exit_e2e_${suffix}` },
    body: JSON.stringify({
      agencyId: agency!.id,
      legalName: `离场浏览器回归主体-${suffix}`,
      brandName,
      servicePhone: '020-88886666',
      contractNumber: `EXIT-E2E-${suffix.toUpperCase()}`,
      contractEndsAt: '2030-12-31',
      rate: 0.08,
      adminName: '离场回归管理员',
      adminEmail: merchantEmail,
      adminPassword: merchantPassword,
    }),
  });
  const createdBody = await createdResponse.json() as { id?: string; message?: string | string[] };
  expect(createdResponse.status, JSON.stringify(createdBody)).toBe(201);
  const merchantId = createdBody.id!;

  const merchantContext = await browser.newContext();
  const platformContext = await browser.newContext();
  const merchantPage = await merchantContext.newPage();
  const platformPage = await platformContext.newPage();
  merchantPage.setDefaultTimeout(10_000);
  platformPage.setDefaultTimeout(10_000);

  try {
    await merchantPage.goto('http://127.0.0.1:5175');
    await merchantPage.getByLabel('账号').fill(merchantEmail);
    await merchantPage.getByLabel('密码').fill(merchantPassword);
    await merchantPage.getByRole('button', { name: '登录' }).click();
    await expect(merchantPage.getByText('经营概览', { exact: true }).first()).toBeVisible();
    await merchantPage.getByText('退出经营', { exact: true }).first().click();
    await expect(merchantPage.getByRole('heading', { name: '离场案件' })).toBeVisible();
    await merchantPage.getByRole('button', { name: '提交退出申请' }).click();
    const exitRequest = merchantPage.getByRole('dialog', { name: '提交退出经营申请' });
    await exitRequest.getByLabel('退出申请说明').fill('浏览器回归商家申请退出，当前没有在途订单、券、售后或账单。');
    await exitRequest.getByRole('button', { name: /确\s*认/ }).click();
    await expect(merchantPage.getByText('退出申请已提交，等待平台确认停售', { exact: true }).last()).toBeVisible();
    await expect(merchantPage.getByText('已申请退出', { exact: true }).first()).toBeVisible();

    await platformPage.goto('http://127.0.0.1:5173');
    await platformPage.getByLabel('账号').fill('platform@demo.local');
    await platformPage.getByLabel('密码').fill('Demo123456');
    await platformPage.getByRole('button', { name: '登录' }).click();
    await expect(platformPage.getByText('平台概览', { exact: true }).first()).toBeVisible();
    // Ant Design exposes the label on both the visible select wrapper and its
    // readonly search input; click the visible wrapper used by operators.
    const merchantSelector = platformPage.getByLabel('当前商家').first();
    if (!(await merchantSelector.textContent())?.includes(brandName)) {
      await merchantSelector.click();
      await platformPage.locator('.ant-select-dropdown:visible .ant-select-item-option').filter({ hasText: brandName }).click();
    }
    await expect(merchantSelector).toContainText(brandName);
    await platformPage.getByText('商家管理', { exact: true }).first().click();
    const merchantRow = () => platformPage.getByRole('row').filter({ hasText: brandName }).first();
    await expect(merchantRow()).toBeVisible();
    await merchantRow().getByRole('button', { name: '合同' }).click();
    let statusDialog = platformPage.getByRole('dialog', { name: '合同与经营状态' });
    await statusDialog.locator('.ant-select-selector').click();
    await platformPage.locator('.ant-select-dropdown:visible .ant-select-item-option').filter({ hasText: '发起离场收尾' }).click();
    await statusDialog.getByLabel('状态变更说明').fill('已核对商家退出申请，立即停止新售并保留既有履约。');
    await statusDialog.getByRole('button', { name: /确\s*认/ }).click();
    await expect(platformPage.getByText('已保存', { exact: true }).last()).toBeVisible();
    await expect(merchantRow()).toContainText('离场收尾中');

    await platformPage.getByText('离场案件', { exact: true }).first().click();
    await expect(platformPage.getByRole('heading', { name: '离场案件' })).toBeVisible();
    await expect(platformPage.getByText('已停售待履约', { exact: true }).first()).toBeVisible();
    await platformPage.getByRole('button', { name: '启动既有券履约' }).click();
    const fulfillmentDialog = platformPage.getByRole('dialog', { name: '启动既有券履约' });
    await fulfillmentDialog.getByLabel('履约启动说明').fill('运营负责人已确认空队列，并持续观察退款、售后和账单。');
    await fulfillmentDialog.getByRole('button', { name: /确\s*认/ }).click();
    await expect(platformPage.getByText('已进入既有券履约阶段', { exact: true }).last()).toBeVisible();
    await expect(platformPage.getByText('既有券履约中', { exact: true }).first()).toBeVisible();

    await platformPage.getByRole('button', { name: '确认履约完成并开放数据交付' }).click();
    const exportReadyDialog = platformPage.getByRole('dialog', { name: '确认履约完成并开放数据交付' });
    await exportReadyDialog.getByLabel('数据交付准备说明').fill('合规已复核订单、券、退款、售后和月结账单均无阻塞项。');
    await exportReadyDialog.getByRole('button', { name: /确\s*认/ }).click();
    await expect(platformPage.getByText('离场数据交付已开放', { exact: true }).last()).toBeVisible();
    await expect(platformPage.getByText('待数据交付确认', { exact: true }).first()).toBeVisible();

    await merchantPage.reload();
    await merchantPage.getByText('订单', { exact: true }).first().click();
    const orderDownload = merchantPage.waitForEvent('download');
    await merchantPage.getByRole('button', { name: '导出订单' }).click();
    expect((await orderDownload).suggestedFilename()).toMatch(/^orders-\d{8}-\d{8}\.csv$/);
    await merchantPage.getByText('券与核销', { exact: true }).first().click();
    const verificationDownload = merchantPage.waitForEvent('download');
    await merchantPage.getByRole('button', { name: '导出核销明细' }).click();
    expect((await verificationDownload).suggestedFilename()).toMatch(/^verifications-\d{8}-\d{8}\.csv$/);

    await merchantPage.getByText('退出经营', { exact: true }).first().click();
    await expect(merchantPage.getByText('待数据交付确认', { exact: true }).first()).toBeVisible();
    await merchantPage.getByRole('button', { name: '确认已完成数据导出' }).click();
    const dataConfirmation = merchantPage.getByRole('dialog', { name: '确认数据交付' });
    await dataConfirmation.getByLabel('数据交付确认说明').fill('已下载订单和核销明细，并由商家管理员完成离线留存。');
    await dataConfirmation.getByRole('button', { name: /确\s*认/ }).click();
    await expect(merchantPage.getByText('已确认数据交付', { exact: true }).last()).toBeVisible();
    await merchantPage.getByRole('button', { name: '确认授权撤销事项' }).click();
    const authorizationConfirmation = merchantPage.getByRole('dialog', { name: '确认授权撤销事项' });
    await authorizationConfirmation.getByLabel('授权撤销确认说明').fill('试点环境已完成授权撤销待办交接，未调用任何微信接口。');
    await authorizationConfirmation.getByRole('button', { name: /确\s*认/ }).click();
    await expect(merchantPage.getByText('已记录授权撤销确认', { exact: true }).last()).toBeVisible();
    await expect(merchantPage.getByText('商家已确认', { exact: true })).toHaveCount(2);

    await platformPage.getByText('商家管理', { exact: true }).first().click();
    await expect(merchantRow()).toBeVisible();
    await merchantRow().getByRole('button', { name: '合同' }).click();
    statusDialog = platformPage.getByRole('dialog', { name: '合同与经营状态' });
    await statusDialog.locator('.ant-select-selector').click();
    await platformPage.locator('.ant-select-dropdown:visible .ant-select-item-option').filter({ hasText: '确认完成离场（需通过离场检查）' }).click();
    await statusDialog.getByLabel('状态变更说明').fill('数据交付和授权撤销确认齐全，批准正式关闭商家工作区。');
    await statusDialog.getByRole('button', { name: /确\s*认/ }).click();
    await expect(platformPage.getByText('已保存', { exact: true }).last()).toBeVisible();
    await expect(merchantRow()).toContainText('已关闭');

    await platformPage.getByText('离场案件', { exact: true }).first().click();
    await expect(platformPage.getByText('已关闭', { exact: true }).first()).toBeVisible();
    const completedExitStep = platformPage.locator('.exit-step').filter({ hasText: '正式关闭' });
    await expect(completedExitStep).toContainText('已完成');

    const exitCaseResponse = await fetch(`${apiBase}/merchants/${merchantId}/exit-case`, { headers: platformHeaders });
    expect(exitCaseResponse.status).toBe(200);
    expect(await exitCaseResponse.json()).toEqual(expect.objectContaining({
      merchantId,
      status: 'CLOSED',
      dataExportConfirmed: true,
      authorizationRevocationAcknowledged: true,
    }));
  } finally {
    await merchantContext.close();
    await platformContext.close();
  }
});
