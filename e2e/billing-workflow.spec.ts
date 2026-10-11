import { expect, test } from '@playwright/test';

test('merchant bill dispute is resolved through the platform finance workspace', async ({ browser }) => {
  test.setTimeout(90_000);
  const apiBase = 'http://127.0.0.1:3001/api/v1';
  const suffix = Date.now().toString(36);
  const brandName = `账单申诉回归商家-${suffix}`;
  const merchantEmail = `bill-dispute-${suffix}@demo.local`;
  const merchantPassword = 'BillDisputePassword123';
  const period = '2026-06';
  const disputeContent = '账单核销金额与门店日报存在差异，请平台复核核销明细和服务费计算。';
  const resolutionNote = '已逐笔复核核销、退款和费率快照，账单金额正确，恢复付款流程并给予新的付款宽限期。';

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
    headers: { ...platformHeaders, 'Idempotency-Key': `merchant_bill_dispute_${suffix}` },
    body: JSON.stringify({
      agencyId: agency!.id,
      legalName: `账单申诉浏览器回归主体-${suffix}`,
      brandName,
      contractNumber: `BILL-E2E-${suffix.toUpperCase()}`,
      contractEndsAt: '2030-12-31',
      rate: 0.08,
      adminName: '账单申诉回归管理员',
      adminEmail: merchantEmail,
      adminPassword: merchantPassword,
    }),
  });
  const created = await createdResponse.json() as { id?: string; message?: string | string[] };
  expect(createdResponse.status, JSON.stringify(created)).toBe(201);
  const merchantId = created.id!;

  const billResponse = await fetch(`${apiBase}/demo/merchants/${merchantId}/dispute-window-bills`, {
    method: 'POST',
    headers: platformHeaders,
    body: JSON.stringify({ period, verifiedAmountFen: 12_800, serviceFeeFen: 1_024 }),
  });
  const billBody = await billResponse.json() as { id?: string; dueAt?: string; message?: string | string[] };
  expect(billResponse.status, JSON.stringify(billBody)).toBe(201);
  const billId = billBody.id!;
  const originalDueAt = new Date(billBody.dueAt!).getTime();

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
    await merchantPage.getByText('月结账单', { exact: true }).first().click();
    await expect(merchantPage.getByRole('heading', { name: '月结账单' })).toBeVisible();
    const merchantBillRow = () => merchantPage.getByRole('row').filter({ hasText: period }).first();
    await expect(merchantBillRow()).toContainText('申诉期');
    await merchantBillRow().getByRole('button', { name: '提交申诉' }).click();
    const disputeDialog = merchantPage.getByRole('dialog', { name: '提交账单申诉' });
    await disputeDialog.getByLabel('申诉说明').fill(disputeContent);
    await disputeDialog.getByRole('button', { name: /确\s*认/ }).click();
    await expect(merchantPage.getByText('账单申诉已提交，等待平台处理', { exact: true }).last()).toBeVisible();
    await expect(merchantBillRow()).toContainText('申诉处理中');
    await expect(merchantBillRow()).toContainText('等待平台处理');

    await platformPage.goto('http://127.0.0.1:5173');
    await platformPage.getByLabel('账号').fill('platform@demo.local');
    await platformPage.getByLabel('密码').fill('Demo123456');
    await platformPage.getByRole('button', { name: '登录' }).click();
    await expect(platformPage.getByText('平台概览', { exact: true }).first()).toBeVisible();
    const merchantSelector = platformPage.getByLabel('当前商家').first();
    if (!(await merchantSelector.textContent())?.includes(brandName)) {
      await merchantSelector.click();
      await platformPage.locator('.ant-select-dropdown:visible .ant-select-item-option').filter({ hasText: brandName }).click();
    }
    await expect(merchantSelector).toContainText(brandName);
    await platformPage.getByText('月结账单', { exact: true }).first().click();
    await expect(platformPage.getByRole('heading', { name: '月结账单' })).toBeVisible();
    const platformBillRow = () => platformPage.getByRole('row').filter({ hasText: period }).first();
    await expect(platformBillRow()).toContainText('申诉处理中');
    await platformBillRow().getByRole('button', { name: '处理申诉' }).click();
    const resolutionDialog = platformPage.getByRole('dialog', { name: '处理账单申诉' });
    await expect(resolutionDialog).toContainText(disputeContent);
    await resolutionDialog.getByLabel('处理结论').fill(resolutionNote);
    await resolutionDialog.getByRole('button', { name: /确\s*认/ }).click();
    await expect(platformPage.getByText('账单申诉已处理，已恢复付款流程', { exact: true }).last()).toBeVisible();
    await expect(platformBillRow()).toContainText('待付款');
    await expect(platformBillRow()).toContainText('已处理');
    await expect(platformBillRow()).toContainText(resolutionNote);

    await merchantPage.reload();
    await merchantPage.getByText('月结账单', { exact: true }).first().click();
    await expect(merchantBillRow()).toContainText('待付款');
    await expect(merchantBillRow()).toContainText('已处理');
    await expect(merchantBillRow()).toContainText(resolutionNote);

    const billsResponse = await fetch(`${apiBase}/bills?merchantId=${merchantId}`, { headers: platformHeaders });
    expect(billsResponse.status).toBe(200);
    const bill = (await billsResponse.json() as Array<{ id: string; status: string; dueAt: string; dispute: { status: string; content: string; resolutionNote: string } | null }>).find((item) => item.id === billId);
    expect(bill).toEqual(expect.objectContaining({
      id: billId,
      status: 'CONFIRMED',
      dispute: expect.objectContaining({ status: 'RESOLVED', content: disputeContent, resolutionNote }),
    }));
    expect(new Date(bill!.dueAt).getTime()).toBeGreaterThanOrEqual(originalDueAt);
    expect(new Date(bill!.dueAt).getTime()).toBeGreaterThan(Date.now() + 4 * 86_400_000);
  } finally {
    await merchantContext.close();
    await platformContext.close();
  }
});
