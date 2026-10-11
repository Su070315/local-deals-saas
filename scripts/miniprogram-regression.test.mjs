import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '../../../miniprogram-customer-qr');
const readCustomer = (relativePath) => readFile(join(root, relativePath), 'utf8');

test('customer detail renders both validity policies', async () => {
  const [page, template] = await Promise.all([
    readCustomer('pkgSub/pages/detail/index.js'),
    readCustomer('pkgSub/pages/detail/index.wxml'),
  ]);
  assert.match(page, /validityMode === 'PURCHASE_RELATIVE'/);
  assert.match(page, /validityDurationDays/);
  assert.match(template, /pkg\.validRange/);
});

test('customer store switching refreshes the selected store packages', async () => {
  const page = await readCustomer('pages/home/index.js');
  assert.match(page, /activeStoreId/);
  assert.match(page, /loadRemotePackages/);
  assert.match(page, /storeInfo: this\.buildStoreInfo/);
});

test('customer package templates render commercial merchandising fields', async () => {
  const [home, detail] = await Promise.all([
    readCustomer('pages/home/index.wxml'),
    readCustomer('pkgSub/pages/detail/index.wxml'),
  ]);
  assert.match(home, /pkg\.coverImageUrl/);
  assert.match(home, /pkg\.originalPriceText/);
  assert.match(home, /pkg\.tags/);
  assert.match(detail, /pkg\.purchaseNotes/);
  assert.match(detail, /pkg\.usageRules/);
  assert.match(detail, /pkg\.originalPriceText/);
});

test('customer mini-program uses the stable v1 API contract', async () => {
  const source = await readCustomer('utils/constants.js');
  assert.match(source, /\/api\/v1/);
  assert.doesNotMatch(source, /DEFAULT_API_BASE = ['"][^'"]+\/api['"]/);
});

test('customer voucher code only requests dynamic code for UNUSED vouchers', async () => {
  const page = await readCustomer('pkgSub/pages/vouchers/index.js');
  assert.match(page, /voucher\.status !== 'UNUSED'/);
  assert.match(page, /viewUsedVoucher/);
  assert.match(page, /dynamic-code/);
});

test('customer home more button opens the independent package list', async () => {
  const [page, app] = await Promise.all([
    readCustomer('pages/home/index.js'),
    readCustomer('app.json'),
  ]);
  assert.match(page, /\/pages\/packages\/index/);
  assert.match(app, /pages\/packages\/index/);
});
