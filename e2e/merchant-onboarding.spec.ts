import { expect, test } from '@playwright/test';

const apiBase = 'http://127.0.0.1:3001/api/v1';

type LoginResponse = { token: string; user: { agencyId?: string | null } };

async function login(email: string, password = 'Demo123456'): Promise<LoginResponse> {
  const response = await fetch(`${apiBase}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'http://127.0.0.1:5173' },
    body: JSON.stringify({ email, password }),
  });
  expect(response.status).toBe(201);
  return response.json() as Promise<LoginResponse>;
}

test('platform completes merchant import, administrator invite, and first login', async ({ page, browser }) => {
  test.setTimeout(120_000);
  const platform = await login('platform@demo.local');
  const agenciesResponse = await fetch(`${apiBase}/agencies`, { headers: { Authorization: `Bearer ${platform.token}` } });
  expect(agenciesResponse.status).toBe(200);
  const agencies = await agenciesResponse.json() as Array<{ id: string; name: string; active: boolean }>;
  const agency = agencies.find((item) => item.active);
  expect(agency).toBeTruthy();

  const suffix = Date.now().toString(36);
  const brandName = `浏览器导入商家-${suffix}`;
  const legalName = `浏览器导入主体-${suffix}`;
  const adminEmail = `browser-onboarding-${suffix}@demo.local`;
  const adminPassword = 'BrowserInvitePassword123';

  await page.goto('http://127.0.0.1:5173');
  await page.getByLabel('账号').fill('platform@demo.local');
  await page.getByLabel('密码').fill('Demo123456');
  await page.getByRole('button', { name: '登录' }).click();
  await page.getByText('商家管理', { exact: true }).first().click();
  await expect(page.getByRole('heading', { name: '商家管理' })).toBeVisible();

  await page.getByRole('button', { name: '批量导入' }).click();
  const drawer = page.locator('.ant-drawer').filter({ hasText: '批量导入商家' }).last();
  await expect(drawer).toBeVisible();
  const agencySelect = drawer.locator('.ant-select-selector').first();
  await agencySelect.click();
  await page.locator('.ant-select-dropdown:visible .ant-select-item-option').filter({ hasText: agency!.name }).click();
  await drawer.getByLabel('商家 CSV 内容').fill([
    'externalRef,legalName,brandName,servicePhone',
    `browser-${suffix},${legalName},${brandName},020-0000-${suffix.slice(-4)}`,
  ].join('\n'));
  await expect(drawer).toContainText('已解析 1 家商家，可提交');
  await drawer.getByRole('button', { name: '提交导入任务' }).click();
  await expect(page.getByText(/导入任务已创建：/)).toBeVisible();
  const currentStatus = drawer.getByText(/^状态：/).first();
  await expect.poll(async () => (await currentStatus.textContent()) || '', { timeout: 30_000, intervals: [500, 1_000, 2_000] }).toMatch(/已完成|部分完成|失败/);
  await expect(drawer.getByRole('row').filter({ hasText: brandName })).toBeVisible({ timeout: 30_000 });

  await drawer.getByRole('button', { name: '关闭' }).click();
  const merchantRow = page.getByRole('row').filter({ hasText: brandName }).first();
  await expect(merchantRow).toBeVisible({ timeout: 30_000 });
  await merchantRow.getByRole('button', { name: '邀请管理员' }).click();

  const inviteModal = page.getByRole('dialog', { name: `邀请 ${brandName} 管理员` });
  await expect(inviteModal).toBeVisible();
  await inviteModal.getByLabel('管理员姓名').fill('浏览器邀请管理员');
  await inviteModal.getByLabel('管理员登录账号').fill(adminEmail);
  await inviteModal.getByRole('button', { name: '生成一次性邀请' }).click();
  await expect(inviteModal).toContainText('邀请已生成，仅显示本次令牌');
  const inviteToken = await inviteModal.locator('input').first().inputValue();
  expect(inviteToken).toMatch(/^[A-Za-z0-9_-]{32,}$/);

  // The token stays in the fragment, so it is not sent as a request URL or
  // persisted in the platform workspace session. Use a separate context to
  // model the recipient opening the link on another device.
  const inviteContext = await browser.newContext();
  const invitePage = await inviteContext.newPage();
  try {
    await invitePage.goto(`http://127.0.0.1:5173/#merchant-admin-invite=${encodeURIComponent(inviteToken)}`);
    await expect(invitePage.getByRole('heading', { name: '设置商家管理员密码' })).toBeVisible();
    await invitePage.getByLabel('登录密码').fill(adminPassword);
    await invitePage.getByLabel('再次输入密码').fill(adminPassword);
    await invitePage.getByRole('button', { name: '开通管理员账号' }).click();
    await expect(invitePage.getByRole('status')).toContainText('管理员账号已开通');
  } finally {
    await inviteContext.close();
  }

  const merchantContext = await browser.newContext();
  const merchantPage = await merchantContext.newPage();
  try {
    await merchantPage.goto('http://127.0.0.1:5175');
    await merchantPage.getByLabel('账号').fill(adminEmail);
    await merchantPage.getByLabel('密码').fill(adminPassword);
    await merchantPage.getByRole('button', { name: '登录' }).click();
    await expect(merchantPage.getByText('经营概览', { exact: true }).first()).toBeVisible();
    await expect(merchantPage.getByText(brandName, { exact: true }).first()).toBeVisible();
  } finally {
    await merchantContext.close();
  }
});

test('agency import keeps tenant ownership fixed and rejects financial columns', async ({ page }) => {
  await page.goto('http://127.0.0.1:5174');
  await page.getByLabel('账号').fill('agency@demo.local');
  await page.getByLabel('密码').fill('Demo123456');
  await page.getByRole('button', { name: '登录' }).click();
  await page.getByText('名下商家', { exact: true }).first().click();
  await expect(page.getByRole('heading', { name: '名下商家' })).toBeVisible();

  await page.getByRole('button', { name: '批量导入' }).click();
  const drawer = page.locator('.ant-drawer').filter({ hasText: '批量导入商家' }).last();
  await expect(drawer).toBeVisible();
  await expect(drawer.getByText(/导入至当前代理商/)).toBeVisible();
  await expect(drawer.getByLabel('导入归属代理商')).toHaveCount(0);
  await drawer.getByLabel('商家 CSV 内容').fill([
    'externalRef,legalName,brandName,servicePhone,rate',
    'agency-finance-column,代理主体,代理品牌,020-0000-0000,0.05',
  ].join('\n'));
  await expect(drawer).toContainText('代理端导入不能包含合同或服务费率列');
  await expect(drawer.getByRole('button', { name: '提交导入任务' })).toBeDisabled();
});
