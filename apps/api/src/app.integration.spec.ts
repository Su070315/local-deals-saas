import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { createHmac, randomUUID } from 'crypto';
import jwt from 'jsonwebtoken';
import { DataSource } from 'typeorm';
import { AppModule } from './app.module';
import { configureApiVersioning } from './api-versioning';
import { PackageService } from './package.service';
import { BatchOperationService } from './batch-operation.service';
import { MerchantImportService } from './merchant-import.service';
import { ExportService } from './export.service';
import { AuthService } from './auth.service';
import { AccountingAdjustmentStatus, Agency, AuditLog, AuditOutbox, AuditOutboxStatus, BatchOperation, BatchOperationStatus, BillAdjustment, BillPaymentConfirmationRequestStatus, BillStatus, CommissionRateVersion, DealPackage, ExceptionRefundApprovalStatus, ExportJob, ExportJobStatus, ExportKind, InvoiceStatus, LoginThrottle, Merchant, MerchantExitCase, MerchantImportOperation, MerchantPaymentProfile, MerchantRegistration, MerchantStatus, MerchantStatusChangeCommand, MonthlyBill, MonthlyBillGenerationCommand, NotificationChannel, NotificationOutbox, NotificationOutboxStatus, Order, OrderStatus, PackageStatus, PackageStore, PaymentEvent, PaymentEventStatus, PaymentEventType, PaymentOutbox, PaymentOutboxStatus, PlatformAccessProfile, RateChangeRequest, RateChangeRequestStatus, Refund, RequestThrottle, SettlementLedgerEntry, StaffActiveCommand, Store, SupportTicket, SupportTicketSource, SupportTicketStatus, SupportTicketType, User, UserRole, Verification, Voucher, VoucherStatus } from './domain/entities';
import { RequestThrottleService } from './request-throttle.service';
import { AuditChainService } from './audit-chain.service';
import { AuditOutboxService } from './audit-outbox.service';
import { NotificationOutboxService } from './notifications/notification-outbox.service';
import { MockNotificationProvider } from './notifications/notification-provider';
import { AuditReadService } from './audit-read.service';
import { LifecycleOrchestrationService } from './lifecycle-orchestration.service';
import { BillingService } from './billing.service';
import { PaymentProcessingService } from './payment-processing.service';
import { SeedService } from './seed.service';
import { MockPaymentProvider, PAYMENT_PROVIDER } from './payments/payment-provider';
import { throttleKeySecret } from './runtime-config';
import { CUSTOMER_TOKEN_AUDIENCE, OPERATOR_TOKEN_AUDIENCE, TOKEN_ISSUER } from './token-policy';

describe('tenant boundary integration', () => {
  let app: INestApplication;
  let baseUrl: string;
  let generatedOrderRequestCount = 0;

  async function request(path: string, init: RequestInit = {}) {
    let nextInit = init;
    if (init.method === 'POST' && /^\/api\/public\/merchants\/[^/]+\/orders$/.test(path) && typeof init.body === 'string') {
      const body = JSON.parse(init.body) as Record<string, unknown>;
      if (!Object.prototype.hasOwnProperty.call(body, 'idempotencyKey')) {
        nextInit = { ...init, body: JSON.stringify({ ...body, idempotencyKey: `test-order-${++generatedOrderRequestCount}` }) };
      }
    }
    return fetch(`${baseUrl}${path}`, nextInit);
  }

  async function login(email: string, password = 'Demo123456', userAgent?: string) {
    const response = await request('/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...(userAgent ? { 'User-Agent': userAgent } : {}) }, body: JSON.stringify({ email, password }),
    });
    expect(response.status).toBe(201);
    const payload = await response.json() as { token: string; user: { id: string; merchantId?: string; platformAccessProfile?: PlatformAccessProfile | null } & Record<string, unknown> };
    expect(payload.user).not.toHaveProperty('passwordHash');
    expect(payload.user).not.toHaveProperty('sessionVersion');
    return payload;
  }

  async function customerSession() {
    const response = await request('/api/public/demo/customer-sessions', { method: 'POST' });
    expect(response.status).toBe(201);
    const { token } = await response.json() as { token: string };
    return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  }

  beforeAll(async () => {
    process.env.RUN_LIFECYCLE_WORKER = 'false';
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }));
    app.setGlobalPrefix('api');
    configureApiVersioning(app);
    await app.init();
    await app.get(SeedService).seed();
    await app.listen(0);
    const address = app.getHttpServer().address();
    if (!address || typeof address === 'string') throw new Error('test server did not bind a port');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await app.close();
    delete process.env.RUN_LIFECYCLE_WORKER;
  });

  it('keeps public store data and employee responses minimal', async () => {
    const platform = await login('platform@demo.local');
    const merchants = await (await request('/api/merchants', { headers: { Authorization: `Bearer ${platform.token}` } })).json() as Array<{ id: string; brandName: string }>;
    const merchant = merchants.find((item) => item.brandName === '花时间花艺')!;
    const publicStore = await (await request(`/api/public/merchants/${merchant.id}`)).json() as { merchant: Record<string, unknown> };
    expect(publicStore.merchant).toEqual(expect.objectContaining({ brandName: '花时间花艺' }));
    expect(publicStore.merchant).not.toHaveProperty('legalName');
    expect(publicStore.merchant).not.toHaveProperty('contractNumber');
    expect(publicStore.merchant).not.toHaveProperty('agencyId');

    const merchantAdmin = await login('merchant@demo.local');
    const users = await (await request(`/api/merchants/${merchant.id}/users`, { headers: { Authorization: `Bearer ${merchantAdmin.token}` } })).json() as Array<Record<string, unknown>>;
    expect(users.length).toBeGreaterThan(0);
    expect(users.every((user) => !('passwordHash' in user) && !('sessionVersion' in user))).toBe(true);
  });

  it('binds a Huifu merchant account to one internal merchant through a finance-only profile', async () => {
    const platform = await login('platform@demo.local');
    const agency = await login('agency@demo.local');
    const operations = await login('platform-operations@demo.local');
    const headers = { Authorization: `Bearer ${platform.token}`, 'Content-Type': 'application/json' };
    const merchant = (await (await request('/api/merchants', { headers })).json() as Array<{ id: string; brandName: string }>).find((item) => item.brandName === '花时间花艺')!;
    const path = `/api/merchants/${merchant.id}/payment-profile`;
    const dataSource = app.get(DataSource);
    try {
      const empty = await request(path, { headers });
      expect(empty.status).toBe(200);
      expect(await empty.json()).toEqual(expect.objectContaining({ profile: null, suggestedExternalMerchantNo: expect.stringMatching(/^XYM_/) }));
      const agencyHeaders = { Authorization: `Bearer ${agency.token}`, 'Content-Type': 'application/json' };
      const operationsHeaders = { Authorization: `Bearer ${operations.token}`, 'Content-Type': 'application/json' };
      expect((await request(path, { headers: agencyHeaders })).status).toBe(200);
      // 未填写该通道商户号时不得直接启用收款（provider 必须显式指定为非微信直连通道）
      expect((await request(path, { method: 'PUT', headers, body: JSON.stringify({ provider: 'HUIFU', externalMerchantNo: 'XYM_FLOWER_DEMO_001', status: 'ACTIVE', activationConfirmed: true }) })).status).toBe(400);
      const submitted = await request(path, { method: 'PUT', headers: agencyHeaders, body: JSON.stringify({ provider: 'HUIFU', externalMerchantNo: 'XYM_FLOWER_DEMO_001', huifuId: '666600009999', applicationNo: 'APPLY_FLOWER_001', status: 'PENDING', activationConfirmed: false }) });
      expect(submitted.status).toBe(200);
      expect((await submitted.json() as { profile: Record<string, unknown> }).profile).toEqual(expect.objectContaining({ status: 'PENDING', externalMerchantNo: 'XYM_FLOWER_DEMO_001', providerMerchantId: '666600009999' }));
      // finance-only：非财务职责的平台账号（运营）不得启用收款通道
      expect((await request(path, { method: 'PUT', headers: operationsHeaders, body: JSON.stringify({ provider: 'HUIFU', externalMerchantNo: 'XYM_FLOWER_DEMO_001', huifuId: '666600009999', status: 'ACTIVE', activationConfirmed: true }) })).status).toBe(403);
      const saved = await request(path, { method: 'PUT', headers, body: JSON.stringify({ provider: 'HUIFU', externalMerchantNo: 'XYM_FLOWER_DEMO_001', huifuId: '666600009999', applicationNo: 'APPLY_FLOWER_001', status: 'ACTIVE', activationConfirmed: true }) });
      expect(saved.status).toBe(200);
      expect((await saved.json() as { profile: Record<string, unknown> }).profile).toEqual(expect.objectContaining({ providerMerchantId: '666600009999', status: 'ACTIVE', externalMerchantNo: 'XYM_FLOWER_DEMO_001' }));
      expect((await request(path, { method: 'PUT', headers: operationsHeaders, body: JSON.stringify({ provider: 'HUIFU', externalMerchantNo: 'XYM_FLOWER_DEMO_001', huifuId: '666600009999', status: 'PENDING', activationConfirmed: false }) })).status).toBe(403);
      expect((await request(path, { method: 'PUT', headers, body: JSON.stringify({ provider: 'HUIFU', externalMerchantNo: 'XYM_CHANGED_001', huifuId: '666600009999', status: 'ACTIVE', activationConfirmed: true }) })).status).toBe(409);
    } finally {
      await dataSource.getRepository(MerchantPaymentProfile).delete({ merchantId: merchant.id });
    }
  });

  it('publishes and audits commercial package merchandising fields', async () => {
    const merchantAdmin = await login('merchant@demo.local');
    const headers = { Authorization: `Bearer ${merchantAdmin.token}`, 'Content-Type': 'application/json' };
    const merchants = await (await request('/api/merchants', { headers })).json() as Array<{ id: string; brandName: string }>;
    const merchant = merchants.find((item) => item.brandName === '花时间花艺')!;
    const packages = await (await request(`/api/merchants/${merchant.id}/packages`, { headers })).json() as Array<Record<string, any>>;
    const source = packages.find((item) => item.title === '单支鲜花花束')!;
    const updated = await request(`/api/merchants/${merchant.id}/packages`, { method: 'POST', headers, body: JSON.stringify({
      id: source.id, expectedVersion: source.version, title: source.title, description: source.description, priceFen: source.priceFen, saleLimit: source.saleLimit, perCustomerLimit: source.perCustomerLimit, storeIds: source.storeIds, status: source.status, originalPriceFen: 5990, coverImageUrl: 'https://cdn.example.test/demo-cover.jpg', tags: ['招牌', '节日'], purchaseNotes: '购买前请确认门店。', usageRules: '到店出示动态码。',
      validFrom: String(source.validFrom).slice(0, 10), validTo: String(source.validTo).slice(0, 10),
    }) });
    expect(updated.status).toBe(201);
    const publicPackages = await (await request(`/api/public/merchants/${merchant.id}/packages`)).json() as Array<Record<string, any>>;
    expect(publicPackages.find((item) => item.id === source.id)).toEqual(expect.objectContaining({ originalPriceFen: 5990, coverImageUrl: 'https://cdn.example.test/demo-cover.jpg', tags: ['招牌', '节日'], purchaseNotes: '购买前请确认门店。', usageRules: '到店出示动态码。' }));
    const versions = await (await request(`/api/merchants/${merchant.id}/packages/${source.id}/versions`, { headers })).json() as Array<Record<string, any>>;
    expect(versions[0]).toEqual(expect.objectContaining({ originalPriceFen: 5990, tags: ['招牌', '节日'] }));
  });

  it('dual-writes package stores and prefers relational mappings over legacy JSON', async () => {
    const merchantAdmin = await login('merchant@demo.local');
    const headers = { Authorization: `Bearer ${merchantAdmin.token}`, 'Content-Type': 'application/json' };
    const merchant = (await (await request('/api/merchants', { headers })).json() as Array<{ id: string; brandName: string }>).find((item) => item.brandName === '花时间花艺')!;
    const stores = await (await request(`/api/merchants/${merchant.id}/stores`, { headers })).json() as Array<{ id: string }>;
    const firstStore = stores[0];
    const secondStore = await (await request(`/api/merchants/${merchant.id}/stores`, {
      method: 'POST', headers, body: JSON.stringify({ name: '关系映射测试门店', address: '广州市天河区关系映射路 1 号', openForSale: true }),
    })).json() as { id: string };
    const dataSource = app.get(DataSource);
    let packageId: string | undefined;
    let orderId: string | undefined;
    try {
      const created = await (await request(`/api/merchants/${merchant.id}/packages`, {
        method: 'POST', headers,
        body: JSON.stringify({ title: `关系映射套餐-${randomUUID().slice(0, 8)}`, description: '验证关系表优先读取。', priceFen: 990, saleLimit: 10, perCustomerLimit: 2, storeIds: [firstStore.id], validFrom: '2026-01-01', validTo: '2027-12-31', status: PackageStatus.ON_SALE }),
      })).json() as { id: string };
      packageId = created.id;
      const mappings = await dataSource.getRepository(PackageStore).findBy({ packageId: created.id });
      expect(mappings).toHaveLength(1);
      expect(mappings[0]).toEqual(expect.objectContaining({ storeId: firstStore.id, merchantId: merchant.id }));

      // Simulate an old writer or a manually restored legacy row diverging from
      // the new relation. Public reads and order validation must remain strict.
      await dataSource.getRepository(DealPackage).update(created.id, { storeIds: [secondStore.id] });
      const publicPackages = await (await request(`/api/public/merchants/${merchant.id}/packages`)).json() as Array<{ id: string; storeIds: string[] }>;
      expect(publicPackages.find((deal) => deal.id === created.id)?.storeIds).toEqual([firstStore.id]);
      const customer = await customerSession();
      expect((await request(`/api/public/merchants/${merchant.id}/orders`, { method: 'POST', headers: customer, body: JSON.stringify({ packageId: created.id, storeId: secondStore.id, quantity: 1 }) })).status).toBe(400);
      const successfulOrder = await request(`/api/public/merchants/${merchant.id}/orders`, { method: 'POST', headers: customer, body: JSON.stringify({ packageId: created.id, storeId: firstStore.id, quantity: 1 }) });
      expect(successfulOrder.status).toBe(201);
      orderId = (await successfulOrder.json() as { id: string }).id;
    } finally {
      if (orderId) await dataSource.getRepository(PaymentOutbox).delete({ orderId });
      if (orderId) await dataSource.getRepository(Order).delete(orderId);
      if (packageId) await dataSource.getRepository(PackageStore).delete({ packageId });
      if (packageId) await dataSource.getRepository(DealPackage).delete(packageId);
      await dataSource.getRepository(Store).delete(secondStore.id);
    }
  });

  it('runs idempotent version-checked package status batches with durable per-item results', async () => {
    const platform = await login('platform@demo.local');
    const headers = { Authorization: `Bearer ${platform.token}`, 'Content-Type': 'application/json' };
    const merchant = (await (await request('/api/merchants', { headers })).json() as Array<{ id: string; brandName: string }>).find((item) => item.brandName === '花时间花艺')!;
    const store = (await (await request(`/api/merchants/${merchant.id}/stores`, { headers })).json() as Array<{ id: string }>)[0];
    const created = await (await request(`/api/merchants/${merchant.id}/packages`, {
      method: 'POST', headers,
      body: JSON.stringify({ title: `批量任务套餐-${randomUUID().slice(0, 8)}`, description: '验证异步批量状态任务。', priceFen: 1290, saleLimit: 20, perCustomerLimit: 2, storeIds: [store.id], validFrom: '2026-01-01', validTo: '2027-12-31', status: PackageStatus.DRAFT }),
    })).json() as { id: string; version: number };
    const dataSource = app.get(DataSource);
    try {
      const key = 'package-status-batch-001';
      const body = JSON.stringify({ status: PackageStatus.ON_SALE, note: '试点前统一上架已复核套餐。', items: [{ packageId: created.id, expectedVersion: created.version }] });
      const submitted = await request(`/api/merchants/${merchant.id}/packages/batch-status`, { method: 'POST', headers: { ...headers, 'Idempotency-Key': key }, body });
      expect(submitted.status).toBe(201);
      const operation = await submitted.json() as { id: string; status: string; idempotencyKey?: string; requestHash?: string };
      expect(operation.status).toBe(BatchOperationStatus.PENDING);
      expect(operation).not.toHaveProperty('idempotencyKey');
      expect(operation).not.toHaveProperty('requestHash');
      const replay = await request(`/api/merchants/${merchant.id}/packages/batch-status`, { method: 'POST', headers: { ...headers, 'Idempotency-Key': key }, body });
      expect(replay.status).toBe(201);
      expect((await replay.json() as { id: string }).id).toBe(operation.id);
      expect((await request(`/api/merchants/${merchant.id}/packages/batch-status`, { method: 'POST', headers: { ...headers, 'Idempotency-Key': key }, body: JSON.stringify({ status: PackageStatus.OFF_SALE, note: '同一请求键不能改目标状态。', items: [{ packageId: created.id, expectedVersion: created.version }] }) })).status).toBe(409);
      expect(await app.get(BatchOperationService).processPending()).toBeGreaterThanOrEqual(1);
      const completed = await (await request(`/api/batch-operations/${operation.id}`, { headers })).json() as { status: string; succeededCount: number; failedCount: number; results: Array<{ packageId: string; ok: boolean; version: number }> };
      expect(completed).toEqual(expect.objectContaining({ status: BatchOperationStatus.COMPLETED, succeededCount: 1, failedCount: 0 }));
      expect(completed.results).toEqual([expect.objectContaining({ packageId: created.id, ok: true, version: created.version + 1 })]);
      expect(await dataSource.getRepository(DealPackage).findOneByOrFail({ id: created.id })).toEqual(expect.objectContaining({ status: PackageStatus.ON_SALE, version: created.version + 1 }));

      const stale = await request(`/api/merchants/${merchant.id}/packages/batch-status`, {
        method: 'POST', headers: { ...headers, 'Idempotency-Key': 'package-status-batch-stale-001' },
        body: JSON.stringify({ status: PackageStatus.OFF_SALE, note: '旧页面版本必须逐项失败。', items: [{ packageId: created.id, expectedVersion: created.version }] }),
      });
      const staleOperation = await stale.json() as { id: string };
      await app.get(BatchOperationService).processPending();
      expect(await dataSource.getRepository(BatchOperation).findOneByOrFail({ id: staleOperation.id })).toEqual(expect.objectContaining({ status: BatchOperationStatus.FAILED, succeededCount: 0, failedCount: 1 }));
      expect(await dataSource.getRepository(AuditLog).countBy({ action: 'PACKAGE_BATCH_STATUS_CHANGED', resourceId: created.id })).toBe(1);

      const merchantAdmin = await login('merchant@demo.local');
      const otherMerchant = (await (await request('/api/merchants', { headers })).json() as Array<{ id: string }>).find((item) => item.id !== merchant.id)!;
      expect((await request(`/api/merchants/${otherMerchant.id}/packages/batch-status`, { method: 'POST', headers: { Authorization: `Bearer ${merchantAdmin.token}`, 'Content-Type': 'application/json', 'Idempotency-Key': 'cross-tenant-package-batch' }, body })).status).toBe(403);
    } finally {
      await dataSource.getRepository(PackageStore).delete({ packageId: created.id });
      await dataSource.getRepository(DealPackage).delete(created.id);
    }
  });

  it('runs idempotent staff store-access batches and revokes stale verifier sessions', async () => {
    const platform = await login('platform@demo.local');
    const headers = { Authorization: `Bearer ${platform.token}`, 'Content-Type': 'application/json' };
    const merchant = (await (await request('/api/merchants', { headers })).json() as Array<{ id: string; brandName: string }>).find((item) => item.brandName === '花时间花艺')!;
    const suffix = randomUUID().slice(0, 8);
    const staffEmail = `batch-access-${suffix}@demo.local`;
    const staffPassword = 'BatchAccessPassword123';
    const storeIds: string[] = [];
    let staffId: string | undefined;
    const dataSource = app.get(DataSource);
    try {
      for (const label of ['批量授权甲', '批量授权乙']) {
        const response = await request(`/api/merchants/${merchant.id}/stores`, {
          method: 'POST', headers,
          body: JSON.stringify({ name: `${label}-${suffix}`, address: '批量授权回归地址', openForSale: true, openForVerification: true }),
        });
        expect(response.status).toBe(201);
        storeIds.push((await response.json() as { id: string }).id);
      }
      const staffResponse = await request(`/api/merchants/${merchant.id}/staff`, {
        method: 'POST', headers,
        body: JSON.stringify({ email: staffEmail, name: '批量授权回归员工', password: staffPassword, storeIds: [storeIds[0]] }),
      });
      expect(staffResponse.status).toBe(201);
      const staff = await staffResponse.json() as { id: string; storeIds: string[] };
      staffId = staff.id;
      const staffSession = await login(staffEmail, staffPassword);
      const key = `staff-access-batch-${suffix}`;
      const body = JSON.stringify({ note: '门店轮班授权已由运营复核。', items: [{ staffId, expectedStoreIds: [storeIds[0]], storeIds: [storeIds[1]] }] });
      const submitted = await request(`/api/merchants/${merchant.id}/staff/batch-store-access`, { method: 'POST', headers: { ...headers, 'Idempotency-Key': key }, body });
      expect(submitted.status).toBe(201);
      const operation = await submitted.json() as { id: string; status: string; idempotencyKey?: string; requestHash?: string };
      expect(operation.status).toBe(BatchOperationStatus.PENDING);
      expect(operation).not.toHaveProperty('idempotencyKey');
      expect(operation).not.toHaveProperty('requestHash');
      const replay = await request(`/api/merchants/${merchant.id}/staff/batch-store-access`, { method: 'POST', headers: { ...headers, 'Idempotency-Key': key }, body });
      expect(replay.status).toBe(201);
      expect((await replay.json() as { id: string }).id).toBe(operation.id);
      const changedReplay = await request(`/api/merchants/${merchant.id}/staff/batch-store-access`, {
        method: 'POST', headers: { ...headers, 'Idempotency-Key': key },
        body: JSON.stringify({ note: '同一请求标识不能更换目标门店。', items: [{ staffId, expectedStoreIds: [storeIds[0]], storeIds: [storeIds[0]] }] }),
      });
      expect(changedReplay.status).toBe(409);
      const merchantAdmin = await login('merchant@demo.local');
      const otherMerchant = (await (await request('/api/merchants', { headers })).json() as Array<{ id: string }>).find((item) => item.id !== merchant.id)!;
      expect((await request(`/api/merchants/${otherMerchant.id}/staff/batch-store-access`, {
        method: 'POST', headers: { Authorization: `Bearer ${merchantAdmin.token}`, 'Content-Type': 'application/json', 'Idempotency-Key': `cross-tenant-staff-${suffix}` }, body,
      })).status).toBe(403);
      expect(await app.get(BatchOperationService).processPending()).toBeGreaterThanOrEqual(1);
      const completed = await (await request(`/api/batch-operations/${operation.id}`, { headers })).json() as { status: string; succeededCount: number; failedCount: number; results: Array<{ staffId: string; ok: boolean; storeIds: string[] }> };
      expect(completed).toEqual(expect.objectContaining({ status: BatchOperationStatus.COMPLETED, succeededCount: 1, failedCount: 0 }));
      expect(completed.results).toEqual([expect.objectContaining({ staffId, ok: true, storeIds: [storeIds[1]] })]);
      expect((await request('/api/auth/me', { headers: { Authorization: `Bearer ${staffSession.token}` } })).status).toBe(401);
      const updated = (await (await request(`/api/merchants/${merchant.id}/users`, { headers })).json() as Array<{ id: string; storeIds: string[] }>).find((item) => item.id === staffId)!;
      expect(updated.storeIds).toEqual([storeIds[1]]);
      const stale = await request(`/api/merchants/${merchant.id}/staff/batch-store-access`, {
        method: 'POST', headers: { ...headers, 'Idempotency-Key': `staff-access-stale-${suffix}` },
        body: JSON.stringify({ note: '旧授权版本必须逐项失败。', items: [{ staffId, expectedStoreIds: [storeIds[0]], storeIds: [storeIds[0]] }] }),
      });
      expect(stale.status).toBe(201);
      const staleOperation = await stale.json() as { id: string };
      await app.get(BatchOperationService).processPending();
      expect(await dataSource.getRepository(BatchOperation).findOneByOrFail({ id: staleOperation.id })).toEqual(expect.objectContaining({ status: BatchOperationStatus.FAILED, succeededCount: 0, failedCount: 1 }));
      const refreshedStaffSession = await login(staffEmail, staffPassword);
      const directUpdate = await request(`/api/merchants/${merchant.id}/staff`, {
        method: 'POST', headers,
        body: JSON.stringify({ id: staffId, email: staffEmail, name: '批量授权回归员工', storeIds: [storeIds[0]] }),
      });
      expect(directUpdate.status).toBe(201);
      expect((await request('/api/auth/me', { headers: { Authorization: `Bearer ${refreshedStaffSession.token}` } })).status).toBe(401);
    } finally {
      if (staffId) await dataSource.getRepository(User).delete(staffId);
      for (const storeId of storeIds) await dataSource.getRepository(Store).delete(storeId);
    }
  });

  it('enforces the configured browser workspace role before creating an operator session', async () => {
    const previous = process.env.WORKSPACE_ORIGIN_ROLES;
    process.env.WORKSPACE_ORIGIN_ROLES = JSON.stringify({
      'https://platform.example.test': 'PLATFORM_ADMIN',
      'https://agency.example.test': 'AGENCY_ADMIN',
      'https://merchant.example.test': 'MERCHANT_ADMIN',
      'https://verify.example.test': 'STORE_STAFF',
    });
    try {
      const wrongWorkspace = await request('/api/auth/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://platform.example.test' }, body: JSON.stringify({ email: 'merchant@demo.local', password: 'Demo123456' }),
      });
      expect(wrongWorkspace.status).toBe(401);
      const unknownWorkspace = await request('/api/auth/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://unknown.example.test' }, body: JSON.stringify({ email: 'platform@demo.local', password: 'Demo123456' }),
      });
      expect(unknownWorkspace.status).toBe(403);
      const correctWorkspace = await request('/api/auth/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://platform.example.test' }, body: JSON.stringify({ email: 'platform@demo.local', password: 'Demo123456' }),
      });
      expect(correctWorkspace.status).toBe(201);
      const wrongVerifierWorkspace = await request('/api/auth/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://verify.example.test' }, body: JSON.stringify({ email: 'platform@demo.local', password: 'Demo123456' }),
      });
      expect(wrongVerifierWorkspace.status).toBe(401);
      const verifierWorkspace = await request('/api/auth/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://verify.example.test' }, body: JSON.stringify({ email: 'staff@demo.local', password: 'Demo123456' }),
      });
      expect(verifierWorkspace.status).toBe(201);
      const missingNativeMarker = await request('/api/auth/verifier-login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'staff@demo.local', password: 'Demo123456' }),
      });
      expect(missingNativeMarker.status).toBe(403);
      const browserAtNativeMarker = await request('/api/auth/verifier-login', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://verify.example.test', 'X-Operator-Client': 'verifier-miniprogram-v1' }, body: JSON.stringify({ email: 'staff@demo.local', password: 'Demo123456' }),
      });
      expect(browserAtNativeMarker.status).toBe(403);
      const nativeVerifier = await request('/api/auth/verifier-login', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Operator-Client': 'verifier-miniprogram-v1' }, body: JSON.stringify({ email: 'staff@demo.local', password: 'Demo123456' }),
      });
      expect(nativeVerifier.status).toBe(201);
      const privilegedNativeAttempt = await request('/api/auth/verifier-login', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Operator-Client': 'verifier-miniprogram-v1' }, body: JSON.stringify({ email: 'platform@demo.local', password: 'Demo123456' }),
      });
      expect(privilegedNativeAttempt.status).toBe(401);

      process.env.WORKSPACE_ORIGIN_ROLES = JSON.stringify({ 'https://ops.example.test': 'ALL' });
      for (const email of ['platform@demo.local', 'agency@demo.local', 'merchant@demo.local', 'staff@demo.local']) {
        const unifiedPortalLogin = await request('/api/auth/login', {
          method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://ops.example.test' }, body: JSON.stringify({ email, password: 'Demo123456' }),
        });
        expect(unifiedPortalLogin.status).toBe(201);
      }
      const unknownUnifiedPortal = await request('/api/auth/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://unknown.example.test' }, body: JSON.stringify({ email: 'platform@demo.local', password: 'Demo123456' }),
      });
      expect(unknownUnifiedPortal.status).toBe(403);
    } finally {
      if (previous === undefined) delete process.env.WORKSPACE_ORIGIN_ROLES;
      else process.env.WORKSPACE_ORIGIN_ROLES = previous;
    }
  });

  it('requires recent per-session password confirmation for sensitive financial changes when enforcement is enabled', async () => {
    const previous = process.env.ENFORCE_SENSITIVE_ACTION_STEP_UP;
    process.env.ENFORCE_SENSITIVE_ACTION_STEP_UP = 'true';
    try {
      const platform = await login('platform@demo.local', 'Demo123456', 'sensitive-action-session-a');
      const headers = { Authorization: `Bearer ${platform.token}`, 'Content-Type': 'application/json' };
      const merchant = (await (await request('/api/merchants', { headers })).json() as Array<{ id: string; brandName: string }>).find((item) => item.brandName === '花时间花艺')!;
      const ratePayload = JSON.stringify({ rate: 0.1234, effectiveFrom: '2031-02-03', note: '敏感操作确认后的费率申请。' });
      expect((await request(`/api/merchants/${merchant.id}/rates`, {
        method: 'POST', headers: { ...headers, 'Idempotency-Key': 'sensitive-step-up-rate-a' }, body: ratePayload,
      })).status).toBe(403);
      expect((await request('/api/exports', {
        method: 'POST', headers, body: JSON.stringify({ kind: 'orders', merchantId: merchant.id }),
      })).status).toBe(403);
      expect((await request('/api/auth/sensitive-action/verify', {
        method: 'POST', headers, body: JSON.stringify({ currentPassword: 'wrong-password' }),
      })).status).toBe(401);
      const verified = await request('/api/auth/sensitive-action/verify', {
        method: 'POST', headers, body: JSON.stringify({ currentPassword: 'Demo123456' }),
      });
      expect(verified.status).toBe(201);
      expect(await verified.json()).toEqual(expect.objectContaining({ verifiedAt: expect.any(String), expiresAt: expect.any(String) }));
      // 身份确认完成后，费率变更申请恢复可用（本地费率由系统维护，不再停用）
      expect((await request(`/api/merchants/${merchant.id}/rates`, {
        method: 'POST', headers: { ...headers, 'Idempotency-Key': 'sensitive-step-up-rate-a' }, body: ratePayload,
      })).status).toBe(201);
      const exportRequest = await request('/api/exports', {
        method: 'POST', headers, body: JSON.stringify({ kind: 'orders', merchantId: merchant.id }),
      });
      expect(exportRequest.status).toBe(201);
      const exportJob = await exportRequest.json() as { id: string };
      await app.get(ExportService).process();
      const secondSession = await login('platform@demo.local', 'Demo123456', 'sensitive-action-session-b');
      expect((await request(`/api/merchants/${merchant.id}/rates`, {
        method: 'POST', headers: { Authorization: `Bearer ${secondSession.token}`, 'Content-Type': 'application/json', 'Idempotency-Key': 'sensitive-step-up-rate-b' }, body: JSON.stringify({ rate: 0.1235, effectiveFrom: '2031-02-04', note: '另一设备未完成身份确认。' }),
      })).status).toBe(403);
      expect((await request(`/api/exports/${exportJob.id}/download`, {
        headers: { Authorization: `Bearer ${secondSession.token}` },
      })).status).toBe(403);
      expect((await request(`/api/exports/${exportJob.id}/download`, { headers })).status).toBe(200);
      // Revocation remains available even if the operator's current device is
      // suspected compromised, so it must not be behind the step-up guard.
      expect((await request(`/api/exports/${exportJob.id}/revoke`, {
        method: 'POST', headers: { Authorization: `Bearer ${secondSession.token}`, 'Content-Type': 'application/json' }, body: '{}',
      })).status).toBe(201);
      const audit = await app.get(DataSource).getRepository(AuditLog).findOneOrFail({ where: { action: 'SENSITIVE_ACTION_REAUTHENTICATED', actorId: platform.user.id } });
      expect(audit).toEqual(expect.objectContaining({ resourceType: 'AuthSession', after: { validForSeconds: 600 } }));
    } finally {
      if (previous === undefined) delete process.env.ENFORCE_SENSITIVE_ACTION_STEP_UP;
      else process.env.ENFORCE_SENSITIVE_ACTION_STEP_UP = previous;
    }
  });

  it('does not expose mock payment confirmation outside local or test environments', async () => {
    const platform = await login('platform@demo.local');
    const merchant = (await (await request('/api/merchants', { headers: { Authorization: `Bearer ${platform.token}` } })).json() as Array<{ id: string; brandName: string }>).find((item) => item.brandName === '花时间花艺')!;
    const storefront = await (await request(`/api/public/merchants/${merchant.id}`)).json() as { stores: Array<{ id: string }> };
    const deal = (await (await request(`/api/public/merchants/${merchant.id}/packages`)).json() as Array<{ id: string; storeIds: string[] }>).find((item) => item.storeIds.includes(storefront.stores[0].id))!;
    const customerHeaders = await customerSession();
    const order = await (await request(`/api/public/merchants/${merchant.id}/orders`, {
      method: 'POST', headers: customerHeaders, body: JSON.stringify({ packageId: deal.id, storeId: storefront.stores[0].id, quantity: 1 }),
    })).json() as { id: string };
    const previousNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'staging';
    try {
      expect((await request(`/api/public/orders/${order.id}/mock-confirm`, { method: 'POST', headers: customerHeaders })).status).toBe(404);
    } finally {
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
    }
  });

  it('queues exports on shared API instances and leaves generation to the lifecycle worker', async () => {
    const exportService = app.get(ExportService);
    const platform = await app.get(DataSource).getRepository(User).findOneByOrFail({ email: 'platform@demo.local' });
    const merchant = await app.get(DataSource).getRepository(Merchant).findOneByOrFail({ brandName: '花时间花艺' });
    const previousNodeEnv = process.env.NODE_ENV;
    const previousDatabaseUrl = process.env.DATABASE_URL;
    const processExports = jest.spyOn(exportService, 'process');
    let exportJobId = '';
    process.env.NODE_ENV = 'staging';
    process.env.DATABASE_URL = 'postgres://shared-db';
    try {
      const job = await exportService.create(platform, { kind: ExportKind.ORDERS, merchantId: merchant.id });
      exportJobId = job.id;
      expect(job.status).toBe(ExportJobStatus.PENDING);
      await Promise.resolve();
      expect(processExports).not.toHaveBeenCalled();
      expect((await app.get(DataSource).getRepository(ExportJob).findOneByOrFail({ id: job.id })).status).toBe(ExportJobStatus.PENDING);
    } finally {
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
      if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previousDatabaseUrl;
      processExports.mockRestore();
    }
    await exportService.process();
    expect((await app.get(DataSource).getRepository(ExportJob).findOneByOrFail({ id: exportJobId })).status).toBe(ExportJobStatus.READY);
  });

  it('bounds lifecycle export work per sweep and reports the remaining queue', async () => {
    const lifecycle = app.get(LifecycleOrchestrationService);
    const exportService = app.get(ExportService);
    const dataSource = app.get(DataSource);
    const platform = await dataSource.getRepository(User).findOneByOrFail({ email: 'platform@demo.local' });
    const merchant = await dataSource.getRepository(Merchant).findOneByOrFail({ brandName: '花时间花艺' });
    const previousNodeEnv = process.env.NODE_ENV;
    const previousDatabaseUrl = process.env.DATABASE_URL;
    const previousBatchSize = process.env.EXPORT_WORKER_BATCH_SIZE;
    const exportJobIds: string[] = [];
    process.env.NODE_ENV = 'staging';
    process.env.DATABASE_URL = 'postgres://shared-db';
    try {
      exportJobIds.push((await exportService.create(platform, { kind: ExportKind.ORDERS, merchantId: merchant.id })).id);
      exportJobIds.push((await exportService.create(platform, { kind: ExportKind.VERIFICATIONS, merchantId: merchant.id })).id);
    } finally {
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
      if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previousDatabaseUrl;
    }
    process.env.EXPORT_WORKER_BATCH_SIZE = '1';
    try {
      const sweep = await lifecycle.runSweep();
      expect(sweep.completedExportJobs).toBe(1);
      expect(sweep.exportQueue).toEqual(expect.objectContaining({ pending: 1, processing: 0, failed: 0, oldestPendingAt: expect.any(Date) }));
      const statuses = await dataSource.getRepository(ExportJob).findByIds(exportJobIds);
      expect(statuses.filter((job) => job.status === ExportJobStatus.READY)).toHaveLength(1);
      expect(statuses.filter((job) => job.status === ExportJobStatus.PENDING)).toHaveLength(1);
    } finally {
      if (previousBatchSize === undefined) delete process.env.EXPORT_WORKER_BATCH_SIZE;
      else process.env.EXPORT_WORKER_BATCH_SIZE = previousBatchSize;
      await exportService.process();
    }
  });

  it('commits shared audit events through an integrity-checked outbox before signing the chain', async () => {
    const dataSource = app.get(DataSource);
    const auditChain = app.get(AuditChainService);
    const auditOutbox = app.get(AuditOutboxService);
    const auditRead = app.get(AuditReadService);
    const exportService = app.get(ExportService);
    const platform = await dataSource.getRepository(User).findOneByOrFail({ email: 'platform@demo.local' });
    const merchant = await dataSource.getRepository(Merchant).findOneByOrFail({ brandName: '花时间花艺' });
    const previousNodeEnv = process.env.NODE_ENV;
    const previousDatabaseUrl = process.env.DATABASE_URL;
    const append = jest.spyOn(auditChain, 'append');
    let signedOutboxId = '';
    let tamperedOutboxId = '';
    process.env.NODE_ENV = 'staging';
    process.env.DATABASE_URL = 'postgres://shared-db';
    try {
      const signedJob = await exportService.create(platform, { kind: ExportKind.ORDERS, merchantId: merchant.id });
      const signedOutbox = await dataSource.getRepository(AuditOutbox).findOneByOrFail({ resourceId: signedJob.id, action: 'DATA_EXPORT_REQUESTED' });
      signedOutboxId = signedOutbox.id;
      expect(signedOutbox).toEqual(expect.objectContaining({ status: AuditOutboxStatus.PENDING, payloadHash: expect.stringMatching(/^[a-f0-9]{64}$/) }));
      expect(append).not.toHaveBeenCalled();

      const tamperedJob = await exportService.create(platform, { kind: ExportKind.VERIFICATIONS, merchantId: merchant.id });
      const tamperedOutbox = await dataSource.getRepository(AuditOutbox).findOneByOrFail({ resourceId: tamperedJob.id, action: 'DATA_EXPORT_REQUESTED' });
      tamperedOutboxId = tamperedOutbox.id;
      tamperedOutbox.outboxVersion = 99;
      tamperedOutbox.after = { tampered: true };
      await dataSource.getRepository(AuditOutbox).save(tamperedOutbox);
    } finally {
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
      if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previousDatabaseUrl;
    }
    try {
      const processing = await auditOutbox.process();
      const processed = { ...processing, auditOutbox: await auditOutbox.queueStatus() };
      expect(processed).toEqual(expect.objectContaining({ signed: 1, quarantined: 1, auditOutbox: expect.objectContaining({ pending: 0, processing: 0, quarantined: 1 }) }));
      const signed = await dataSource.getRepository(AuditOutbox).findOneByOrFail({ id: signedOutboxId });
      expect(signed).toEqual(expect.objectContaining({ status: AuditOutboxStatus.SIGNED, signedAuditLogId: expect.any(String), signedAt: expect.any(Date) }));
      expect(await dataSource.getRepository(AuditLog).findOneBy({ id: signed.signedAuditLogId! })).toEqual(expect.objectContaining({ action: 'DATA_EXPORT_REQUESTED', chainVersion: 1 }));
      const quarantined = await dataSource.getRepository(AuditOutbox).findOneByOrFail({ id: tamperedOutboxId });
      expect(quarantined).toEqual(expect.objectContaining({ status: AuditOutboxStatus.QUARANTINED, failureReason: '审计 outbox 完整性校验失败' }));
      expect(await auditChain.verify()).toEqual(expect.objectContaining({ valid: true }));
      expect(await auditRead.integrity(platform)).toEqual(expect.objectContaining({ valid: false, reason: '存在隔离的审计 outbox 事件', outbox: expect.objectContaining({ quarantined: 1 }) }));
    } finally {
      append.mockRestore();
      // The quarantine path is intentionally retained in production. Remove
      // the fixture only so unrelated integration cases keep a clean queue.
      if (tamperedOutboxId) await dataSource.getRepository(AuditOutbox).delete(tamperedOutboxId);
    }
  });

  it('verifies the immutable audit chain in bounded ordered pages', async () => {
    const dataSource = app.get(DataSource);
    const auditChain = app.get(AuditChainService);
    const auditLogs = dataSource.getRepository(AuditLog);
    const previousBatchSize = process.env.AUDIT_CHAIN_VERIFY_BATCH_SIZE;
    try {
      for (let index = 0; index < 51; index += 1) {
        await dataSource.transaction((manager) => auditChain.append(manager, {
          actorId: 'audit-page-test', merchantId: null, action: 'AUDIT_PAGE_TEST', resourceType: 'AuditTest', resourceId: String(index),
          before: null, after: { index }, requestId: `audit-page-${index}`, actorRole: 'SYSTEM', ipAddress: '', userAgent: '',
        }));
      }
      process.env.AUDIT_CHAIN_VERIFY_BATCH_SIZE = '50';
      const queryBuilder = jest.spyOn(auditLogs, 'createQueryBuilder');
      try {
        expect(await auditChain.verify()).toEqual(expect.objectContaining({ valid: true }));
        expect(queryBuilder.mock.calls.filter(([alias]) => alias === 'audit').length).toBeGreaterThanOrEqual(2);
      } finally {
        queryBuilder.mockRestore();
      }
    } finally {
      if (previousBatchSize === undefined) delete process.env.AUDIT_CHAIN_VERIFY_BATCH_SIZE;
      else process.env.AUDIT_CHAIN_VERIFY_BATCH_SIZE = previousBatchSize;
    }
  });

  it('hands a shared package write to audit outbox through the active database transaction', async () => {
    const appService = app.get(PackageService);
    const dataSource = app.get(DataSource);
    const auditOutbox = app.get(AuditOutboxService);
    const platform = await dataSource.getRepository(User).findOneByOrFail({ email: 'platform@demo.local' });
    const merchant = await dataSource.getRepository(Merchant).findOneByOrFail({ brandName: '花时间花艺' });
    const store = await dataSource.getRepository(Store).findOneByOrFail({ merchantId: merchant.id });
    const title = `事务审计回滚-${Date.now()}`;
    const previousNodeEnv = process.env.NODE_ENV;
    const previousDatabaseUrl = process.env.DATABASE_URL;
    let receivedActiveTransaction = false;
    const enqueue = jest.spyOn(auditOutbox, 'enqueue').mockImplementationOnce(async (manager) => {
      receivedActiveTransaction = manager.queryRunner?.isTransactionActive === true;
      throw new Error('test audit outbox failure');
    });
    process.env.NODE_ENV = 'staging';
    process.env.DATABASE_URL = 'postgres://shared-db';
    try {
      await expect(appService.savePackage(platform, merchant.id, {
        title, description: 'outbox 原子性回归', priceFen: 1200, saleLimit: 20, perCustomerLimit: 2,
        storeIds: [store.id], validFrom: '2031-01-01', validTo: '2031-12-31', status: PackageStatus.DRAFT,
      })).rejects.toThrow('test audit outbox failure');
      expect(receivedActiveTransaction).toBe(true);
    } finally {
      enqueue.mockRestore();
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
      if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previousDatabaseUrl;
    }
  });

  it('publishes only validated store coordinates for customer map navigation', async () => {
    const platform = await login('platform@demo.local');
    const merchantAdmin = await login('merchant@demo.local');
    const merchant = (await (await request('/api/merchants', { headers: { Authorization: `Bearer ${platform.token}` } })).json() as Array<{ id: string; brandName: string }>).find((item) => item.brandName === '花时间花艺')!;
    const headers = { Authorization: `Bearer ${merchantAdmin.token}`, 'Content-Type': 'application/json' };
    const create = await request(`/api/merchants/${merchant.id}/stores`, {
      method: 'POST', headers,
      body: JSON.stringify({ name: '地图导航测试门店', address: '广州市天河区测试路 1 号', phone: '020-12345678', businessHours: '10:00-20:00', latitude: 23.1291104, longitude: 113.2643857 }),
    });
    expect(create.status).toBe(201);
    const store = await create.json() as { id: string; latitude: number; longitude: number };
    expect(store).toEqual(expect.objectContaining({ latitude: 23.1291104, longitude: 113.2643857 }));

    const storefront = await (await request(`/api/public/merchants/${merchant.id}`)).json() as { stores: Array<{ id: string; latitude: number | null; longitude: number | null }> };
    expect(storefront.stores).toEqual(expect.arrayContaining([expect.objectContaining({ id: store.id, latitude: 23.1291104, longitude: 113.2643857 })]));

    const incomplete = await request(`/api/merchants/${merchant.id}/stores`, {
      method: 'POST', headers,
      body: JSON.stringify({ name: '不完整坐标门店', address: '广州市天河区测试路 2 号', latitude: 23.1291104 }),
    });
    expect(incomplete.status).toBe(400);

    const clear = await request(`/api/merchants/${merchant.id}/stores`, {
      method: 'POST', headers,
      body: JSON.stringify({ id: store.id, name: '地图导航测试门店', address: '广州市天河区测试路 1 号', phone: '020-12345678', businessHours: '10:00-20:00', latitude: null, longitude: null, openForSale: false }),
    });
    expect(clear.status).toBe(201);
    expect(await clear.json()).toEqual(expect.objectContaining({ latitude: null, longitude: null }));
  });

  it('keeps complete store versions recoverable and rejects stale or staff changes', async () => {
    const platform = await login('platform@demo.local');
    const merchantAdmin = await login('merchant@demo.local');
    const staff = await login('staff@demo.local');
    const merchant = (await (await request('/api/merchants', { headers: { Authorization: `Bearer ${platform.token}` } })).json() as Array<{ id: string; brandName: string }>).find((item) => item.brandName === '花时间花艺')!;
    const headers = { Authorization: `Bearer ${merchantAdmin.token}`, 'Content-Type': 'application/json' };
    const create = await request(`/api/merchants/${merchant.id}/stores`, {
      method: 'POST', headers,
      body: JSON.stringify({ name: '版本恢复测试门店', address: '广州市天河区版本路 1 号', phone: '020-11111111', businessHours: '09:00-18:00', latitude: 23.12, longitude: 113.31, openForSale: false }),
    });
    expect(create.status).toBe(201);
    const created = await create.json() as { id: string; version: number };
    expect(created.version).toBe(1);

    const update = await request(`/api/merchants/${merchant.id}/stores`, {
      method: 'POST', headers,
      body: JSON.stringify({ id: created.id, expectedVersion: 1, name: '版本恢复测试门店（新）', address: '广州市天河区版本路 2 号', phone: '020-22222222', businessHours: '10:00-20:00', latitude: 23.13, longitude: 113.32, openForSale: true }),
    });
    expect(update.status).toBe(201);
    const updated = await update.json() as { version: number; name: string };
    expect(updated).toEqual(expect.objectContaining({ version: 2, name: '版本恢复测试门店（新）' }));
    expect((await request(`/api/merchants/${merchant.id}/stores`, {
      method: 'POST', headers,
      body: JSON.stringify({ id: created.id, expectedVersion: 1, name: '陈旧更新', address: '广州市天河区版本路 3 号' }),
    })).status).toBe(409);

    const versionsResponse = await request(`/api/merchants/${merchant.id}/stores/${created.id}/versions`, { headers });
    expect(versionsResponse.status).toBe(200);
    const versions = await versionsResponse.json() as Array<{ auditId: string; version: number; name: string; address: string; latitude: number | null; longitude: number | null; openForSale: boolean }>;
    const original = versions.find((item) => item.version === 1)!;
    expect(original).toEqual(expect.objectContaining({ name: '版本恢复测试门店', address: '广州市天河区版本路 1 号', latitude: 23.12, longitude: 113.31, openForSale: false }));
    const restore = await request(`/api/merchants/${merchant.id}/stores/${created.id}/versions/${original.auditId}/restore`, {
      method: 'POST', headers, body: JSON.stringify({ expectedVersion: 2 }),
    });
    expect(restore.status).toBe(201);
    expect(await restore.json()).toEqual(expect.objectContaining({ version: 3, name: '版本恢复测试门店', address: '广州市天河区版本路 1 号', openForSale: false }));
    expect((await request(`/api/merchants/${merchant.id}/stores/${created.id}/versions/${original.auditId}/restore`, {
      method: 'POST', headers, body: JSON.stringify({ expectedVersion: 2 }),
    })).status).toBe(409);
    expect((await request(`/api/merchants/${merchant.id}/stores/${created.id}/versions`, { headers: { Authorization: `Bearer ${staff.token}` } })).status).toBe(403);
  });

  it('serializes concurrent store updates against the same version and commits one audit trail entry', async () => {
    const platform = await login('platform@demo.local');
    const merchantAdmin = await login('merchant@demo.local');
    const merchant = (await (await request('/api/merchants', { headers: { Authorization: `Bearer ${platform.token}` } })).json() as Array<{ id: string; brandName: string }>).find((item) => item.brandName === '花时间花艺')!;
    const headers = { Authorization: `Bearer ${merchantAdmin.token}`, 'Content-Type': 'application/json' };
    const created = await (await request(`/api/merchants/${merchant.id}/stores`, {
      method: 'POST', headers, body: JSON.stringify({ name: '并发门店版本测试', address: '广州市天河区并发路 1 号', openForSale: true }),
    })).json() as { id: string; version: number };
    const path = `/api/merchants/${merchant.id}/stores`;
    const [first, second] = await Promise.all([
      request(path, { method: 'POST', headers, body: JSON.stringify({ id: created.id, expectedVersion: created.version, name: '并发更新 A', address: '广州市天河区并发路 2 号', openForSale: false }) }),
      request(path, { method: 'POST', headers, body: JSON.stringify({ id: created.id, expectedVersion: created.version, name: '并发更新 B', address: '广州市天河区并发路 3 号', openForSale: false }) }),
    ]);
    expect([first.status, second.status].sort()).toEqual([201, 409]);
    const stored = await app.get(DataSource).getRepository(Store).findOneByOrFail({ id: created.id });
    expect(stored.version).toBe(created.version + 1);
    expect(['并发更新 A', '并发更新 B']).toContain(stored.name);
    const audits = await app.get(DataSource).getRepository(AuditLog).find({ where: { action: 'STORE_UPDATED', resourceId: created.id } });
    expect(audits).toHaveLength(1);
    expect(await app.get(AuditChainService).verify()).toEqual(expect.objectContaining({ valid: true }));
  });

  it('keeps brand homepage configuration versioned, role-scoped, and public-safe', async () => {
    const platform = await login('platform@demo.local');
    const agency = await login('agency@demo.local');
    const merchantAdmin = await login('merchant@demo.local');
    const staff = await login('staff@demo.local');
    const merchant = (await (await request('/api/merchants', { headers: { Authorization: `Bearer ${platform.token}` } })).json() as Array<{ id: string; brandName: string }>).find((item) => item.brandName === '花时间花艺')!;
    const configPath = `/api/merchants/${merchant.id}/template-config`;
    const configVersionsPath = `${configPath}/versions`;
    const merchantHeaders = { Authorization: `Bearer ${merchantAdmin.token}`, 'Content-Type': 'application/json' };
    const defaultConfig = await (await request(configPath, { headers: merchantHeaders })).json() as { id: string | null; version: number; homeTitle: string; featuredPackageId: string | null };
    expect(defaultConfig).toEqual(expect.objectContaining({ id: null, version: 0, homeTitle: '', featuredPackageId: null }));
    const featuredPackage = (await (await request(`/api/merchants/${merchant.id}/packages`, { headers: merchantHeaders })).json() as Array<{ id: string }>)[0];
    const save = await request(configPath, {
      method: 'PATCH', headers: merchantHeaders,
      body: JSON.stringify({ expectedVersion: 0, homeTitle: '花时间周末花礼', homeSubtitle: '一束鲜花，一段轻松时光。', featuredPackageId: featuredPackage.id }),
    });
    expect(save.status).toBe(200);
    expect(await save.json()).toEqual(expect.objectContaining({ version: 1, homeTitle: '花时间周末花礼', featuredPackageId: featuredPackage.id }));
    const laterSave = await request(configPath, {
      method: 'PATCH', headers: merchantHeaders,
      body: JSON.stringify({ expectedVersion: 1, homeTitle: '花时间日常花礼', homeSubtitle: '今日鲜花，随心选购。', featuredPackageId: null }),
    });
    expect(laterSave.status).toBe(200);
    expect(await laterSave.json()).toEqual(expect.objectContaining({ version: 2, homeTitle: '花时间日常花礼', featuredPackageId: null }));
    const configVersions = await (await request(configVersionsPath, { headers: merchantHeaders })).json() as Array<{ auditId: string; action: string; version: number; homeTitle: string; featuredPackageId: string | null }>;
    const originalVersion = configVersions.find((item) => item.version === 1 && item.homeTitle === '花时间周末花礼')!;
    expect(originalVersion).toEqual(expect.objectContaining({ action: 'MERCHANT_TEMPLATE_CONFIG_SAVED', featuredPackageId: featuredPackage.id }));
    expect((await request(`${configVersionsPath}/${originalVersion.auditId}/restore`, {
      method: 'POST', headers: merchantHeaders, body: JSON.stringify({ expectedVersion: 1 }),
    })).status).toBe(409);
    const restored = await request(`${configVersionsPath}/${originalVersion.auditId}/restore`, {
      method: 'POST', headers: merchantHeaders, body: JSON.stringify({ expectedVersion: 2 }),
    });
    expect(restored.status).toBe(201);
    expect(await restored.json()).toEqual(expect.objectContaining({ version: 3, homeTitle: '花时间周末花礼', featuredPackageId: featuredPackage.id }));
    expect((await request(configPath, {
      method: 'PATCH', headers: merchantHeaders,
      body: JSON.stringify({ expectedVersion: 0, homeTitle: '过期写入' }),
    })).status).toBe(409);
    expect((await request(configPath, { headers: { Authorization: `Bearer ${agency.token}` } })).status).toBe(200);
    expect((await request(configPath, { headers: { Authorization: `Bearer ${staff.token}` } })).status).toBe(403);
    expect((await request(configPath, {
      method: 'PATCH', headers: { Authorization: `Bearer ${staff.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ expectedVersion: 1, homeTitle: '核销员不可修改' }),
    })).status).toBe(403);
    expect((await request(configVersionsPath, { headers: { Authorization: `Bearer ${staff.token}` } })).status).toBe(403);
    expect((await request(`${configVersionsPath}/${originalVersion.auditId}/restore`, {
      method: 'POST', headers: { Authorization: `Bearer ${staff.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedVersion: 3 }),
    })).status).toBe(403);
    const publicStorefront = await (await request(`/api/public/merchants/${merchant.id}`)).json() as { templateConfig: Record<string, unknown> };
    expect(publicStorefront.templateConfig).toEqual({ homeTitle: '花时间周末花礼', homeSubtitle: '一束鲜花，一段轻松时光。', featuredPackageId: featuredPackage.id });
    expect(publicStorefront.templateConfig).not.toHaveProperty('version');
    expect(publicStorefront.templateConfig).not.toHaveProperty('updatedBy');
    const audits = (await (await request(`/api/merchants/${merchant.id}/audits`, { headers: merchantHeaders })).json() as { items: Array<{ action: string }> }).items;
    expect(audits).toEqual(expect.arrayContaining([expect.objectContaining({ action: 'MERCHANT_TEMPLATE_CONFIG_SAVED' })]));
    expect(audits).toEqual(expect.arrayContaining([expect.objectContaining({ action: 'MERCHANT_TEMPLATE_CONFIG_VERSION_RESTORED' })]));
  });

  it('exposes separate liveness and database readiness probes', async () => {
    const live = await request('/api/public/health/live');
    expect(live.status).toBe(200);
    expect(live.headers.get('x-content-type-options')).toBe('nosniff');
    expect(live.headers.get('x-frame-options')).toBe('DENY');
    expect(live.headers.get('referrer-policy')).toBe('no-referrer');
    expect(live.headers.get('permissions-policy')).toBe('camera=(), microphone=(), geolocation=()');
    expect(live.headers.get('cross-origin-opener-policy')).toBe('same-origin');
    expect(live.headers.get('content-security-policy')).toBe("default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
    expect(live.headers.get('x-powered-by')).toBeNull();
    expect(await live.json()).toEqual({ status: 'ok' });
    const ready = await request('/api/public/health/ready');
    expect(ready.status).toBe(200);
    expect(await ready.json()).toEqual({ status: 'ok' });
    const legacyReady = await request('/api/public/health');
    expect(legacyReady.status).toBe(200);
    expect(await legacyReady.json()).toEqual({ status: 'ok' });
    const worker = await request('/api/public/health/worker');
    expect(worker.status).toBe(503);
    expect((await worker.json()).message).toBe('服务暂不可用');
    const platform = await login('platform@demo.local');
    const diagnostics = await request('/api/platform/health/ready', { headers: { Authorization: `Bearer ${platform.token}` } });
    expect(diagnostics.status).toBe(200);
    expect(await diagnostics.json()).toEqual(expect.objectContaining({ status: 'ok', database: 'ok', mode: 'embedded-demo', migrations: 'not-applicable', releaseId: expect.any(String) }));
  });

  it('keeps legacy and v1 client paths compatible without versioning provider webhooks', async () => {
    const legacyMerchants = await request('/api/public/merchants');
    const v1Merchants = await request('/api/v1/public/merchants');
    expect(legacyMerchants.status).toBe(200);
    expect(v1Merchants.status).toBe(200);
    expect(legacyMerchants.headers.get('deprecation')).toBe('true');
    expect(legacyMerchants.headers.get('sunset')).toBe('Wed, 21 Jul 2027 00:00:00 GMT');
    expect(legacyMerchants.headers.get('link')).toBe('</api/v1>; rel="successor-version"');
    expect(v1Merchants.headers.get('deprecation')).toBeNull();
    expect(await v1Merchants.json()).toEqual(await legacyMerchants.json());

    const credentials = JSON.stringify({ email: 'merchant@demo.local', password: 'Demo123456' });
    const [legacyLogin, v1Login] = await Promise.all([
      request('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: credentials }),
      request('/api/v1/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: credentials }),
    ]);
    expect(legacyLogin.status).toBe(201);
    expect(v1Login.status).toBe(201);
    const legacyProfile = await request('/api/auth/me', { headers: { Authorization: `Bearer ${(await legacyLogin.json() as { token: string }).token}` } });
    const v1Profile = await request('/api/v1/auth/me', { headers: { Authorization: `Bearer ${(await v1Login.json() as { token: string }).token}` } });
    expect(legacyProfile.status).toBe(200);
    expect(v1Profile.status).toBe(200);
    expect(await v1Profile.json()).toEqual(await legacyProfile.json());

    expect((await request('/api/v2/public/merchants')).status).toBe(404);
    expect((await request('/api/v1/payments/webhooks/mock', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status).toBe(404);
    const webhook = await request('/api/payments/webhooks/mock', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    expect(webhook.status).toBe(400);
    expect(webhook.headers.get('deprecation')).toBeNull();
  });

  it('marks direct public and authenticated API responses as non-cacheable', async () => {
    const publicResponse = await request('/api/public/health/live');
    expect(publicResponse.headers.get('cache-control')).toBe('no-store');

    const platform = await login('platform@demo.local');
    const authenticatedResponse = await request('/api/dashboard', { headers: { Authorization: `Bearer ${platform.token}` } });
    expect(authenticatedResponse.status).toBe(200);
    expect(authenticatedResponse.headers.get('cache-control')).toBe('no-store');
  });

  it('keeps dashboard metrics aligned with the selected accessible merchant', async () => {
    const platform = await login('platform@demo.local');
    const merchants = await (await request('/api/merchants', { headers: { Authorization: `Bearer ${platform.token}` } })).json() as Array<{ id: string; brandName: string }>;
    const flowerMerchant = merchants.find((merchant) => merchant.brandName === '花时间花艺')!;
    const lunchMerchant = merchants.find((merchant) => merchant.brandName === '午间食堂')!;

    const globalDashboard = await (await request('/api/dashboard', { headers: { Authorization: `Bearer ${platform.token}` } })).json() as { scopeMerchantId: string | null; merchants: number };
    expect(globalDashboard).toEqual(expect.objectContaining({ scopeMerchantId: null, merchants: merchants.length }));
    const selectedDashboard = await (await request(`/api/dashboard?merchantId=${flowerMerchant.id}`, { headers: { Authorization: `Bearer ${platform.token}` } })).json() as { scopeMerchantId: string; merchants: number };
    expect(selectedDashboard).toEqual(expect.objectContaining({ scopeMerchantId: flowerMerchant.id, merchants: 1 }));

    const agency = await login('agency@demo.local');
    const agencyDashboard = await (await request(`/api/dashboard?merchantId=${flowerMerchant.id}`, { headers: { Authorization: `Bearer ${agency.token}` } })).json() as { scopeMerchantId: string; merchants: number };
    expect(agencyDashboard).toEqual(expect.objectContaining({ scopeMerchantId: flowerMerchant.id, merchants: 1 }));
    const merchantAdmin = await login('merchant@demo.local');
    expect((await request(`/api/dashboard?merchantId=${lunchMerchant.id}`, { headers: { Authorization: `Bearer ${merchantAdmin.token}` } })).status).toBe(403);
    const staff = await login('staff@demo.local');
    expect((await request(`/api/dashboard?merchantId=${lunchMerchant.id}`, { headers: { Authorization: `Bearer ${staff.token}` } })).status).toBe(403);
  });

  it('rejects store-staff commercial reports and protected field mutation', async () => {
    const platform = await login('platform@demo.local');
    const merchants = await (await request('/api/merchants', { headers: { Authorization: `Bearer ${platform.token}` } })).json() as Array<{ id: string; agencyId: string; contractNumber: string; brandName: string }>;
    const merchant = merchants.find((item) => item.brandName === '花时间花艺')!;
    const staff = await login('staff@demo.local');
    expect((await request('/api/reports/summary', { headers: { Authorization: `Bearer ${staff.token}` } })).status).toBe(403);
    expect((await request('/api/bills', { headers: { Authorization: `Bearer ${staff.token}` } })).status).toBe(403);
    const staffDashboard = await (await request('/api/dashboard', { headers: { Authorization: `Bearer ${staff.token}` } })).json() as Record<string, unknown>;
    expect(staffDashboard).toEqual(expect.objectContaining({ stores: 1 }));
    expect(staffDashboard).not.toHaveProperty('verifiedAmountFen');
    expect(staffDashboard).not.toHaveProperty('serviceFeeFen');

    const merchantAdmin = await login('merchant@demo.local');
    const update = await request(`/api/merchants/${merchant.id}`, {
      method: 'PATCH', headers: { Authorization: `Bearer ${merchantAdmin.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ agencyId: '00000000-0000-0000-0000-000000000000', contractNumber: 'tampered', primaryColor: '#112233' }),
    });
    expect(update.status).toBe(400);
    const after = (await (await request('/api/merchants', { headers: { Authorization: `Bearer ${platform.token}` } })).json() as Array<{ id: string; agencyId: string; contractNumber: string }>).find((item) => item.id === merchant.id)!;
    expect(after.agencyId).toBe(merchant.agencyId);
    expect(after.contractNumber).toBe(merchant.contractNumber);
  });

  it('reports daily verification counts with strict date and tenant boundaries', async () => {
    const platform = await login('platform@demo.local');
    const headers = { Authorization: `Bearer ${platform.token}` };
    const merchant = (await (await request('/api/merchants', { headers })).json() as Array<{ id: string; brandName: string }>).find((item) => item.brandName === '花时间花艺')!;
    const store = (await (await request(`/api/merchants/${merchant.id}/stores`, { headers })).json() as Array<{ id: string }>)[0];
    const deal = (await (await request(`/api/merchants/${merchant.id}/packages`, { headers })).json() as Array<{ id: string; title: string }>)[0];
    const dataSource = app.get(DataSource);
    const createdAt = new Date('2040-01-15T04:00:00.000Z');
    const order = await dataSource.getRepository(Order).save({
      orderNo: `DG20400115${randomUUID().replace(/-/g, '').slice(0, 16).toUpperCase()}`,
      merchantId: merchant.id, packageId: deal.id, storeId: store.id, customerId: `report-${randomUUID()}`, idempotencyKey: `report-${randomUUID()}`,
      quantity: 1, amountFen: 2580, unitPriceFen: 2580, packageTitleSnapshot: deal.title, packageVersionSnapshot: 1,
      validFromSnapshot: new Date('2040-01-01'), validToSnapshot: new Date('2040-12-31'), commissionRateSnapshot: '0.0800',
      status: OrderStatus.PAID, paymentExpiresAt: new Date('2040-01-15T04:15:00.000Z'), paymentReference: `mock-${randomUUID()}`, createdAt, updatedAt: createdAt,
    });
    const voucher = await dataSource.getRepository(Voucher).save({
      code: `REPORT-${randomUUID()}`, orderId: order.id, merchantId: merchant.id, packageId: deal.id, storeId: store.id,
      customerId: order.customerId, faceValueFen: 2580, commissionRateSnapshot: '0.0800', status: VoucherStatus.USED,
      validFrom: new Date('2040-01-01'), validTo: new Date('2040-12-31'), verificationId: null, createdAt, updatedAt: createdAt,
    });
    const verification = await dataSource.getRepository(Verification).save({
      voucherId: voucher.id, merchantId: merchant.id, storeId: store.id, staffId: randomUUID(), idempotencyKey: `report-${randomUUID()}`,
      amountFen: 2580, verifiedAt: createdAt,
    });
    await dataSource.getRepository(Voucher).update(voucher.id, { verificationId: verification.id });
    const ledgerEntry = await dataSource.getRepository(SettlementLedgerEntry).save({
      merchantId: merchant.id, voucherId: voucher.id, verificationId: verification.id, verifiedAmountFen: 2580,
      serviceFeeFen: 206, rateSnapshot: '0.0800', entryType: 'VERIFIED', occurredAt: createdAt,
    });
    try {
      const response = await request(`/api/reports/analytics?merchantId=${merchant.id}&from=2040-01-15&to=2040-01-15`, { headers });
      expect(response.status).toBe(200);
      const report = await response.json() as { summary: { paidAmountFen: number; verifiedAmountFen: number; verificationRate: number }; daily: Array<{ day: string; orderCount: number; verificationCount: number; verifiedAmountFen: number }>; stores: Array<{ storeId: string; verificationCount: number }>; packages: Array<{ packageId: string; verificationCount: number }> };
      expect(report.summary).toEqual(expect.objectContaining({ paidAmountFen: 2580, verifiedAmountFen: 2580, verificationRate: 1 }));
      expect(report.daily).toEqual([expect.objectContaining({ day: '2040-01-15', orderCount: 1, verificationCount: 1, verifiedAmountFen: 2580 })]);
      expect(report.stores).toEqual([expect.objectContaining({ storeId: store.id, verificationCount: 1 })]);
      expect(report.packages).toEqual([expect.objectContaining({ packageId: deal.id, verificationCount: 1 })]);
      expect((await request(`/api/reports/analytics?merchantId=${merchant.id}&from=2040-02-31&to=2040-03-01`, { headers })).status).toBe(400);
      const staff = await login('staff@demo.local');
      expect((await request('/api/reports/analytics?from=2040-01-15&to=2040-01-15', { headers: { Authorization: `Bearer ${staff.token}` } })).status).toBe(403);
    } finally {
      await dataSource.getRepository(SettlementLedgerEntry).delete(ledgerEntry.id);
      await dataSource.getRepository(Verification).delete(verification.id);
      await dataSource.getRepository(Voucher).delete(voucher.id);
      await dataSource.getRepository(Order).delete(order.id);
    }
  });

  it('keeps contract, fee, and new-sale approval with the platform when an agency creates a merchant', async () => {
    const agency = await login('agency@demo.local');
    const headers = { Authorization: `Bearer ${agency.token}`, 'Content-Type': 'application/json' };
    const forbidden = await request('/api/merchants', {
      method: 'POST', headers,
      body: JSON.stringify({ legalName: '越权合同主体', brandName: '越权合同品牌', contractNumber: 'FORBIDDEN-001', rate: 0 }),
    });
    // 代理商不可设置合同：改为显式 403 拒绝（此前误停用期间的 410 已不再适用）
    expect(forbidden.status).toBe(403);

    const createdResponse = await request('/api/merchants', {
      method: 'POST', headers,
      body: JSON.stringify({ legalName: '代理开店主体', brandName: '代理待审核店', servicePhone: '020-0000-0099', adminName: '待审核管理员', adminEmail: 'agency-created-merchant@demo.local', adminPassword: 'AgencyCreatedMerchant123' }),
    });
    expect(createdResponse.status).toBe(201);
    const created = await createdResponse.json() as { id: string; status: string; contractNumber: string };
    expect(created).toEqual(expect.objectContaining({ status: 'SALES_SUSPENDED', contractNumber: '' }));
    expect((await request(`/api/public/merchants/${created.id}`)).status).toBe(404);

    const platform = await login('platform@demo.local');
    const rates = await (await request(`/api/merchants/${created.id}/rates`, { headers: { Authorization: `Bearer ${platform.token}` } })).json() as unknown[];
    expect(rates).toEqual([]);
  });

  it('keeps offline agency authorization as a platform-only quota record that manual onboarding cannot consume', async () => {
    const platform = await login('platform@demo.local');
    const operations = await login('platform-operations@demo.local');
    const suffix = randomUUID().slice(0, 8);
    const agencyEmail = `quota-agency-${suffix}@demo.local`;
    const agencyPassword = 'QuotaAgencyPassword123';
    expect((await request('/api/agencies', {
      method: 'POST', headers: { Authorization: `Bearer ${operations.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: `越权代理-${suffix}`, managerName: '不应创建', managerEmail: `blocked-${suffix}@demo.local`, password: 'BlockedAgencyPassword123' }),
    })).status).toBe(403);
    const createdAgency = await request('/api/agencies', {
      method: 'POST', headers: { Authorization: `Bearer ${platform.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: `单次授权代理-${suffix}`, managerName: '授权代理管理员', managerEmail: agencyEmail, password: agencyPassword, cooperationPlan: 'PER_PUBLISH', publicationQuotaRemaining: 1, cooperationReference: `OFFLINE-${suffix}` }),
    });
    expect(createdAgency.status).toBe(201);
    const agency = await createdAgency.json() as { id: string; publicationQuotaRemaining: number; cooperationPlan: string };
    expect(agency).toEqual(expect.objectContaining({ cooperationPlan: 'PER_PUBLISH', publicationQuotaRemaining: 1 }));
    const agent = await login(agencyEmail, agencyPassword);
    const headers = { Authorization: `Bearer ${agent.token}`, 'Content-Type': 'application/json' };
    const createMerchant = async (number: number) => request('/api/merchants', {
      method: 'POST', headers,
      body: JSON.stringify({ legalName: `授权主体-${suffix}-${number}`, brandName: `授权商家-${suffix}-${number}`, adminName: `商家管理员${number}`, adminEmail: `quota-merchant-${suffix}-${number}@demo.local`, adminPassword: 'QuotaMerchantPassword123' }),
    });
    const firstMerchant = await createMerchant(1);
    expect(firstMerchant.status).toBe(201);
    const first = await firstMerchant.json() as { id: string };
    // 开户进度由微信真实状态同步：通用接口的人工推进一律 410
    expect((await request(`/api/merchants/${first.id}/registration`, { method: 'POST', headers, body: JSON.stringify({ status: 'PENDING_MATERIALS', note: '准备第一家商家资料。' }) })).status).toBe(410);
    expect((await request(`/api/merchants/${first.id}/registration`, { method: 'POST', headers, body: JSON.stringify({ status: 'SUBMITTED', note: '提交第一家商家开通资料。' }) })).status).toBe(410);
    const firstRegistration = await (await request(`/api/merchants/${first.id}/registration`, { headers })).json() as { publicationEntitlementStatus: string };
    // 人工推进被拒后不得占用线下授权名额：名额保持可用（消费只能来自微信侧真实开通事件）
    expect(firstRegistration.publicationEntitlementStatus).toBe('NONE');
    expect(await (await request('/api/agency/cooperation', { headers })).json()).toEqual(expect.objectContaining({ publicationQuotaRemaining: 1, cooperationPlan: 'PER_PUBLISH' }));

    const secondMerchant = await createMerchant(2);
    expect(secondMerchant.status).toBe(201);
    const second = await secondMerchant.json() as { id: string };
    expect((await request(`/api/merchants/${second.id}/registration`, { method: 'POST', headers, body: JSON.stringify({ status: 'PENDING_MATERIALS', note: '准备第二家商家资料。' }) })).status).toBe(410);
    expect((await request(`/api/merchants/${second.id}/registration`, { method: 'POST', headers, body: JSON.stringify({ status: 'SUBMITTED', note: '尝试提交第二家商家开通资料。' }) })).status).toBe(410);
    expect((await request(`/api/agencies/${agency.id}/cooperation`, { method: 'PATCH', headers, body: JSON.stringify({ cooperationPlan: 'PER_PUBLISH', publicationQuotaRemaining: 2 }) })).status).toBe(403);
    expect((await request(`/api/agencies/${agency.id}/cooperation`, {
      method: 'PATCH', headers: { Authorization: `Bearer ${operations.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ cooperationPlan: 'PER_PUBLISH', publicationQuotaRemaining: 2 }),
    })).status).toBe(403);
    expect((await request(`/api/agencies/${agency.id}/active`, {
      method: 'POST', headers: { Authorization: `Bearer ${operations.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ active: false }),
    })).status).toBe(403);

    expect((await request(`/api/agencies/${agency.id}/cooperation`, {
      method: 'PATCH', headers: { Authorization: `Bearer ${platform.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ cooperationPlan: 'PER_PUBLISH', publicationQuotaRemaining: 1, cooperationReference: `RENEW-${suffix}` }),
    })).status).toBe(200);
    expect((await request(`/api/merchants/${second.id}/registration`, { method: 'POST', headers, body: JSON.stringify({ status: 'SUBMITTED', note: '平台补充线下授权后重新提交。' }) })).status).toBe(410);
  });

  it('imports agency merchants idempotently without storing credentials and preserves per-row failures', async () => {
    const agency = await login('agency@demo.local');
    const agencyId = agency.user.agencyId as string;
    const headers = { Authorization: `Bearer ${agency.token}`, 'Content-Type': 'application/json' };
    const suffix = randomUUID().slice(0, 8);
    const path = `/api/agencies/${agencyId}/merchants/batch-import`;
    const body = JSON.stringify({
      note: '代理商批量建立商家资料草稿，管理员后续单独邀请。',
      items: [
        { externalRef: `row-a-${suffix}`, legalName: `导入冲突主体-${suffix}`, brandName: `导入冲突品牌-${suffix}`, servicePhone: '020-10000001' },
        { externalRef: `row-b-${suffix}`, legalName: `导入成功主体-${suffix}`, brandName: `导入成功品牌-${suffix}`, servicePhone: '020-10000002' },
      ],
    });
    expect((await request(`/api/agencies/${randomUUID()}/merchants/batch-import`, { method: 'POST', headers: { ...headers, 'Idempotency-Key': `merchant-import-cross-${suffix}` }, body })).status).toBe(403);
    // 本地费率是唯一来源（2026-08-09 排查后恢复）：批量导入可携带初始费率，接口不再返回 410
    const withInitialRate = await request(path, { method: 'POST', headers: { ...headers, 'Idempotency-Key': `merchant-import-finance-${suffix}` }, body: JSON.stringify({ note: '批量导入携带本地初始费率。', items: [{ externalRef: `finance-${suffix}`, legalName: `含费率主体-${suffix}`, brandName: `含费率品牌-${suffix}`, rate: 0.05 }] }) });
    expect(withInitialRate.status).toBe(201);

    const submitted = await request(path, { method: 'POST', headers: { ...headers, 'Idempotency-Key': `merchant-import-${suffix}` }, body });
    expect(submitted.status).toBe(201);
    const operation = await submitted.json() as { id: string; status: BatchOperationStatus; payload: Record<string, unknown> };
    expect(operation.status).toBe(BatchOperationStatus.PENDING);
    expect(JSON.stringify(operation.payload)).not.toMatch(/password|adminPassword/i);
    const replay = await request(path, { method: 'POST', headers: { ...headers, 'Idempotency-Key': `merchant-import-${suffix}` }, body });
    expect(replay.status).toBe(201);
    expect((await replay.json() as { id: string }).id).toBe(operation.id);
    expect((await request(path, { method: 'POST', headers: { ...headers, 'Idempotency-Key': `merchant-import-${suffix}` }, body: JSON.stringify({ note: '同一请求键不能修改导入内容。', items: [{ externalRef: `row-b-${suffix}`, legalName: `其他主体-${suffix}`, brandName: `其他品牌-${suffix}` }] }) })).status).toBe(409);

    const dataSource = app.get(DataSource);
    const collision = await dataSource.getRepository(Merchant).save({
      agencyId, legalName: `占位冲突主体-${suffix}`, brandName: `占位冲突品牌-${suffix}`, status: MerchantStatus.SALES_SUSPENDED,
      servicePhone: '', contractNumber: '', contractEndsAt: null, createdBy: agency.user.id,
      creationIdempotencyKey: `merchant-import-${operation.id}-row-a-${suffix}`, creationRequestHash: 'different-request-hash',
    });
    let createdMerchantId: string | undefined;
    try {
      await dataSource.getRepository(MerchantImportOperation).update(operation.id, {
        status: BatchOperationStatus.PROCESSING,
        startedAt: new Date(Date.now() - 11 * 60_000),
        updatedAt: new Date(Date.now() - 11 * 60_000),
      });
      expect(await app.get(MerchantImportService).processPending()).toBeGreaterThanOrEqual(1);
      const completed = await dataSource.getRepository(MerchantImportOperation).findOneByOrFail({ id: operation.id });
      expect(completed).toEqual(expect.objectContaining({ status: BatchOperationStatus.PARTIAL, succeededCount: 1, failedCount: 1 }));
      const success = completed.results!.find((item) => item.ok === true) as { externalRef: string; merchantId: string; status: MerchantStatus };
      const failure = completed.results!.find((item) => item.ok === false) as { externalRef: string; error: string };
      expect(success).toEqual(expect.objectContaining({ externalRef: `row-b-${suffix}`, merchantId: expect.any(String), status: MerchantStatus.SALES_SUSPENDED }));
      expect(failure).toEqual(expect.objectContaining({ externalRef: `row-a-${suffix}`, error: expect.stringContaining('请求标识') }));
      createdMerchantId = success.merchantId;
      expect(await dataSource.getRepository(MerchantRegistration).existsBy({ merchantId: success.merchantId })).toBe(true);
      expect(await dataSource.getRepository(User).countBy({ merchantId: success.merchantId, role: UserRole.MERCHANT_ADMIN })).toBe(0);
      const agencyList = await (await request('/api/merchant-import-operations', { headers })).json() as Array<Record<string, unknown> & { id: string }>;
      expect(agencyList).toEqual(expect.arrayContaining([expect.objectContaining({ id: operation.id })]));
      const listedOperation = agencyList.find((item) => item.id === operation.id)!;
      expect(listedOperation).not.toHaveProperty('payload');
      expect(listedOperation).not.toHaveProperty('results');
      expect((await request(`/api/merchant-import-operations/${operation.id}`, { headers })).status).toBe(200);
      const merchantAudit = await dataSource.getRepository(AuditLog).findOneByOrFail({ action: 'MERCHANT_CREATED', resourceId: success.merchantId });
      expect(merchantAudit.after).toEqual(expect.objectContaining({ importOperationId: operation.id, importExternalRef: `row-b-${suffix}`, administratorCreated: false }));
    } finally {
      await dataSource.getRepository(MerchantImportOperation).delete(operation.id);
      if (createdMerchantId) {
        await dataSource.getRepository(MerchantRegistration).delete({ merchantId: createdMerchantId });
        await dataSource.getRepository(Merchant).delete(createdMerchantId);
      }
      await dataSource.getRepository(Merchant).delete(collision.id);
    }
  });

  it('allows same-name draft workspaces while idempotently deduplicating concurrent merchant creation retries', async () => {
    const platform = await login('platform@demo.local');
    const headers = { Authorization: `Bearer ${platform.token}`, 'Content-Type': 'application/json' };
    const [agency] = await (await request('/api/agencies', { headers })).json() as Array<{ id: string }>;
    const suffix = `${Date.now()}-${Math.floor(Math.random() * 100_000)}`;
    const legalName = `同名待核验主体-${suffix}`;
    const create = (body: Record<string, unknown>, idempotencyKey?: string) => request('/api/merchants', {
      method: 'POST', headers: { ...headers, ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}) }, body: JSON.stringify(body),
    });
    const draft = (brandName: string, adminEmail: string) => ({
      agencyId: agency.id, legalName, brandName,
      adminName: '并发建档管理员', adminEmail, adminPassword: 'ConcurrentMerchant123',
    });

    const [sameNameFirst, sameNameSecond] = await Promise.all([
      create(draft(`同名草稿品牌一-${suffix}`, `merchant-subject-a-${suffix}@demo.local`)),
      create(draft(`同名草稿品牌二-${suffix}`, `merchant-subject-b-${suffix}@demo.local`)),
    ]);
    expect([sameNameFirst.status, sameNameSecond.status]).toEqual([201, 201]);

    const retryKey = `merchant-create-retry-${suffix}`;
    const retryBody = draft(`幂等创建品牌-${suffix}`, `merchant-retry-${suffix}@demo.local`);
    const [first, second] = await Promise.all([create(retryBody, retryKey), create(retryBody, retryKey)]);
    expect([first.status, second.status]).toEqual([201, 201]);
    const [firstMerchant, secondMerchant] = await Promise.all([first.json(), second.json()]) as Array<{ id: string } & Record<string, unknown>>;
    expect(firstMerchant.id).toBe(secondMerchant.id);
    expect(firstMerchant).not.toHaveProperty('createdBy');
    expect(firstMerchant).not.toHaveProperty('creationIdempotencyKey');
    expect(firstMerchant).not.toHaveProperty('creationRequestHash');

    const merchants = await app.get(DataSource).getRepository(Merchant).findBy({ legalName });
    expect(merchants).toHaveLength(3);
    const merchant = merchants.find((item) => item.id === firstMerchant.id)!;
    const merchantList = await (await request('/api/merchants', { headers })).json() as Array<Record<string, unknown>>;
    const merchantListItem = merchantList.find((item) => item.id === merchant.id)!;
    expect(merchantListItem).not.toHaveProperty('createdBy');
    expect(merchantListItem).not.toHaveProperty('creationIdempotencyKey');
    expect(merchantListItem).not.toHaveProperty('creationRequestHash');
    const audits = await app.get(DataSource).getRepository(AuditLog).find({ where: { action: 'MERCHANT_CREATED', resourceId: merchant.id } });
    expect(audits).toHaveLength(1);
    expect(await app.get(AuditChainService).verify()).toEqual(expect.objectContaining({ valid: true }));

    const reusedForDifferentBody = await create(draft(`不同内容-${suffix}`, `merchant-different-${suffix}@demo.local`), retryKey);
    expect(reusedForDifferentBody.status).toBe(409);
    const reusedForDifferentPassword = await create({ ...retryBody, adminPassword: 'DifferentMerchantPassword123' }, retryKey);
    expect(reusedForDifferentPassword.status).toBe(409);
  });

  it('deduplicates concurrent merchant sales-state changes without exposing replay controls', async () => {
    const platform = await login('platform@demo.local');
    const headers = { Authorization: `Bearer ${platform.token}`, 'Content-Type': 'application/json' };
    const agency = await app.get(DataSource).getRepository(Agency).findOneOrFail({ where: {}, order: { createdAt: 'ASC' } });
    const merchant = await app.get(DataSource).getRepository(Merchant).save({
      agencyId: agency.id, legalName: `状态幂等主体-${Date.now()}`, brandName: `状态幂等品牌-${Date.now()}`,
      status: MerchantStatus.ACTIVE, servicePhone: '', contractNumber: '', contractEndsAt: null,
    });
    const idempotencyKey = `merchant-status-${Date.now()}-001`;
    const transition = { status: MerchantStatus.SALES_SUSPENDED, expectedStatus: MerchantStatus.ACTIVE, statusReason: '平台确认演练期间暂停该商家的新订单。' };
    const [first, second] = await Promise.all([
      request(`/api/merchants/${merchant.id}`, { method: 'PATCH', headers: { ...headers, 'Idempotency-Key': idempotencyKey }, body: JSON.stringify(transition) }),
      request(`/api/merchants/${merchant.id}`, { method: 'PATCH', headers: { ...headers, 'Idempotency-Key': idempotencyKey }, body: JSON.stringify(transition) }),
    ]);
    expect([first.status, second.status]).toEqual([200, 200]);
    const [firstMerchant, secondMerchant] = await Promise.all([
      first.json() as Promise<Record<string, unknown>>,
      second.json() as Promise<Record<string, unknown>>,
    ]);
    expect(firstMerchant).toEqual(expect.objectContaining({ id: merchant.id, status: MerchantStatus.SALES_SUSPENDED }));
    expect(secondMerchant).toEqual(expect.objectContaining({ id: merchant.id, status: MerchantStatus.SALES_SUSPENDED }));
    expect(firstMerchant).not.toHaveProperty('idempotencyKey');
    expect(secondMerchant).not.toHaveProperty('idempotencyKey');
    expect((await request(`/api/merchants/${merchant.id}`, {
      method: 'PATCH', headers: { ...headers, 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify({ status: MerchantStatus.ACTIVE, expectedStatus: MerchantStatus.SALES_SUSPENDED, statusReason: '不能以同一请求标识恢复销售。' }),
    })).status).toBe(409);
    const commands = await app.get(DataSource).getRepository(MerchantStatusChangeCommand).createQueryBuilder('command')
      .addSelect(['command.idempotencyKey', 'command.requestHash'])
      .where('command.merchantId = :merchantId AND command.requestedBy = :requestedBy', { merchantId: merchant.id, requestedBy: platform.user.id })
      .getMany();
    expect(commands).toHaveLength(1);
    expect(commands[0]).toEqual(expect.objectContaining({
      expectedStatus: MerchantStatus.ACTIVE,
      targetStatus: MerchantStatus.SALES_SUSPENDED,
      idempotencyKey,
      requestHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    }));
    expect(await app.get(DataSource).getRepository(AuditLog).countBy({ action: 'MERCHANT_STATUS_CHANGED', resourceId: merchant.id })).toBe(1);
  });

  it('issues vouchers from the immutable paid-order snapshot', async () => {
    const platform = await login('platform@demo.local');
    const merchants = await (await request('/api/merchants', { headers: { Authorization: `Bearer ${platform.token}` } })).json() as Array<{ id: string; brandName: string }>;
    const merchant = merchants.find((item) => item.brandName === '花时间花艺')!;
    const customerHeaders = await customerSession();
    const storefront = await (await request(`/api/public/merchants/${merchant.id}`)).json() as { stores: Array<{ id: string }> };
    const publicPackage = (await (await request(`/api/public/merchants/${merchant.id}/packages`)).json() as Array<{ id: string; priceFen: number }>)[0];
    const order = await (await request(`/api/public/merchants/${merchant.id}/orders`, { method: 'POST', headers: customerHeaders, body: JSON.stringify({ packageId: publicPackage.id, storeId: storefront.stores[0].id, quantity: 1 }) })).json() as { id: string };

    const merchantAdmin = await login('merchant@demo.local');
    const packages = await (await request(`/api/merchants/${merchant.id}/packages`, { headers: { Authorization: `Bearer ${merchantAdmin.token}` } })).json() as Array<Record<string, unknown>>;
    const source = packages.find((item) => item.id === publicPackage.id)!;
    const update = await request(`/api/merchants/${merchant.id}/packages`, {
      method: 'POST', headers: { Authorization: `Bearer ${merchantAdmin.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: source.id, expectedVersion: Number(source.version), title: source.title, description: source.description, priceFen: Number(source.priceFen) + 1000, saleLimit: source.saleLimit, perCustomerLimit: source.perCustomerLimit, storeIds: source.storeIds, validFrom: String(source.validFrom).slice(0, 10), validTo: String(source.validTo).slice(0, 10), status: source.status }),
    });
    expect(update.status).toBe(201);

    const paid = await (await request(`/api/public/orders/${order.id}/mock-confirm`, { method: 'POST', headers: customerHeaders })).json() as { vouchers: Array<{ id: string; faceValueFen: number }> };
    expect(paid.vouchers[0].faceValueFen).toBe(publicPackage.priceFen);
    const customerVouchers = await (await request('/api/public/vouchers', { headers: customerHeaders })).json() as Array<Record<string, unknown>>;
    const customerVoucher = customerVouchers.find((voucher) => voucher.id === paid.vouchers[0].id)!;
    expect(customerVoucher).toEqual(expect.objectContaining({
      merchantId: merchant.id,
      merchantName: '花时间花艺',
      packageTitle: String(source.title),
      storeId: storefront.stores[0].id,
      storeName: expect.any(String),
      storeAddress: expect.any(String),
    }));
    expect(customerVoucher).not.toHaveProperty('customerId');
    expect(customerVoucher).not.toHaveProperty('commissionRateSnapshot');
  });

  it('renders expired vouchers and rejects their dynamic code without sweeping every tenant voucher', async () => {
    const platform = await login('platform@demo.local');
    const merchant = (await (await request('/api/merchants', { headers: { Authorization: `Bearer ${platform.token}` } })).json() as Array<{ id: string; brandName: string }>).find((item) => item.brandName === '花时间花艺')!;
    const customerHeaders = await customerSession();
    const storefront = await (await request(`/api/public/merchants/${merchant.id}`)).json() as { stores: Array<{ id: string }> };
    const deal = (await (await request(`/api/public/merchants/${merchant.id}/packages`)).json() as Array<{ id: string; storeIds: string[] }>).find((item) => item.storeIds.includes(storefront.stores[0].id))!;
    const order = await (await request(`/api/public/merchants/${merchant.id}/orders`, { method: 'POST', headers: customerHeaders, body: JSON.stringify({ packageId: deal.id, storeId: storefront.stores[0].id, quantity: 1 }) })).json() as { id: string };
    const payment = await (await request(`/api/public/orders/${order.id}/mock-confirm`, { method: 'POST', headers: customerHeaders })).json() as { vouchers: Array<{ id: string }> };
    const voucherId = payment.vouchers[0].id;
    await app.get(DataSource).getRepository(Voucher).update(voucherId, { validTo: new Date(Date.now() - 24 * 60 * 60_000) });

    const listed = await (await request('/api/public/vouchers', { headers: customerHeaders })).json() as Array<{ id: string; status: string }>;
    expect(listed.find((voucher) => voucher.id === voucherId)?.status).toBe(VoucherStatus.EXPIRED);
    expect((await app.get(DataSource).getRepository(Voucher).findOneByOrFail({ id: voucherId })).status).toBe(VoucherStatus.UNUSED);
    expect((await request(`/api/public/vouchers/${voucherId}/dynamic-code`, { method: 'POST', headers: customerHeaders })).status).toBe(400);
    expect((await app.get(DataSource).getRepository(Voucher).findOneByOrFail({ id: voucherId })).status).toBe(VoucherStatus.UNUSED);
  });

  it('deduplicates customer order retries without releasing the idempotency key to merchant views', async () => {
    const platform = await login('platform@demo.local');
    const merchant = (await (await request('/api/merchants', { headers: { Authorization: `Bearer ${platform.token}` } })).json() as Array<{ id: string; brandName: string }>).find((item) => item.brandName === '花时间花艺')!;
    const customer = await customerSession();
    const storefront = await (await request(`/api/public/merchants/${merchant.id}`)).json() as { stores: Array<{ id: string }> };
    const deal = (await (await request(`/api/public/merchants/${merchant.id}/packages`)).json() as Array<{ id: string; storeIds: string[] }>).find((item) => item.storeIds.includes(storefront.stores[0].id))!;
    const orderPath = `/api/public/merchants/${merchant.id}/orders`;
    const idempotencyKey = 'order-retry-20260718-001';
    const orderBody = { idempotencyKey, packageId: deal.id, storeId: storefront.stores[0].id, quantity: 1 };
    const [first, second] = await Promise.all([
      request(orderPath, { method: 'POST', headers: customer, body: JSON.stringify(orderBody) }),
      request(orderPath, { method: 'POST', headers: customer, body: JSON.stringify(orderBody) }),
    ]);
    expect([first.status, second.status]).toEqual([201, 201]);
    const [firstOrder, secondOrder] = await Promise.all([first.json(), second.json()]) as Array<{ id: string }>;
    expect(firstOrder.id).toBe(secondOrder.id);
    expect(await app.get(DataSource).getRepository(Order).countBy({ idempotencyKey })).toBe(1);

    expect((await request(orderPath, {
      method: 'POST', headers: customer, body: JSON.stringify({ ...orderBody, quantity: 2 }),
    })).status).toBe(409);
    const missingKeyResponse = await fetch(`${baseUrl}${orderPath}`, {
      method: 'POST', headers: customer, body: JSON.stringify({ packageId: deal.id, storeId: storefront.stores[0].id, quantity: 1 }),
    });
    expect(missingKeyResponse.status).toBe(400);

    const merchantAdmin = await login('merchant@demo.local');
    const orders = await (await request(`/api/orders?merchantId=${merchant.id}`, { headers: { Authorization: `Bearer ${merchantAdmin.token}` } })).json() as { items: Array<Record<string, unknown>> };
    const merchantOrder = orders.items.find((order) => order.id === firstOrder.id)!;
    expect(merchantOrder).not.toHaveProperty('idempotencyKey');
  });

  it('deduplicates concurrent export requests by operator idempotency key', async () => {
    const merchantAdmin = await login('merchant@demo.local');
    const headers = { Authorization: `Bearer ${merchantAdmin.token}`, 'Content-Type': 'application/json', 'Idempotency-Key': 'export-retry-20260720-001' };
    const merchantId = merchantAdmin.user.merchantId!;
    const payload = JSON.stringify({ kind: 'orders', merchantId });
    const [firstResponse, secondResponse] = await Promise.all([
      request('/api/exports', { method: 'POST', headers, body: payload }),
      request('/api/exports', { method: 'POST', headers, body: payload }),
    ]);
    expect([firstResponse.status, secondResponse.status]).toEqual([201, 201]);
    const [first, second] = await Promise.all([firstResponse.json(), secondResponse.json()]) as Array<{ id: string }>;
    expect(first.id).toBe(second.id);
    expect((await request('/api/exports', { method: 'POST', headers, body: JSON.stringify({ kind: 'verifications', merchantId }) })).status).toBe(409);
    expect((await request('/api/exports', { method: 'POST', headers: { ...headers, 'Idempotency-Key': 'short' }, body: payload })).status).toBe(400);
    const stored = await app.get(DataSource).getRepository(ExportJob).createQueryBuilder('job')
      .addSelect(['job.idempotencyKey', 'job.requestHash'])
      .where('job.id = :id', { id: first.id })
      .getOneOrFail();
    expect(stored).toEqual(expect.objectContaining({ idempotencyKey: headers['Idempotency-Key'], requestHash: expect.stringMatching(/^[a-f0-9]{64}$/) }));
    expect(await app.get(DataSource).getRepository(ExportJob).countBy({ requestedBy: merchantAdmin.user.id, idempotencyKey: headers['Idempotency-Key'] })).toBe(1);
    expect(first).not.toHaveProperty('idempotencyKey');
  });

  it('does not allow a package sales cap below already reserved inventory', async () => {
    const platform = await login('platform@demo.local');
    const merchant = (await (await request('/api/merchants', { headers: { Authorization: `Bearer ${platform.token}` } })).json() as Array<{ id: string; brandName: string }>).find((item) => item.brandName === '花时间花艺')!;
    const merchantAdmin = await login('merchant@demo.local');
    const headers = { Authorization: `Bearer ${merchantAdmin.token}`, 'Content-Type': 'application/json' };
    const storeInput = { name: '销量校验门店', address: '广州市天河区销量校验路 1 号', phone: '020-8888-9999', businessHours: '09:00-21:00', openForSale: true };
    const store = await (await request(`/api/merchants/${merchant.id}/stores`, {
      method: 'POST', headers, body: JSON.stringify(storeInput),
    })).json() as { id: string };
    const deal = await (await request(`/api/merchants/${merchant.id}/packages`, {
      method: 'POST', headers, body: JSON.stringify({ title: '销量校验套餐', description: '验证已占用库存的销量上限。', priceFen: 990, saleLimit: 2, perCustomerLimit: 2, storeIds: [store.id], validFrom: '2026-01-01', validTo: '2027-12-31', status: 'ON_SALE' }),
    })).json() as { id: string; version: number; title: string; description: string; priceFen: number; saleLimit: number; perCustomerLimit: number; storeIds: string[]; validFrom: string; validTo: string; status: string };
    const customer = await customerSession();
    const reserved = await request(`/api/public/merchants/${merchant.id}/orders`, {
      method: 'POST', headers: customer, body: JSON.stringify({ packageId: deal.id, storeId: store.id, quantity: 2 }),
    });
    expect(reserved.status).toBe(201);
    const belowReserved = await request(`/api/merchants/${merchant.id}/packages`, {
      method: 'POST', headers, body: JSON.stringify({ id: deal.id, expectedVersion: deal.version, title: deal.title, description: deal.description, priceFen: deal.priceFen, saleLimit: 1, perCustomerLimit: deal.perCustomerLimit, storeIds: deal.storeIds, validFrom: String(deal.validFrom).slice(0, 10), validTo: String(deal.validTo).slice(0, 10), status: deal.status }),
    });
    expect(belowReserved.status).toBe(400);
    expect((await belowReserved.json()).message).toContain('总销量上限不能低于已售或已占用数量');
    expect((await request(`/api/merchants/${merchant.id}/packages/${deal.id}/status`, {
      method: 'POST', headers, body: JSON.stringify({ status: 'OFF_SALE', expectedVersion: deal.version }),
    })).status).toBe(201);
    expect((await request(`/api/merchants/${merchant.id}/stores`, {
      method: 'POST', headers, body: JSON.stringify({ ...storeInput, id: store.id, openForSale: false }),
    })).status).toBe(201);
  });

  it('releases expired payment reservations exactly once so inventory can be sold again', async () => {
    const platform = await login('platform@demo.local');
    const headers = { Authorization: `Bearer ${platform.token}`, 'Content-Type': 'application/json' };
    const agency = (await (await request('/api/agencies', { headers })).json() as Array<{ id: string }>)[0];
    const merchant = await (await request('/api/merchants', {
      method: 'POST', headers,
      body: JSON.stringify({ agencyId: agency.id, legalName: '库存释放测试商家主体', brandName: '库存释放测试商家', contractNumber: 'RESERVATION-TEST-001', contractEndsAt: '2027-12-31' }),
    })).json() as { id: string };
    await app.get(DataSource).getRepository(CommissionRateVersion).save({ merchantId: merchant.id, rate: '0.0800', effectiveFrom: new Date('2026-01-01'), note: '支付服务商同步测试快照', createdBy: 'test' });
    const store = await (await request(`/api/merchants/${merchant.id}/stores`, {
      method: 'POST', headers, body: JSON.stringify({ name: '库存释放门店', address: '广州市天河区库存路 1 号', openForSale: true }),
    })).json() as { id: string };
    const deal = await (await request(`/api/merchants/${merchant.id}/packages`, {
      method: 'POST', headers,
      body: JSON.stringify({ title: '库存释放测试套餐', description: '验证待支付库存自动回补。', priceFen: 990, saleLimit: 1, perCustomerLimit: 1, storeIds: [store.id], validFrom: '2026-01-01', validTo: '2027-12-31', status: 'ON_SALE' }),
    })).json() as { id: string };
    const customer = await customerSession();
    const first = await request(`/api/public/merchants/${merchant.id}/orders`, {
      method: 'POST', headers: customer, body: JSON.stringify({ idempotencyKey: 'reservation-order-first', packageId: deal.id, storeId: store.id, quantity: 1 }),
    });
    expect(first.status).toBe(201);
    const firstOrder = await first.json() as { id: string };
    expect((await request(`/api/public/merchants/${merchant.id}/orders`, {
      method: 'POST', headers: customer, body: JSON.stringify({ idempotencyKey: 'reservation-order-rejected', packageId: deal.id, storeId: store.id, quantity: 1 }),
    })).status).toBe(400);
    await app.get(DataSource).getRepository(Order).update(firstOrder.id, { paymentExpiresAt: new Date(Date.now() - 1_000) });
    expect(await app.get(PaymentProcessingService).expirePendingOrders()).toBeGreaterThanOrEqual(1);
    expect((await app.get(DataSource).getRepository(Order).findOneByOrFail({ id: firstOrder.id })).status).toBe(OrderStatus.CLOSED);
    expect((await app.get(DataSource).getRepository(DealPackage).findOneByOrFail({ id: deal.id })).soldCount).toBe(0);
    const second = await request(`/api/public/merchants/${merchant.id}/orders`, {
      method: 'POST', headers: customer, body: JSON.stringify({ idempotencyKey: 'reservation-order-second', packageId: deal.id, storeId: store.id, quantity: 1 }),
    });
    expect(second.status).toBe(201);
    expect((await app.get(DataSource).getRepository(DealPackage).findOneByOrFail({ id: deal.id })).soldCount).toBe(1);
    const secondOrder = await second.json() as { id: string };
    await app.get(DataSource).getRepository(Order).update(secondOrder.id, { paymentExpiresAt: new Date(Date.now() - 1_000) });
    expect(await app.get(PaymentProcessingService).expirePendingOrders()).toBeGreaterThanOrEqual(1);
    expect((await app.get(DataSource).getRepository(DealPackage).findOneByOrFail({ id: deal.id })).soldCount).toBe(0);
    await app.get(DataSource).getRepository(DealPackage).update(deal.id, { status: PackageStatus.OFF_SALE });
  });

  it('processes expired order and voucher queues together without corrupting reserved inventory', async () => {
    const platform = await login('platform@demo.local');
    const headers = { Authorization: `Bearer ${platform.token}`, 'Content-Type': 'application/json' };
    const agency = (await (await request('/api/agencies', { headers })).json() as Array<{ id: string }>)[0];
    const merchant = await (await request('/api/merchants', {
      method: 'POST', headers,
      body: JSON.stringify({ agencyId: agency.id, legalName: '过期队列测试商家主体', brandName: '过期队列测试商家', contractNumber: 'EXPIRY-QUEUE-TEST-001', contractEndsAt: '2027-12-31' }),
    })).json() as { id: string };
    await app.get(DataSource).getRepository(CommissionRateVersion).save({ merchantId: merchant.id, rate: '0.0800', effectiveFrom: new Date('2026-01-01'), note: '支付服务商同步测试快照', createdBy: 'test' });
    const store = await (await request(`/api/merchants/${merchant.id}/stores`, {
      method: 'POST', headers, body: JSON.stringify({ name: '过期队列测试门店', address: '广州市天河区过期队列路 1 号', openForSale: true }),
    })).json() as { id: string };
    const deal = await (await request(`/api/merchants/${merchant.id}/packages`, {
      method: 'POST', headers,
      body: JSON.stringify({ title: '过期队列测试套餐', description: '验证订单与券的独立批量过期处理。', priceFen: 990, saleLimit: 2, perCustomerLimit: 1, storeIds: [store.id], validFrom: '2026-01-01', validTo: '2027-12-31', status: 'ON_SALE' }),
    })).json() as { id: string };
    const paidCustomer = await customerSession();
    const pendingCustomer = await customerSession();
    const paidOrderResponse = await request(`/api/public/merchants/${merchant.id}/orders`, {
      method: 'POST', headers: paidCustomer, body: JSON.stringify({ idempotencyKey: 'expiry-queue-paid-order', packageId: deal.id, storeId: store.id, quantity: 1 }),
    });
    const paidOrder = await paidOrderResponse.json() as { id: string };
    const payment = await (await request(`/api/public/orders/${paidOrder.id}/mock-confirm`, { method: 'POST', headers: paidCustomer })).json() as { vouchers: Array<{ id: string }> };
    const pendingOrderResponse = await request(`/api/public/merchants/${merchant.id}/orders`, {
      method: 'POST', headers: pendingCustomer, body: JSON.stringify({ idempotencyKey: 'expiry-queue-pending-order', packageId: deal.id, storeId: store.id, quantity: 1 }),
    });
    const pendingOrder = await pendingOrderResponse.json() as { id: string };
    const dataSource = app.get(DataSource);
    await dataSource.getRepository(Order).update(pendingOrder.id, { paymentExpiresAt: new Date(Date.now() - 1_000) });
    await dataSource.getRepository(Voucher).update(payment.vouchers[0].id, { validTo: new Date('2026-01-01T00:00:00.000Z') });

    const result = await app.get(LifecycleOrchestrationService).processExpiryQueues();

    expect(result).toEqual(expect.objectContaining({ closedOrders: expect.any(Number), expiredVouchers: expect.any(Number), expiryQueue: expect.any(Object) }));
    expect(result.closedOrders).toBeGreaterThanOrEqual(1);
    expect(result.expiredVouchers).toBeGreaterThanOrEqual(1);
    expect((await dataSource.getRepository(Order).findOneByOrFail({ id: pendingOrder.id })).status).toBe(OrderStatus.CLOSED);
    expect((await dataSource.getRepository(Voucher).findOneByOrFail({ id: payment.vouchers[0].id })).status).toBe(VoucherStatus.EXPIRED);
    expect((await dataSource.getRepository(DealPackage).findOneByOrFail({ id: deal.id })).soldCount).toBe(1);
  });

  it('keeps recently reconciled expired payments reserved until the provider query cooldown elapses', async () => {
    const platform = await login('platform@demo.local');
    const headers = { Authorization: `Bearer ${platform.token}`, 'Content-Type': 'application/json' };
    const agency = (await (await request('/api/agencies', { headers })).json() as Array<{ id: string }>)[0];
    const merchant = await (await request('/api/merchants', {
      method: 'POST', headers,
      body: JSON.stringify({ agencyId: agency.id, legalName: '支付冷却测试商家主体', brandName: '支付冷却测试商家', contractNumber: 'PAYMENT-COOLDOWN-TEST-001', contractEndsAt: '2027-12-31' }),
    })).json() as { id: string };
    await app.get(DataSource).getRepository(CommissionRateVersion).save({ merchantId: merchant.id, rate: '0.0800', effectiveFrom: new Date('2026-01-01'), note: '支付服务商同步测试快照', createdBy: 'test' });
    const store = await (await request(`/api/merchants/${merchant.id}/stores`, {
      method: 'POST', headers, body: JSON.stringify({ name: '支付冷却测试门店', address: '广州市天河区支付冷却路 1 号', openForSale: true }),
    })).json() as { id: string };
    const deal = await (await request(`/api/merchants/${merchant.id}/packages`, {
      method: 'POST', headers,
      body: JSON.stringify({ title: '支付冷却测试套餐', description: '验证支付查单冷却期间保留库存。', priceFen: 990, saleLimit: 1, perCustomerLimit: 1, storeIds: [store.id], validFrom: '2026-01-01', validTo: '2027-12-31', status: 'ON_SALE' }),
    })).json() as { id: string };
    const customer = await customerSession();
    const orderResponse = await request(`/api/public/merchants/${merchant.id}/orders`, {
      method: 'POST', headers: customer, body: JSON.stringify({ idempotencyKey: 'payment-cooldown-order', packageId: deal.id, storeId: store.id, quantity: 1 }),
    });
    const order = await orderResponse.json() as { id: string };
    const dataSource = app.get(DataSource);
    const outbox = await dataSource.getRepository(PaymentOutbox).findOneByOrFail({ orderId: order.id });
    expect(outbox.status).toBe(PaymentOutboxStatus.DISPATCHED);
    await dataSource.getRepository(Order).update(order.id, { paymentExpiresAt: new Date(Date.now() - 1_000) });
    await dataSource.getRepository(PaymentOutbox).update(outbox.id, { lastReconciledAt: new Date() });
    const provider = app.get<MockPaymentProvider>(PAYMENT_PROVIDER);
    const querySpy = jest.spyOn(provider, 'queryPayment');
    try {
      expect(await app.get(PaymentProcessingService).expirePendingOrders()).toBe(0);
      expect(querySpy).not.toHaveBeenCalled();
      expect((await dataSource.getRepository(Order).findOneByOrFail({ id: order.id })).status).toBe(OrderStatus.PENDING_PAYMENT);
      expect((await dataSource.getRepository(DealPackage).findOneByOrFail({ id: deal.id })).soldCount).toBe(1);

      await dataSource.getRepository(PaymentOutbox).update(outbox.id, { lastReconciledAt: new Date(Date.now() - 61_000) });
      expect(await app.get(PaymentProcessingService).expirePendingOrders()).toBeGreaterThanOrEqual(1);
      expect(querySpy).toHaveBeenCalledTimes(1);
    } finally {
      querySpy.mockRestore();
    }
    expect((await dataSource.getRepository(Order).findOneByOrFail({ id: order.id })).status).toBe(OrderStatus.CLOSED);
    expect((await dataSource.getRepository(DealPackage).findOneByOrFail({ id: deal.id })).soldCount).toBe(0);
  });

  it('returns a customer-specific purchase ceiling for pending, paid, expired, and unavailable inventory', async () => {
    const platform = await login('platform@demo.local');
    const headers = { Authorization: `Bearer ${platform.token}`, 'Content-Type': 'application/json' };
    const agency = (await (await request('/api/agencies', { headers })).json() as Array<{ id: string }>)[0];
    const merchant = await (await request('/api/merchants', {
      method: 'POST', headers,
      body: JSON.stringify({ agencyId: agency.id, legalName: '可购额度测试主体', brandName: '可购额度测试商家', contractNumber: 'AVAILABILITY-TEST-001', contractEndsAt: '2027-12-31' }),
    })).json() as { id: string };
    await app.get(DataSource).getRepository(CommissionRateVersion).save({ merchantId: merchant.id, rate: '0.0800', effectiveFrom: new Date('2026-01-01'), note: '支付服务商同步测试快照', createdBy: 'test' });
    const store = await (await request(`/api/merchants/${merchant.id}/stores`, {
      method: 'POST', headers, body: JSON.stringify({ name: '可购额度测试门店', address: '广州市天河区额度路 1 号', openForSale: true }),
    })).json() as { id: string };
    const deal = await (await request(`/api/merchants/${merchant.id}/packages`, {
      method: 'POST', headers,
      body: JSON.stringify({ title: '可购额度测试套餐', description: '验证顾客侧购买额度。', priceFen: 990, saleLimit: 4, perCustomerLimit: 2, storeIds: [store.id], validFrom: '2026-01-01', validTo: '2027-12-31', status: 'ON_SALE' }),
    })).json() as { id: string };
    const firstCustomer = await customerSession();
    const secondCustomer = await customerSession();
    const availabilityPath = `/api/public/merchants/${merchant.id}/packages/${deal.id}/purchase-availability`;

    expect((await request(availabilityPath)).status).toBe(401);
    const initial = await (await request(availabilityPath, { headers: firstCustomer })).json() as Record<string, unknown>;
    expect(initial).toEqual({ remainingStock: 4, perCustomerRemaining: 2, maxQuantity: 2, storeIds: [store.id], reason: null });
    expect(initial).not.toHaveProperty('purchasedQuantity');

    const pendingResponse = await request(`/api/public/merchants/${merchant.id}/orders`, {
      method: 'POST', headers: firstCustomer, body: JSON.stringify({ idempotencyKey: 'availability-pending-order', packageId: deal.id, storeId: store.id, quantity: 1 }),
    });
    expect(pendingResponse.status).toBe(201);
    const pendingOrder = await pendingResponse.json() as { id: string };
    expect(await (await request(availabilityPath, { headers: firstCustomer })).json()).toEqual({ remainingStock: 3, perCustomerRemaining: 1, maxQuantity: 1, storeIds: [store.id], reason: null });
    expect(await (await request(availabilityPath, { headers: secondCustomer })).json()).toEqual({ remainingStock: 3, perCustomerRemaining: 2, maxQuantity: 2, storeIds: [store.id], reason: null });

    const paid = await request(`/api/public/orders/${pendingOrder.id}/mock-confirm`, { method: 'POST', headers: firstCustomer });
    expect(paid.status).toBe(201);
    expect(await (await request(availabilityPath, { headers: firstCustomer })).json()).toEqual({ remainingStock: 3, perCustomerRemaining: 1, maxQuantity: 1, storeIds: [store.id], reason: null });

    const secondOrderResponse = await request(`/api/public/merchants/${merchant.id}/orders`, {
      method: 'POST', headers: firstCustomer, body: JSON.stringify({ idempotencyKey: 'availability-second-order', packageId: deal.id, storeId: store.id, quantity: 1 }),
    });
    expect(secondOrderResponse.status).toBe(201);
    const secondOrder = await secondOrderResponse.json() as { id: string };
    expect(await (await request(availabilityPath, { headers: firstCustomer })).json()).toEqual(expect.objectContaining({ remainingStock: 2, perCustomerRemaining: 0, maxQuantity: 0, reason: 'PERSONAL_LIMIT_REACHED' }));

    await app.get(DataSource).getRepository(Order).update(secondOrder.id, { paymentExpiresAt: new Date(Date.now() - 1_000) });
    // Customer reads do not run the cross-tenant lifecycle sweep. They still
    // exclude an expired reservation from this customer's purchase ceiling;
    // package-wide inventory is conservatively released by the worker.
    expect(await (await request(availabilityPath, { headers: firstCustomer })).json()).toEqual({ remainingStock: 2, perCustomerRemaining: 1, maxQuantity: 1, storeIds: [store.id], reason: null });
    expect(await app.get(PaymentProcessingService).expirePendingOrders()).toBeGreaterThanOrEqual(1);
    expect(await (await request(availabilityPath, { headers: firstCustomer })).json()).toEqual({ remainingStock: 3, perCustomerRemaining: 1, maxQuantity: 1, storeIds: [store.id], reason: null });

    await app.get(DataSource).getRepository(Store).update(store.id, { openForSale: false });
    expect(await (await request(availabilityPath, { headers: firstCustomer })).json()).toEqual(expect.objectContaining({ maxQuantity: 0, storeIds: [], reason: 'NO_AVAILABLE_STORE' }));

    await app.get(DataSource).getRepository(DealPackage).update(deal.id, { status: PackageStatus.OFF_SALE });
    expect(await (await request(availabilityPath, { headers: firstCustomer })).json()).toEqual(expect.objectContaining({ maxQuantity: 0, reason: 'PACKAGE_UNAVAILABLE' }));
  });

  it('uses high-entropy unique identifiers for orders and every voucher in a multi-voucher order', async () => {
    const platform = await login('platform@demo.local');
    const merchant = (await (await request('/api/merchants', { headers: { Authorization: `Bearer ${platform.token}` } })).json() as Array<{ id: string; brandName: string }>).find((item) => item.brandName === '花时间花艺')!;
    const customer = await customerSession();
    const storefront = await (await request(`/api/public/merchants/${merchant.id}`)).json() as { stores: Array<{ id: string }> };
    const deal = (await (await request(`/api/public/merchants/${merchant.id}/packages`)).json() as Array<{ id: string; storeIds: string[]; perCustomerLimit: number }>).find((item) => item.storeIds.includes(storefront.stores[0].id) && (!item.perCustomerLimit || item.perCustomerLimit >= 2))!;
    const orderResponse = await request(`/api/public/merchants/${merchant.id}/orders`, {
      method: 'POST', headers: customer, body: JSON.stringify({ packageId: deal.id, storeId: storefront.stores[0].id, quantity: 2 }),
    });
    expect(orderResponse.status).toBe(201);
    const order = await orderResponse.json() as { id: string; orderNo: string };
    expect(order.orderNo).toMatch(/^DG\d{8}[A-F0-9]{16}$/);
    const payment = await (await request(`/api/public/orders/${order.id}/mock-confirm`, { method: 'POST', headers: customer })).json() as { vouchers: Array<{ code: string }> };
    expect(payment.vouchers).toHaveLength(2);
    expect(payment.vouchers.every((voucher) => /^[A-F0-9]{16}$/.test(voucher.code))).toBe(true);
    expect(new Set(payment.vouchers.map((voucher) => voucher.code)).size).toBe(2);
  });

  it('pages a customers voucher history with a stable cursor and never crosses customer scope', async () => {
    const platform = await login('platform@demo.local');
    const merchant = (await (await request('/api/merchants', { headers: { Authorization: `Bearer ${platform.token}` } })).json() as Array<{ id: string; brandName: string }>).find((item) => item.brandName === '花时间花艺')!;
    const customer = await customerSession();
    const anotherCustomer = await customerSession();
    const storefront = await (await request(`/api/public/merchants/${merchant.id}`)).json() as { stores: Array<{ id: string }> };
    const deal = (await (await request(`/api/public/merchants/${merchant.id}/packages`)).json() as Array<{ id: string; storeIds: string[]; perCustomerLimit: number }>).find((item) => item.storeIds.includes(storefront.stores[0].id) && (!item.perCustomerLimit || item.perCustomerLimit >= 3))!;
    const order = await (await request(`/api/public/merchants/${merchant.id}/orders`, {
      method: 'POST', headers: customer, body: JSON.stringify({ packageId: deal.id, storeId: storefront.stores[0].id, quantity: 3 }),
    })).json() as { id: string };
    const payment = await (await request(`/api/public/orders/${order.id}/mock-confirm`, { method: 'POST', headers: customer })).json() as { vouchers: Array<{ id: string }> };
    const firstResponse = await request('/api/public/vouchers/page?limit=2', { headers: customer });
    expect(firstResponse.status).toBe(200);
    const first = await firstResponse.json() as { items: Array<{ id: string }>; nextCursor: string | null };
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).toEqual(expect.any(String));
    const secondResponse = await request(`/api/public/vouchers/page?limit=2&cursor=${encodeURIComponent(first.nextCursor!)}`, { headers: customer });
    expect(secondResponse.status).toBe(200);
    const second = await secondResponse.json() as { items: Array<{ id: string }>; nextCursor: string | null };
    expect(second.items).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    expect(new Set([...first.items, ...second.items].map((voucher) => voucher.id))).toEqual(new Set(payment.vouchers.map((voucher) => voucher.id)));
    const other = await (await request(`/api/public/vouchers/page?limit=2&cursor=${encodeURIComponent(first.nextCursor!)}`, { headers: anotherCustomer })).json() as { items: Array<unknown>; nextCursor: string | null };
    expect(other).toEqual({ items: [], nextCursor: null });
    expect((await request('/api/public/vouchers/page?limit=2&cursor=invalid*cursor', { headers: customer })).status).toBe(400);
  });

  it('throttles legacy customer history reads and restores access after the window resets', async () => {
    const customer = await customerSession();
    const customerId = String((jwt.decode(customer.Authorization!.slice('Bearer '.length)) as jwt.JwtPayload).sub);
    const throttles = app.get(DataSource).getRepository(RequestThrottle);
    const throttleKey = (scope: string) => createHmac('sha256', throttleKeySecret()).update(`${scope}:${customerId}`).digest('hex');
    const resetAt = new Date(Date.now() + 60_000);
    await throttles.save([
      { throttleKey: throttleKey('customer-voucher-legacy'), hitCount: 60, resetAt },
      { throttleKey: throttleKey('customer-support-ticket-list'), hitCount: 60, resetAt },
    ]);
    const vouchersLimited = await request('/api/public/vouchers', { headers: customer });
    expect(vouchersLimited.status).toBe(429);
    const vouchersLimitedBody = await vouchersLimited.json() as { retryAfterSeconds: number };
    expect(vouchersLimitedBody).toEqual(expect.objectContaining({ retryAfterSeconds: expect.any(Number) }));
    expect(vouchersLimited.headers.get('retry-after')).toBe(String(vouchersLimitedBody.retryAfterSeconds));
    expect((await request('/api/public/support-tickets', { headers: customer })).status).toBe(429);
    await throttles.update({ throttleKey: throttleKey('customer-voucher-legacy') }, { resetAt: new Date(Date.now() - 1_000) });
    expect((await request('/api/public/vouchers', { headers: customer })).status).toBe(200);
  });

  it('keeps payment intent dispatch outside order creation and deduplicates concurrent payment events', async () => {
    const platform = await login('platform@demo.local');
    const merchant = (await (await request('/api/merchants', { headers: { Authorization: `Bearer ${platform.token}` } })).json() as Array<{ id: string; brandName: string }>).find((item) => item.brandName === '花时间花艺')!;
    const customer = await customerSession();
    const storefront = await (await request(`/api/public/merchants/${merchant.id}`)).json() as { stores: Array<{ id: string }> };
    const deal = (await (await request(`/api/public/merchants/${merchant.id}/packages`)).json() as Array<{ id: string; storeIds: string[]; perCustomerLimit: number }>).find((item) => item.storeIds.includes(storefront.stores[0].id) && (!item.perCustomerLimit || item.perCustomerLimit >= 1))!;
    const orderResponse = await request(`/api/public/merchants/${merchant.id}/orders`, {
      method: 'POST', headers: customer, body: JSON.stringify({ packageId: deal.id, storeId: storefront.stores[0].id, quantity: 1 }),
    });
    expect(orderResponse.status).toBe(201);
    const order = await orderResponse.json() as { id: string };
    const outbox = await app.get(DataSource).getRepository(PaymentOutbox).findOneByOrFail({ orderId: order.id });
    expect(outbox).toEqual(expect.objectContaining({ status: PaymentOutboxStatus.DISPATCHED, providerReference: expect.stringMatching(/^mock_intent_/) }));
    expect((await request('/api/payments/webhooks/mock', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status).toBe(400);

    const [first, second] = await Promise.all([
      request(`/api/public/orders/${order.id}/mock-confirm`, { method: 'POST', headers: customer }),
      request(`/api/public/orders/${order.id}/mock-confirm`, { method: 'POST', headers: customer }),
    ]);
    expect([first.status, second.status]).toEqual([201, 201]);
    const events = await app.get(DataSource).getRepository(PaymentEvent).findBy({ orderId: order.id });
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual(expect.objectContaining({ status: PaymentEventStatus.PROCESSED }));
    expect(await app.get(DataSource).getRepository(Voucher).countBy({ orderId: order.id })).toBe(1);
    expect((await app.get(DataSource).getRepository(PaymentOutbox).findOneByOrFail({ orderId: order.id })).status).toBe(PaymentOutboxStatus.COMPLETED);
  });

  it('retires legacy dispatched rows so old paid orders cannot starve newer payment reconciliation', async () => {
    const platform = await login('platform@demo.local');
    const merchant = (await (await request('/api/merchants', { headers: { Authorization: `Bearer ${platform.token}` } })).json() as Array<{ id: string; brandName: string }>).find((item) => item.brandName === '花时间花艺')!;
    const storefront = await (await request(`/api/public/merchants/${merchant.id}`)).json() as { stores: Array<{ id: string }> };
    const deal = (await (await request(`/api/public/merchants/${merchant.id}/packages`)).json() as Array<{ id: string; storeIds: string[]; perCustomerLimit: number }>).find((item) => item.storeIds.includes(storefront.stores[0].id) && (!item.perCustomerLimit || item.perCustomerLimit >= 1))!;
    const paidCustomer = await customerSession();
    const paidOrder = await (await request(`/api/public/merchants/${merchant.id}/orders`, {
      method: 'POST', headers: paidCustomer, body: JSON.stringify({ packageId: deal.id, storeId: storefront.stores[0].id, quantity: 1 }),
    })).json() as { id: string };
    await request(`/api/public/orders/${paidOrder.id}/mock-confirm`, { method: 'POST', headers: paidCustomer });
    const pendingCustomer = await customerSession();
    const pendingOrder = await (await request(`/api/public/merchants/${merchant.id}/orders`, {
      method: 'POST', headers: pendingCustomer, body: JSON.stringify({ packageId: deal.id, storeId: storefront.stores[0].id, quantity: 1 }),
    })).json() as { id: string };
    const outboxes = app.get(DataSource).getRepository(PaymentOutbox);
    const paidOutbox = await outboxes.findOneByOrFail({ orderId: paidOrder.id });
    const pendingOutbox = await outboxes.findOneByOrFail({ orderId: pendingOrder.id });
    await outboxes.createQueryBuilder().update().set({ lastReconciledAt: new Date() }).where('status = :status AND id NOT IN (:...ids)', { status: PaymentOutboxStatus.DISPATCHED, ids: [paidOutbox.id, pendingOutbox.id] }).execute();
    await outboxes.update(paidOutbox.id, { status: PaymentOutboxStatus.DISPATCHED, lastReconciledAt: null });
    expect(await app.get(PaymentProcessingService).reconcileDispatchedIntents(1)).toEqual({ queried: 0, recovered: 0, failed: 0 });
    expect((await outboxes.findOneByOrFail({ id: paidOutbox.id })).status).toBe(PaymentOutboxStatus.COMPLETED);
    expect(await app.get(PaymentProcessingService).reconcileDispatchedIntents(1)).toEqual({ queried: 1, recovered: 0, failed: 0 });
    expect((await outboxes.findOneByOrFail({ id: pendingOutbox.id })).lastReconciledAt).toBeInstanceOf(Date);
  });

  it('reconciles a paid result before releasing an expired payment reservation', async () => {
    const platform = await login('platform@demo.local');
    const merchant = (await (await request('/api/merchants', { headers: { Authorization: `Bearer ${platform.token}` } })).json() as Array<{ id: string; brandName: string }>).find((item) => item.brandName === '花时间花艺')!;
    const customer = await customerSession();
    const storefront = await (await request(`/api/public/merchants/${merchant.id}`)).json() as { stores: Array<{ id: string }> };
    const deal = (await (await request(`/api/public/merchants/${merchant.id}/packages`)).json() as Array<{ id: string; priceFen: number; storeIds: string[]; perCustomerLimit: number }>).find((item) => item.storeIds.includes(storefront.stores[0].id) && (!item.perCustomerLimit || item.perCustomerLimit >= 1))!;
    const orderResponse = await request(`/api/public/merchants/${merchant.id}/orders`, {
      method: 'POST', headers: customer, body: JSON.stringify({ packageId: deal.id, storeId: storefront.stores[0].id, quantity: 1 }),
    });
    expect(orderResponse.status).toBe(201);
    const order = await orderResponse.json() as { id: string; orderNo: string; amountFen: number };
    const expiredAt = new Date(Date.now() - 1_000);
    await app.get(DataSource).getRepository(Order).update(order.id, { paymentExpiresAt: expiredAt });
    const provider = app.get<MockPaymentProvider>(PAYMENT_PROVIDER);
    const querySpy = jest.spyOn(provider, 'queryPayment').mockImplementation(async (input) => input.orderId === order.id ? ({
      providerEventId: `reconcile-${order.id.replace(/-/g, '')}`,
      eventType: PaymentEventType.PAYMENT_SUCCEEDED,
      orderNo: order.orderNo,
      merchantId: merchant.id,
      amountFen: order.amountFen,
      providerPaymentReference: `mock_reconcile_${order.id.slice(0, 8)}`,
      occurredAt: new Date(expiredAt.getTime() - 1_000),
    }) : null);
    try {
      expect(await app.get(PaymentProcessingService).expirePendingOrders()).toBe(0);
    } finally {
      querySpy.mockRestore();
    }
    expect((await app.get(DataSource).getRepository(Order).findOneByOrFail({ id: order.id })).status).toBe(OrderStatus.PAID);
    expect(await app.get(DataSource).getRepository(Voucher).countBy({ orderId: order.id })).toBe(1);
  });

  it('requires a signed customer session and prevents one customer from accessing another customers vouchers', async () => {
    const platform = await login('platform@demo.local');
    const merchants = await (await request('/api/merchants', { headers: { Authorization: `Bearer ${platform.token}` } })).json() as Array<{ id: string; brandName: string }>;
    const merchant = merchants.find((item) => item.brandName === '花时间花艺')!;
    const firstCustomer = await customerSession();
    const secondCustomer = await customerSession();
    const storefront = await (await request(`/api/public/merchants/${merchant.id}`)).json() as { stores: Array<{ id: string }> };
    const publicPackage = (await (await request(`/api/public/merchants/${merchant.id}/packages`)).json() as Array<{ id: string }>)[0];
    const order = await (await request(`/api/public/merchants/${merchant.id}/orders`, { method: 'POST', headers: firstCustomer, body: JSON.stringify({ packageId: publicPackage.id, storeId: storefront.stores[0].id, quantity: 1 }) })).json() as { id: string };
    const confirmation = await (await request(`/api/public/orders/${order.id}/mock-confirm`, { method: 'POST', headers: firstCustomer })).json() as { vouchers: Array<{ id: string }> };
    const voucherId = confirmation.vouchers[0].id;

    expect((await request('/api/public/vouchers', { headers: { 'X-Customer-Id': 'forged-customer' } })).status).toBe(401);
    expect((await (await request('/api/public/vouchers', { headers: secondCustomer })).json() as Array<unknown>).length).toBe(0);
    expect((await request(`/api/public/vouchers/${voucherId}/refund`, { method: 'POST', headers: secondCustomer })).status).toBe(404);
    const firstRefund = await request(`/api/public/vouchers/${voucherId}/refund`, { method: 'POST', headers: firstCustomer });
    expect(firstRefund.status).toBe(201);
    const firstRefundResult = await firstRefund.json() as { id: string; voucherId: string; status: string };
    expect(firstRefundResult.status).toBe('SUCCEEDED');
    // #13 顾客自助退款防刷：同一张券在冷却窗口内重复申请退款会被拒绝，避免反复触发渠道
    const retryRefund = await request(`/api/public/vouchers/${voucherId}/refund`, { method: 'POST', headers: firstCustomer });
    expect(retryRefund.status).toBe(400);
    expect((await retryRefund.json() as { message: string }).message).toContain('退款正在处理中');
  });

  it('pauses new sales at a closed store while preserving verification of an existing voucher', async () => {
    const platform = await login('platform@demo.local');
    const merchant = (await (await request('/api/merchants', { headers: { Authorization: `Bearer ${platform.token}` } })).json() as Array<{ id: string; brandName: string }>).find((item) => item.brandName === '花时间花艺')!;
    const merchantAdmin = await login('merchant@demo.local');
    const merchantHeaders = { Authorization: `Bearer ${merchantAdmin.token}`, 'Content-Type': 'application/json' };
    const storefront = await (await request(`/api/public/merchants/${merchant.id}`)).json() as { stores: Array<{ id: string }> };
    const deals = await (await request(`/api/public/merchants/${merchant.id}/packages`)).json() as Array<{ id: string; storeIds: string[] }>;
    const store = storefront.stores[0];
    const deal = deals.find((item) => item.storeIds.includes(store.id))!;
    const firstCustomer = await customerSession();
    const order = await (await request(`/api/public/merchants/${merchant.id}/orders`, {
      method: 'POST', headers: firstCustomer, body: JSON.stringify({ packageId: deal.id, storeId: store.id, quantity: 1 }),
    })).json() as { id: string };
    const payment = await (await request(`/api/public/orders/${order.id}/mock-confirm`, { method: 'POST', headers: firstCustomer })).json() as { vouchers: Array<{ id: string }> };
    const voucherId = payment.vouchers[0].id;
    const internalStore = (await (await request(`/api/merchants/${merchant.id}/stores`, { headers: merchantHeaders })).json() as Array<{ id: string; name: string; address: string; phone: string; businessHours: string }>).find((item) => item.id === store.id)!;
    const storePayload = { id: internalStore.id, name: internalStore.name, address: internalStore.address, phone: internalStore.phone, businessHours: internalStore.businessHours };
    const closeStore = { ...storePayload, openForSale: false };
    expect((await request(`/api/merchants/${merchant.id}/stores`, { method: 'POST', headers: merchantHeaders, body: JSON.stringify(closeStore) })).status).toBe(201);
    const afterClose = await (await request(`/api/public/merchants/${merchant.id}`)).json() as { stores: Array<{ id: string }> };
    expect(afterClose.stores.some((item) => item.id === store.id)).toBe(false);
    const secondCustomer = await customerSession();
    expect((await request(`/api/public/merchants/${merchant.id}/orders`, {
      method: 'POST', headers: secondCustomer, body: JSON.stringify({ packageId: deal.id, storeId: store.id, quantity: 1 }),
    })).status).toBe(400);

    const dynamicCode = await (await request(`/api/public/vouchers/${voucherId}/dynamic-code`, { method: 'POST', headers: firstCustomer })).json() as { token: string };
    const staff = await login('staff@demo.local');
    expect((await request('/api/verification/confirm', {
      method: 'POST', headers: { Authorization: `Bearer ${staff.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: dynamicCode.token, workingStoreId: store.id, idempotencyKey: 'closed-store-existing-voucher' }),
    })).status).toBe(201);
    expect((await request(`/api/merchants/${merchant.id}/stores`, { method: 'POST', headers: merchantHeaders, body: JSON.stringify({ ...storePayload, openForSale: true }) })).status).toBe(201);
  });

  it('lets only the platform transfer an unredeemed voucher to an eligible replacement store', async () => {
    const platform = await login('platform@demo.local');
    const platformHeaders = { Authorization: `Bearer ${platform.token}`, 'Content-Type': 'application/json' };
    const merchant = (await (await request('/api/merchants', { headers: platformHeaders })).json() as Array<{ id: string; brandName: string }>).find((item) => item.brandName === '花时间花艺')!;
    const merchantAdmin = await login('merchant@demo.local');
    const merchantHeaders = { Authorization: `Bearer ${merchantAdmin.token}`, 'Content-Type': 'application/json' };
    const stores = await (await request(`/api/merchants/${merchant.id}/stores`, { headers: merchantHeaders })).json() as Array<{ id: string; name: string; address: string; phone: string; businessHours: string; openForSale: boolean }>;
    const originalStore = stores[0];
    const replacementStore = await (await request(`/api/merchants/${merchant.id}/stores`, {
      method: 'POST', headers: merchantHeaders,
      body: JSON.stringify({ name: '花时间花艺 - 替代履约店', address: '广州市天河区履约路 99 号', phone: '020-8888-6789', businessHours: '10:00-21:00', openForSale: true }),
    })).json() as { id: string };
    const packageRecord = (await (await request(`/api/merchants/${merchant.id}/packages`, { headers: merchantHeaders })).json() as Array<Record<string, unknown>>).find((item) => Array.isArray(item.storeIds) && item.storeIds.includes(originalStore.id))!;
    const packageUpdate = await request(`/api/merchants/${merchant.id}/packages`, {
      method: 'POST', headers: merchantHeaders,
      body: JSON.stringify({
        id: packageRecord.id, expectedVersion: Number(packageRecord.version), title: packageRecord.title, description: packageRecord.description,
        priceFen: packageRecord.priceFen, saleLimit: packageRecord.saleLimit, perCustomerLimit: packageRecord.perCustomerLimit,
        storeIds: [...(packageRecord.storeIds as string[]), replacementStore.id], validFrom: String(packageRecord.validFrom).slice(0, 10), validTo: String(packageRecord.validTo).slice(0, 10), status: packageRecord.status,
      }),
    });
    expect(packageUpdate.status).toBe(201);
    const updatedPackage = await packageUpdate.json() as { version: number };
    const customer = await customerSession();
    const order = await (await request(`/api/public/merchants/${merchant.id}/orders`, {
      method: 'POST', headers: customer, body: JSON.stringify({ packageId: packageRecord.id, storeId: originalStore.id, quantity: 1 }),
    })).json() as { id: string };
    const payment = await (await request(`/api/public/orders/${order.id}/mock-confirm`, { method: 'POST', headers: customer })).json() as { vouchers: Array<{ id: string }> };
    const voucherId = payment.vouchers[0].id;
    expect((await request(`/api/merchants/${merchant.id}/stores`, {
      method: 'POST', headers: merchantHeaders, body: JSON.stringify({ id: originalStore.id, name: originalStore.name, address: originalStore.address, phone: originalStore.phone, businessHours: originalStore.businessHours, openForSale: false }),
    })).status).toBe(201);

    const transferPath = `/api/vouchers/${voucherId}/transfer-store`;
    expect((await request(transferPath, { method: 'POST', headers: merchantHeaders, body: JSON.stringify({ targetStoreId: replacementStore.id }) })).status).toBe(403);
    const transfer = await request(transferPath, { method: 'POST', headers: platformHeaders, body: JSON.stringify({ targetStoreId: replacementStore.id }) });
    expect(transfer.status).toBe(201);
    expect(await transfer.json()).toEqual(expect.objectContaining({ id: voucherId, storeId: replacementStore.id, status: 'UNUSED' }));
    expect((await request(transferPath, { method: 'POST', headers: platformHeaders, body: JSON.stringify({ targetStoreId: originalStore.id }) })).status).toBe(400);

    const dynamicCode = await (await request(`/api/public/vouchers/${voucherId}/dynamic-code`, { method: 'POST', headers: customer })).json() as { token: string };
    const originalStaff = await login('staff@demo.local');
    expect((await request('/api/verification/confirm', {
      method: 'POST', headers: { Authorization: `Bearer ${originalStaff.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ token: dynamicCode.token, workingStoreId: originalStore.id, idempotencyKey: 'replacement-store-old-staff' }),
    })).status).toBe(403);
    const replacementStaff = await (await request(`/api/merchants/${merchant.id}/staff`, {
      method: 'POST', headers: merchantHeaders,
      body: JSON.stringify({ name: '替代店核销员', email: 'replacement-store-staff@demo.local', password: 'Demo123456', storeIds: [replacementStore.id] }),
    })).json() as { id: string };
    expect(replacementStaff.id).toBeDefined();
    const targetStaff = await login('replacement-store-staff@demo.local');
    expect((await request('/api/verification/confirm', {
      method: 'POST', headers: { Authorization: `Bearer ${targetStaff.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ token: dynamicCode.token, workingStoreId: replacementStore.id, idempotencyKey: 'replacement-store-target-staff' }),
    })).status).toBe(201);
    const auditPage = await (await request(`/api/merchants/${merchant.id}/audits`, { headers: platformHeaders })).json() as { items: Array<{ action: string; resourceId: string }> };
    expect(auditPage.items).toEqual(expect.arrayContaining([expect.objectContaining({ action: 'VOUCHER_STORE_TRANSFERRED', resourceId: voucherId })]));
    expect((await request(`/api/merchants/${merchant.id}/stores`, {
      method: 'POST', headers: merchantHeaders, body: JSON.stringify({ id: originalStore.id, name: originalStore.name, address: originalStore.address, phone: originalStore.phone, businessHours: originalStore.businessHours, openForSale: true }),
    })).status).toBe(201);
    expect((await request(`/api/merchants/${merchant.id}/packages`, {
      method: 'POST', headers: merchantHeaders,
      body: JSON.stringify({
        id: packageRecord.id, expectedVersion: updatedPackage.version, title: packageRecord.title, description: packageRecord.description,
        priceFen: packageRecord.priceFen, saleLimit: packageRecord.saleLimit, perCustomerLimit: packageRecord.perCustomerLimit,
        storeIds: packageRecord.storeIds, validFrom: String(packageRecord.validFrom).slice(0, 10), validTo: String(packageRecord.validTo).slice(0, 10), status: packageRecord.status,
      }),
    })).status).toBe(201);
    expect((await request(`/api/merchants/${merchant.id}/stores`, {
      method: 'POST', headers: merchantHeaders,
      body: JSON.stringify({ id: replacementStore.id, name: '花时间花艺 - 替代履约店', address: '广州市天河区履约路 99 号', phone: '020-8888-6789', businessHours: '10:00-21:00', openForSale: false }),
    })).status).toBe(201);
  });

  it('runs idempotent batch voucher transfers with per-item conflict results', async () => {
    const platform = await login('platform@demo.local');
    const platformHeaders = { Authorization: `Bearer ${platform.token}`, 'Content-Type': 'application/json' };
    const merchant = (await (await request('/api/merchants', { headers: platformHeaders })).json() as Array<{ id: string; brandName: string }>).find((item) => item.brandName === '花时间花艺')!;
    const merchantAdmin = await login('merchant@demo.local');
    const merchantHeaders = { Authorization: `Bearer ${merchantAdmin.token}`, 'Content-Type': 'application/json' };
    const suffix = randomUUID().slice(0, 8);
    const storeIds: string[] = [];
    let packageId: string | undefined;
    let orderId: string | undefined;
    const dataSource = app.get(DataSource);
    try {
      for (const label of ['批量转店原店', '批量转店目标一', '批量转店目标二']) {
        const response = await request(`/api/merchants/${merchant.id}/stores`, { method: 'POST', headers: merchantHeaders, body: JSON.stringify({ name: `${label}-${suffix}`, address: '批量转店回归地址', openForSale: true }) });
        expect(response.status).toBe(201);
        storeIds.push((await response.json() as { id: string }).id);
      }
      const packageResponse = await request(`/api/merchants/${merchant.id}/packages`, {
        method: 'POST', headers: merchantHeaders,
        body: JSON.stringify({ title: `批量转店套餐-${suffix}`, description: '验证批量券履约门店转移。', priceFen: 990, saleLimit: 20, perCustomerLimit: 0, storeIds, validFrom: '2026-01-01', validTo: '2027-12-31', status: PackageStatus.ON_SALE }),
      });
      expect(packageResponse.status).toBe(201);
      packageId = (await packageResponse.json() as { id: string }).id;
      const customer = await customerSession();
      const orderResponse = await request(`/api/public/merchants/${merchant.id}/orders`, { method: 'POST', headers: customer, body: JSON.stringify({ packageId, storeId: storeIds[0], quantity: 2 }) });
      expect(orderResponse.status).toBe(201);
      orderId = (await orderResponse.json() as { id: string }).id;
      const payment = await (await request(`/api/public/orders/${orderId}/mock-confirm`, { method: 'POST', headers: customer })).json() as { vouchers: Array<{ id: string; storeId: string }> };
      expect(payment.vouchers).toHaveLength(2);
      const [firstVoucher, secondVoucher] = payment.vouchers;
      const body = JSON.stringify({ note: '门店停业后统一迁移未核销券。', items: [{ voucherId: firstVoucher.id, expectedStoreId: storeIds[0], targetStoreId: storeIds[1] }] });
      const submitted = await request(`/api/merchants/${merchant.id}/vouchers/batch-transfer-store`, { method: 'POST', headers: { ...platformHeaders, 'Idempotency-Key': `voucher-batch-${suffix}` }, body });
      expect(submitted.status).toBe(201);
      const operation = await submitted.json() as { id: string; status: string };
      expect(operation.status).toBe(BatchOperationStatus.PENDING);
      const replay = await request(`/api/merchants/${merchant.id}/vouchers/batch-transfer-store`, { method: 'POST', headers: { ...platformHeaders, 'Idempotency-Key': `voucher-batch-${suffix}` }, body });
      expect(replay.status).toBe(201);
      expect((await replay.json() as { id: string }).id).toBe(operation.id);
      const changedReplay = await request(`/api/merchants/${merchant.id}/vouchers/batch-transfer-store`, { method: 'POST', headers: { ...platformHeaders, 'Idempotency-Key': `voucher-batch-${suffix}` }, body: JSON.stringify({ note: '同一请求键不可改目标门店。', items: [{ voucherId: firstVoucher.id, expectedStoreId: storeIds[0], targetStoreId: storeIds[2] }] }) });
      expect(changedReplay.status).toBe(409);

      await app.get(BatchOperationService).processPending();
      expect(await dataSource.getRepository(BatchOperation).findOneByOrFail({ id: operation.id })).toEqual(expect.objectContaining({ status: BatchOperationStatus.COMPLETED, succeededCount: 1, failedCount: 0 }));
      expect(await dataSource.getRepository(Voucher).findOneByOrFail({ id: firstVoucher.id })).toEqual(expect.objectContaining({ storeId: storeIds[1], status: VoucherStatus.UNUSED }));

      const successfulBody = JSON.stringify({ note: '逐项转移第二张未核销券。', items: [{ voucherId: secondVoucher.id, expectedStoreId: storeIds[0], targetStoreId: storeIds[1] }] });
      const successful = await request(`/api/merchants/${merchant.id}/vouchers/batch-transfer-store`, { method: 'POST', headers: { ...platformHeaders, 'Idempotency-Key': `voucher-batch-success-${suffix}` }, body: successfulBody });
      expect(successful.status).toBe(201);
      const successfulOperation = await successful.json() as { id: string };
      expect(await app.get(BatchOperationService).processPending()).toBeGreaterThanOrEqual(1);
      expect(await dataSource.getRepository(BatchOperation).findOneByOrFail({ id: successfulOperation.id })).toEqual(expect.objectContaining({ status: BatchOperationStatus.COMPLETED, succeededCount: 1, failedCount: 0 }));
      expect(await dataSource.getRepository(Voucher).findOneByOrFail({ id: firstVoucher.id })).toEqual(expect.objectContaining({ storeId: storeIds[1] }));
      expect(await dataSource.getRepository(Voucher).findOneByOrFail({ id: secondVoucher.id })).toEqual(expect.objectContaining({ storeId: storeIds[1] }));

      const stale = await request(`/api/merchants/${merchant.id}/vouchers/batch-transfer-store`, { method: 'POST', headers: { ...platformHeaders, 'Idempotency-Key': `voucher-batch-stale-${suffix}` }, body: JSON.stringify({ note: '陈旧门店必须逐项失败。', items: [{ voucherId: firstVoucher.id, expectedStoreId: storeIds[0], targetStoreId: storeIds[2] }] }) });
      expect(stale.status).toBe(201);
      const staleOperation = await stale.json() as { id: string };
      await app.get(BatchOperationService).processPending();
      expect(await dataSource.getRepository(BatchOperation).findOneByOrFail({ id: staleOperation.id })).toEqual(expect.objectContaining({ status: BatchOperationStatus.FAILED, succeededCount: 0, failedCount: 1 }));
      expect((await request(`/api/merchants/${merchant.id}/vouchers/batch-transfer-store`, { method: 'POST', headers: { ...merchantHeaders, 'Idempotency-Key': `voucher-cross-tenant-${suffix}` }, body: successfulBody })).status).toBe(403);
    } finally {
      if (orderId) {
        await dataSource.getRepository(PaymentOutbox).delete({ orderId });
        await dataSource.getRepository(Voucher).delete({ orderId });
        await dataSource.getRepository(Order).delete(orderId);
      }
      if (packageId) {
        await dataSource.getRepository(PackageStore).delete({ packageId });
        await dataSource.getRepository(DealPackage).delete(packageId);
      }
      for (const storeId of storeIds) await dataSource.getRepository(Store).delete(storeId);
    }
  });

  it('runs idempotent batch compensation refunds for stopped-store vouchers', async () => {
    const platform = await login('platform@demo.local');
    const platformHeaders = { Authorization: `Bearer ${platform.token}`, 'Content-Type': 'application/json' };
    const merchantAdmin = await login('merchant@demo.local');
    const merchantHeaders = { Authorization: `Bearer ${merchantAdmin.token}`, 'Content-Type': 'application/json' };
    const merchant = (await (await request('/api/merchants', { headers: platformHeaders })).json() as Array<{ id: string; brandName: string }>).find((item) => item.brandName === '花时间花艺')!;
    const suffix = randomUUID().slice(0, 8);
    const dataSource = app.get(DataSource);
    let storeId: string | undefined;
    let packageId: string | undefined;
    let orderId: string | undefined;
    const operationIds: string[] = [];
    try {
      const storeResponse = await request(`/api/merchants/${merchant.id}/stores`, {
        method: 'POST', headers: merchantHeaders,
        body: JSON.stringify({ name: `批量退款停业店-${suffix}`, address: '批量退款回归地址', phone: '020-88880000', businessHours: '10:00-20:00', openForSale: true }),
      });
      expect(storeResponse.status).toBe(201);
      const store = await storeResponse.json() as { id: string; name: string; address: string; phone: string; businessHours: string; version: number };
      storeId = store.id;
      const packageResponse = await request(`/api/merchants/${merchant.id}/packages`, {
        method: 'POST', headers: merchantHeaders,
        body: JSON.stringify({ title: `批量补偿退款套餐-${suffix}`, description: '验证门店停业后的批量补偿退款。', priceFen: 1290, saleLimit: 20, perCustomerLimit: 0, storeIds: [store.id], validFrom: '2026-01-01', validTo: '2027-12-31', status: PackageStatus.ON_SALE }),
      });
      expect(packageResponse.status).toBe(201);
      packageId = (await packageResponse.json() as { id: string }).id;
      const customer = await customerSession();
      const orderResponse = await request(`/api/public/merchants/${merchant.id}/orders`, { method: 'POST', headers: customer, body: JSON.stringify({ packageId, storeId: store.id, quantity: 3 }) });
      expect(orderResponse.status).toBe(201);
      orderId = (await orderResponse.json() as { id: string }).id;
      const payment = await (await request(`/api/public/orders/${orderId}/mock-confirm`, { method: 'POST', headers: customer })).json() as { vouchers: Array<{ id: string }> };
      expect(payment.vouchers).toHaveLength(3);
      const batchVouchers = payment.vouchers.slice(0, 2);
      const previouslyRefunded = payment.vouchers[2];
      expect((await request(`/api/public/vouchers/${previouslyRefunded.id}/refund`, { method: 'POST', headers: customer })).status).toBe(201);
      const stopStore = await request(`/api/merchants/${merchant.id}/stores`, {
        method: 'POST', headers: platformHeaders,
        body: JSON.stringify({ id: store.id, expectedVersion: store.version, name: store.name, address: store.address, phone: store.phone, businessHours: store.businessHours, openForSale: false, openForVerification: false, fulfillmentChangeReason: '门店永久停业，批量补偿未核销券。' }),
      });
      expect(stopStore.status).toBe(201);
      const body = JSON.stringify({ note: '门店永久停业，统一执行原路补偿退款。', items: batchVouchers.map((voucher) => ({ voucherId: voucher.id, expectedStoreId: store.id })) });
      const path = `/api/merchants/${merchant.id}/vouchers/batch-compensation-refund`;
      expect((await request(path, { method: 'POST', headers: { ...merchantHeaders, 'Idempotency-Key': `refund-batch-merchant-${suffix}` }, body })).status).toBe(403);
      const submitted = await request(path, { method: 'POST', headers: { ...platformHeaders, 'Idempotency-Key': `refund-batch-${suffix}` }, body });
      expect(submitted.status).toBe(201);
      const operation = await submitted.json() as { id: string; status: BatchOperationStatus };
      operationIds.push(operation.id);
      expect(operation.status).toBe(BatchOperationStatus.PENDING);
      const replay = await request(path, { method: 'POST', headers: { ...platformHeaders, 'Idempotency-Key': `refund-batch-${suffix}` }, body });
      expect(replay.status).toBe(201);
      expect((await replay.json() as { id: string }).id).toBe(operation.id);
      expect((await request(path, { method: 'POST', headers: { ...platformHeaders, 'Idempotency-Key': `refund-batch-${suffix}` }, body: JSON.stringify({ note: '同一请求键不可修改批量退款说明。', items: batchVouchers.map((voucher) => ({ voucherId: voucher.id, expectedStoreId: store.id })) }) })).status).toBe(409);

      expect(await app.get(BatchOperationService).processPending()).toBeGreaterThanOrEqual(1);
      const completed = await dataSource.getRepository(BatchOperation).findOneByOrFail({ id: operation.id });
      expect(completed).toEqual(expect.objectContaining({ status: BatchOperationStatus.COMPLETED, succeededCount: 2, failedCount: 0 }));
      expect(completed.results).toEqual(expect.arrayContaining(batchVouchers.map((voucher) => expect.objectContaining({ voucherId: voucher.id, ok: true, status: 'SUCCEEDED' }))));
      expect(await dataSource.getRepository(Voucher).countBy({ orderId, status: VoucherStatus.REFUNDED })).toBe(3);
      expect(await dataSource.getRepository(Refund).countBy({ orderId, reason: 'STORE_CLOSURE_BATCH_COMPENSATION', status: 'SUCCEEDED' })).toBe(2);
      expect((await dataSource.getRepository(Order).findOneByOrFail({ id: orderId })).status).toBe(OrderStatus.REFUNDED);
      const processingAudits = await dataSource.getRepository(AuditLog).findBy({ action: 'VOUCHER_REFUND_PROCESSING' });
      expect(processingAudits.filter((audit) => batchVouchers.some((voucher) => voucher.id === audit.resourceId))).toHaveLength(2);
      expect(processingAudits.filter((audit) => batchVouchers.some((voucher) => voucher.id === audit.resourceId)).every((audit) => (audit.after as { operationId?: string }).operationId === operation.id)).toBe(true);

      const conflicting = await request(path, { method: 'POST', headers: { ...platformHeaders, 'Idempotency-Key': `refund-batch-conflict-${suffix}` }, body: JSON.stringify({ note: '已由顾客退款的券不能伪装为停业补偿。', items: [{ voucherId: previouslyRefunded.id, expectedStoreId: store.id }] }) });
      expect(conflicting.status).toBe(201);
      const conflictingOperation = await conflicting.json() as { id: string };
      operationIds.push(conflictingOperation.id);
      await app.get(BatchOperationService).processPending();
      expect(await dataSource.getRepository(BatchOperation).findOneByOrFail({ id: conflictingOperation.id })).toEqual(expect.objectContaining({ status: BatchOperationStatus.FAILED, succeededCount: 0, failedCount: 1 }));
      expect((await dataSource.getRepository(Refund).findOneByOrFail({ voucherId: previouslyRefunded.id })).reason).toBe('CUSTOMER_SELF_SERVICE');
    } finally {
      for (const operationId of operationIds) await dataSource.getRepository(BatchOperation).delete(operationId);
      if (orderId) {
        await dataSource.getRepository(Refund).delete({ orderId });
        await dataSource.getRepository(PaymentOutbox).delete({ orderId });
        await dataSource.getRepository(Voucher).delete({ orderId });
        await dataSource.getRepository(Order).delete(orderId);
      }
      if (packageId) {
        await dataSource.getRepository(PackageStore).delete({ packageId });
        await dataSource.getRepository(DealPackage).delete(packageId);
      }
      if (storeId) await dataSource.getRepository(Store).delete(storeId);
    }
  });

  it('distinguishes temporary sales pauses from stopped fulfillment and lets only the platform compensate stopped-store vouchers', async () => {
    const platform = await login('platform@demo.local');
    const merchantAdmin = await login('merchant@demo.local');
    const platformHeaders = { Authorization: `Bearer ${platform.token}`, 'Content-Type': 'application/json' };
    const merchantHeaders = { Authorization: `Bearer ${merchantAdmin.token}`, 'Content-Type': 'application/json' };
    const merchant = (await (await request('/api/merchants', { headers: platformHeaders })).json() as Array<{ id: string; brandName: string }>).find((item) => item.brandName === '花时间花艺')!;
    const storefront = await (await request(`/api/public/merchants/${merchant.id}`)).json() as { stores: Array<{ id: string }> };
    const deal = (await (await request(`/api/public/merchants/${merchant.id}/packages`)).json() as Array<{ id: string; storeIds: string[] }>).find((item) => item.storeIds.includes(storefront.stores[0].id))!;
    const customer = await customerSession();
    const order = await (await request(`/api/public/merchants/${merchant.id}/orders`, {
      method: 'POST', headers: customer, body: JSON.stringify({ packageId: deal.id, storeId: storefront.stores[0].id, quantity: 1 }),
    })).json() as { id: string };
    const payment = await (await request(`/api/public/orders/${order.id}/mock-confirm`, { method: 'POST', headers: customer })).json() as { vouchers: Array<{ id: string }> };
    const voucherId = payment.vouchers[0].id;
    const store = (await (await request(`/api/merchants/${merchant.id}/stores`, { headers: merchantHeaders })).json() as Array<{ id: string; name: string; address: string; phone: string; businessHours: string; version: number; openForVerification: boolean }>).find((item) => item.id === storefront.stores[0].id)!;
    const storePayload = { id: store.id, name: store.name, address: store.address, phone: store.phone, businessHours: store.businessHours };

    expect((await request(`/api/vouchers/${voucherId}/store-closure-refund`, { method: 'POST', headers: platformHeaders, body: '{}' })).status).toBe(400);
    const salesPause = await request(`/api/merchants/${merchant.id}/stores`, {
      method: 'POST', headers: merchantHeaders,
      body: JSON.stringify({ ...storePayload, expectedVersion: store.version, openForSale: false }),
    });
    expect(salesPause.status).toBe(201);
    const pausedStore = await salesPause.json() as { version: number; openForVerification: boolean };
    expect(pausedStore.openForVerification).toBe(true);

    const queueBeforeStop = await (await request('/api/platform/work-queue', { headers: platformHeaders })).json() as { closedStoreVouchers: Array<{ voucherId: string }> };
    expect(queueBeforeStop.closedStoreVouchers.some((item) => item.voucherId === voucherId)).toBe(false);
    expect((await request(`/api/merchants/${merchant.id}/stores`, {
      method: 'POST', headers: merchantHeaders,
      body: JSON.stringify({ ...storePayload, expectedVersion: pausedStore.version, openForSale: false, openForVerification: false, fulfillmentChangeReason: '商家不能单方面停止已购券履约。' }),
    })).status).toBe(403);

    const stopFulfillment = await request(`/api/merchants/${merchant.id}/stores`, {
      method: 'POST', headers: platformHeaders,
      body: JSON.stringify({ ...storePayload, expectedVersion: pausedStore.version, openForSale: false, openForVerification: false, fulfillmentChangeReason: '门店已永久闭店，平台统一安排转店或补偿退款。' }),
    });
    expect(stopFulfillment.status).toBe(201);
    const closedStore = await stopFulfillment.json() as { version: number; openForSale: boolean; openForVerification: boolean };
    expect(closedStore).toEqual(expect.objectContaining({ openForSale: false, openForVerification: false }));

    const queue = await (await request('/api/platform/work-queue', { headers: platformHeaders })).json() as {
      totals: { closedStoreVouchers: number };
      closedStoreVouchers: Array<{ voucherId: string; merchantId: string; storeId: string; storeName: string; code: string; faceValueFen: number }>;
    };
    expect(queue.totals.closedStoreVouchers).toBeGreaterThan(0);
    expect(queue.closedStoreVouchers).toEqual(expect.arrayContaining([expect.objectContaining({ voucherId, merchantId: merchant.id, storeId: store.id, storeName: store.name, faceValueFen: expect.any(Number) })]));

    const dynamicCode = await (await request(`/api/public/vouchers/${voucherId}/dynamic-code`, { method: 'POST', headers: customer })).json() as { token: string };
    const staff = await login('staff@demo.local');
    const staffHeaders = { Authorization: `Bearer ${staff.token}`, 'Content-Type': 'application/json' };
    const preview = await request('/api/verification/preview', { method: 'POST', headers: staffHeaders, body: JSON.stringify({ token: dynamicCode.token, workingStoreId: store.id }) });
    expect(preview.status).toBe(201);
    expect(await preview.json()).toEqual(expect.objectContaining({ fulfillmentAvailable: false, canVerify: false }));
    expect((await request('/api/verification/confirm', { method: 'POST', headers: staffHeaders, body: JSON.stringify({ token: dynamicCode.token, workingStoreId: store.id, idempotencyKey: 'stopped-fulfillment-verification' }) })).status).toBe(400);

    const compensationPath = `/api/vouchers/${voucherId}/store-closure-refund`;
    expect((await request(compensationPath, { method: 'POST', headers: merchantHeaders, body: '{}' })).status).toBe(403);
    expect((await request(compensationPath, { method: 'POST', headers: platformHeaders, body: '{}' })).status).toBe(201);
    expect((await app.get(DataSource).getRepository(Voucher).findOneByOrFail({ id: voucherId })).status).toBe(VoucherStatus.REFUNDED);
    expect((await app.get(DataSource).getRepository(Refund).findOneByOrFail({ voucherId })).reason).toBe('STORE_CLOSURE_COMPENSATION');
    expect((await app.get(DataSource).getRepository(AuditLog).findOneByOrFail({ action: 'VOUCHER_REFUND_PROCESSING', resourceId: voucherId })).after).toEqual(expect.objectContaining({ reason: 'STORE_CLOSURE_COMPENSATION' }));
    const queueAfter = await (await request('/api/platform/work-queue', { headers: platformHeaders })).json() as { closedStoreVouchers: Array<{ voucherId: string }> };
    expect(queueAfter.closedStoreVouchers.some((item) => item.voucherId === voucherId)).toBe(false);

    expect((await request(`/api/merchants/${merchant.id}/stores`, {
      method: 'POST', headers: platformHeaders,
      body: JSON.stringify({ ...storePayload, expectedVersion: closedStore.version, openForSale: true, openForVerification: true, fulfillmentChangeReason: '平台确认门店恢复正常履约。' }),
    })).status).toBe(201);
  });

  it('keeps customer support tickets scoped and closes them with an audit trail', async () => {
    const platform = await login('platform@demo.local');
    const merchant = (await (await request('/api/merchants', { headers: { Authorization: `Bearer ${platform.token}` } })).json() as Array<{ id: string; brandName: string }>).find((item) => item.brandName === '花时间花艺')!;
    const customer = await customerSession();
    const storefront = await (await request(`/api/public/merchants/${merchant.id}`)).json() as { stores: Array<{ id: string }> };
    const deal = (await (await request(`/api/public/merchants/${merchant.id}/packages`)).json() as Array<{ id: string; storeIds: string[] }>).find((item) => item.storeIds.includes(storefront.stores[0].id))!;
    const order = await (await request(`/api/public/merchants/${merchant.id}/orders`, {
      method: 'POST', headers: customer, body: JSON.stringify({ packageId: deal.id, storeId: storefront.stores[0].id, quantity: 1 }),
    })).json() as { id: string };
    const payment = await (await request(`/api/public/orders/${order.id}/mock-confirm`, { method: 'POST', headers: customer })).json() as { vouchers: Array<{ id: string }> };
    const ticketResponse = await request('/api/public/support-tickets', {
      method: 'POST', headers: customer,
      body: JSON.stringify({ merchantId: merchant.id, voucherId: payment.vouchers[0].id, content: '门店临时调整，想确认已购券如何使用。', contactPhone: '13800000000' }),
    });
    expect(ticketResponse.status).toBe(201);
    const ticket = await ticketResponse.json() as { id: string; status: string; firstResponseDueAt: string };
    expect(ticket.status).toBe('OPEN');
    expect(new Date(ticket.firstResponseDueAt).getTime()).toBeGreaterThan(Date.now());
    const notificationRepo = app.get(DataSource).getRepository(NotificationOutbox);
    const ticketCreatedNotification = await notificationRepo.findOneByOrFail({ eventType: 'SUPPORT_TICKET_CREATED', resourceId: ticket.id });
    expect(ticketCreatedNotification).toEqual(expect.objectContaining({ channel: NotificationChannel.EMAIL, status: NotificationOutboxStatus.PENDING }));
    expect(ticketCreatedNotification.recipientCiphertext).toMatch(/^v2\./);
    expect(ticketCreatedNotification.recipientCiphertext).not.toContain('platform@demo.local');
    const storedTicket = await app.get(DataSource).getRepository(SupportTicket).findOneByOrFail({ id: ticket.id });
    expect(storedTicket.contactPhone).toMatch(/^v2\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(storedTicket.contactPhone).not.toContain('13800000000');

    const retryCustomer = await customerSession();
    const retryOrder = await (await request(`/api/public/merchants/${merchant.id}/orders`, {
      method: 'POST', headers: retryCustomer, body: JSON.stringify({ packageId: deal.id, storeId: storefront.stores[0].id, quantity: 1 }),
    })).json() as { id: string };
    const retryPayment = await (await request(`/api/public/orders/${retryOrder.id}/mock-confirm`, { method: 'POST', headers: retryCustomer })).json() as { vouchers: Array<{ id: string }> };
    const retryKey = `support-retry-${Date.now()}-001`;
    const retryPayload = { merchantId: merchant.id, voucherId: retryPayment.vouchers[0].id, content: '网络恢复后重试，确认只生成一张售后工单。', contactPhone: '13900000000', idempotencyKey: retryKey };
    const [firstRetry, secondRetry] = await Promise.all([
      request('/api/public/support-tickets', { method: 'POST', headers: retryCustomer, body: JSON.stringify(retryPayload) }),
      request('/api/public/support-tickets', { method: 'POST', headers: retryCustomer, body: JSON.stringify(retryPayload) }),
    ]);
    expect([firstRetry.status, secondRetry.status]).toEqual([201, 201]);
    const [firstRetryTicket, secondRetryTicket] = await Promise.all([
      firstRetry.json() as Promise<Record<string, unknown>>,
      secondRetry.json() as Promise<Record<string, unknown>>,
    ]);
    expect(firstRetryTicket.id).toBe(secondRetryTicket.id);
    expect(firstRetryTicket).not.toHaveProperty('idempotencyKey');
    expect(firstRetryTicket).not.toHaveProperty('requestHash');
    expect(secondRetryTicket).not.toHaveProperty('idempotencyKey');
    expect(secondRetryTicket).not.toHaveProperty('requestHash');
    const changedRetry = await request('/api/public/support-tickets', {
      method: 'POST', headers: retryCustomer,
      body: JSON.stringify({ ...retryPayload, content: '篡改内容后不能复用同一个售后提交标识。' }),
    });
    expect(changedRetry.status).toBe(409);
    const retryTickets = await app.get(DataSource).getRepository(SupportTicket).createQueryBuilder('ticket')
      .addSelect(['ticket.idempotencyKey', 'ticket.requestHash'])
      .where('ticket.idempotencyKey = :retryKey', { retryKey })
      .getMany();
    expect(retryTickets).toHaveLength(1);
    expect(retryTickets[0]).toEqual(expect.objectContaining({
      id: firstRetryTicket.id,
      idempotencyKey: retryKey,
      requestHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    }));
    expect(await app.get(DataSource).getRepository(AuditLog).countBy({ action: 'SUPPORT_TICKET_CREATED', resourceId: String(firstRetryTicket.id) })).toBe(1);

    const customerTicket = (await (await request('/api/public/support-tickets', { headers: customer })).json() as Array<Record<string, unknown>>).find((item) => item.id === ticket.id)!;
    expect(customerTicket).toEqual(expect.objectContaining({ status: 'OPEN', content: '门店临时调整，想确认已购券如何使用。', firstResponseDueAt: expect.any(String), firstRespondedAt: null, replies: [] }));
    expect(customerTicket).not.toHaveProperty('customerId');
    expect(customerTicket).not.toHaveProperty('contactPhone');
    const retryCustomerTicket = (await (await request('/api/public/support-tickets', { headers: retryCustomer })).json() as Array<Record<string, unknown>>).find((item) => item.id === firstRetryTicket.id)!;
    expect(retryCustomerTicket).not.toHaveProperty('idempotencyKey');
    expect(retryCustomerTicket).not.toHaveProperty('requestHash');
    const anotherCustomer = await customerSession();
    expect((await request('/api/public/support-tickets', {
      method: 'POST', headers: anotherCustomer,
      body: JSON.stringify({ merchantId: merchant.id, voucherId: payment.vouchers[0].id, content: '尝试关联其他顾客的券。' }),
    })).status).toBe(404);
    expect((await (await request('/api/public/support-tickets', { headers: anotherCustomer })).json() as Array<unknown>)).toHaveLength(0);

    const merchantAdmin = await login('merchant@demo.local');
    const merchantTicketPage = await (await request(`/api/support-tickets?merchantId=${merchant.id}&page=1&pageSize=25`, { headers: { Authorization: `Bearer ${merchantAdmin.token}` } })).json() as { items: Array<Record<string, unknown>>; page: number; pageSize: number; total: number };
    expect(merchantTicketPage).toEqual(expect.objectContaining({ page: 1, pageSize: 25, total: expect.any(Number) }));
    const merchantTickets = merchantTicketPage.items;
    const merchantTicket = merchantTickets.find((item) => item.id === ticket.id)!;
    expect(merchantTicket).toEqual(expect.objectContaining({ status: 'OPEN' }));
    expect(merchantTicket).not.toHaveProperty('customerId');
    expect(merchantTicket).not.toHaveProperty('contactPhone');
    const agency = await login('agency@demo.local');
    expect((await (await request(`/api/support-tickets?merchantId=${merchant.id}`, { headers: { Authorization: `Bearer ${agency.token}` } })).json() as { items: Array<{ id: string }> }).items.some((item) => item.id === ticket.id)).toBe(true);
    const staff = await login('staff@demo.local');
    expect((await request(`/api/support-tickets?merchantId=${merchant.id}`, { headers: { Authorization: `Bearer ${staff.token}` } })).status).toBe(403);
    expect((await request(`/api/support-tickets/${ticket.id}/replies`, {
      method: 'POST', headers: { Authorization: `Bearer ${staff.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ content: '核销员无权处理顾客售后。' }),
    })).status).toBe(403);
    const firstReply = await request(`/api/support-tickets/${ticket.id}/replies`, {
      method: 'POST', headers: { Authorization: `Bearer ${merchantAdmin.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ content: '已收到问题，正在与门店确认履约安排。' }),
    });
    expect(firstReply.status).toBe(201);
    const afterFirstReply = (await (await request('/api/public/support-tickets', { headers: customer })).json() as Array<Record<string, unknown>>).find((item) => item.id === ticket.id)!;
    expect(afterFirstReply).toEqual(expect.objectContaining({ status: 'OPEN', firstRespondedAt: expect.any(String), replies: [expect.objectContaining({ content: '已收到问题，正在与门店确认履约安排。', visibility: 'CUSTOMER' })] }));
    const replyNotification = await notificationRepo.findOneByOrFail({ eventType: 'SUPPORT_TICKET_REPLIED', resourceId: ticket.id });
    expect(replyNotification).toEqual(expect.objectContaining({ channel: NotificationChannel.CUSTOMER_INBOX, status: NotificationOutboxStatus.PENDING }));
    const merchantReplies = await (await request(`/api/support-tickets/${ticket.id}/replies`, { headers: { Authorization: `Bearer ${merchantAdmin.token}` } })).json() as Array<Record<string, unknown>>;
    expect(merchantReplies).toHaveLength(1);
    expect(merchantReplies[0]).toEqual(expect.objectContaining({ authorRole: 'MERCHANT_ADMIN', content: '已收到问题，正在与门店确认履约安排。' }));
    const platformTicket = (await (await request(`/api/support-tickets?merchantId=${merchant.id}`, { headers: { Authorization: `Bearer ${platform.token}` } })).json() as { items: Array<Record<string, unknown>> }).items.find((item) => item.id === ticket.id)!;
    expect(platformTicket).toEqual(expect.objectContaining({ contactPhone: '13800000000', replyCount: 1, firstRespondedAt: expect.any(String) }));
    expect((await request(`/api/support-tickets?merchantId=${merchant.id}&pageSize=101`, { headers: { Authorization: `Bearer ${platform.token}` } })).status).toBe(400);

    const exceptionRequestBody = JSON.stringify({ voucherId: payment.vouchers[0].id, content: '顾客到店时门店临时停业，请平台复核异常退款处理。' });
    const [exceptionRequest, duplicateExceptionRequest] = await Promise.all([
      request(`/api/merchants/${merchant.id}/exception-refund-requests`, { method: 'POST', headers: { Authorization: `Bearer ${merchantAdmin.token}`, 'Content-Type': 'application/json' }, body: exceptionRequestBody }),
      request(`/api/merchants/${merchant.id}/exception-refund-requests`, { method: 'POST', headers: { Authorization: `Bearer ${merchantAdmin.token}`, 'Content-Type': 'application/json' }, body: exceptionRequestBody }),
    ]);
    expect([exceptionRequest.status, duplicateExceptionRequest.status].sort()).toEqual([201, 400]);
    const createdExceptionRequest = exceptionRequest.status === 201 ? exceptionRequest : duplicateExceptionRequest;
    const exceptionTicket = await createdExceptionRequest.json() as { id: string; source: string; type: string; status: string; exceptionRefundApprovalStatus: string };
    expect(exceptionTicket).toEqual(expect.objectContaining({ source: 'MERCHANT', type: 'EXCEPTION_REFUND', status: 'OPEN', exceptionRefundApprovalStatus: ExceptionRefundApprovalStatus.PENDING_REVIEW }));
    const users = app.get(DataSource).getRepository(User);
    const breakGlass = await users.createQueryBuilder('user').addSelect('user.passwordHash').where('user.email = :email', { email: 'platform@demo.local' }).getOneOrFail();
    const financeEmail = `support-finance-${Date.now()}-${Math.floor(Math.random() * 100_000)}@demo.local`;
    await users.save({ email: financeEmail, name: '售后异常退款财务', passwordHash: breakGlass.passwordHash, role: UserRole.PLATFORM_ADMIN, platformAccessProfile: PlatformAccessProfile.FINANCE, agencyId: null, merchantId: null, storeIds: null, active: true });
    const finance = await login(financeEmail);
    const financeTickets = await (await request(`/api/support-tickets?merchantId=${merchant.id}`, { headers: { Authorization: `Bearer ${finance.token}` } })).json() as { items: Array<Record<string, unknown>> };
    expect(financeTickets.items).toEqual(expect.arrayContaining([expect.objectContaining({ id: exceptionTicket.id, type: SupportTicketType.EXCEPTION_REFUND })]));
    expect(financeTickets.items.some((item) => item.id === ticket.id)).toBe(false);
    const financeExceptionTicket = financeTickets.items.find((item) => item.id === exceptionTicket.id);
    expect(financeExceptionTicket).toBeDefined();
    expect(financeExceptionTicket).not.toHaveProperty('contactPhone');
    expect((await request(`/api/support-tickets/${ticket.id}/replies`, { headers: { Authorization: `Bearer ${finance.token}` } })).status).toBe(403);
    expect((await request(`/api/support-tickets/${exceptionTicket.id}/replies`, { headers: { Authorization: `Bearer ${finance.token}` } })).status).toBe(200);
    expect((await request(`/api/support-tickets/${ticket.id}/replies`, {
      method: 'POST', headers: { Authorization: `Bearer ${finance.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ content: '财务不应处理普通顾客售后。' }),
    })).status).toBe(403);
    const operationsEmail = `support-operations-${Date.now()}-${Math.floor(Math.random() * 100_000)}@demo.local`;
    await users.save({ email: operationsEmail, name: '售后运营', passwordHash: breakGlass.passwordHash, role: UserRole.PLATFORM_ADMIN, platformAccessProfile: PlatformAccessProfile.OPERATIONS, agencyId: null, merchantId: null, storeIds: null, active: true });
    const operations = await login(operationsEmail);
    const approvedForPrivacy = await request(`/api/support-tickets/${exceptionTicket.id}/approve-exception-refund`, {
      method: 'POST', headers: { Authorization: `Bearer ${finance.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ note: '已独立核对异常退款的履约补偿依据。' }),
    });
    expect(approvedForPrivacy.status).toBe(201);
    const operationTickets = await (await request(`/api/support-tickets?merchantId=${merchant.id}`, { headers: { Authorization: `Bearer ${operations.token}` } })).json() as { items: Array<Record<string, unknown>> };
    const operationExceptionTicket = operationTickets.items.find((item) => item.id === exceptionTicket.id);
    expect(operationExceptionTicket).toBeDefined();
    expect(operationExceptionTicket).toEqual(expect.objectContaining({ exceptionRefundApprovalStatus: ExceptionRefundApprovalStatus.APPROVED }));
    expect(operationExceptionTicket).not.toHaveProperty('exceptionRefundApprovedBy');
    expect(operationExceptionTicket).not.toHaveProperty('exceptionRefundApprovalNote');
    expect((await request(`/api/merchants/${merchant.id}/exception-refund-requests`, {
      method: 'POST', headers: { Authorization: `Bearer ${merchantAdmin.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ voucherId: payment.vouchers[0].id, content: '再次提交同一张券的异常退款申请。' }),
    })).status).toBe(400);
    expect((await request(`/api/merchants/${merchant.id}/exception-refund-requests`, {
      method: 'POST', headers: { Authorization: `Bearer ${agency.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ voucherId: payment.vouchers[0].id, content: '代理商不应代表商家提交申请。' }),
    })).status).toBe(403);
    const exceptionView = (await (await request(`/api/support-tickets?merchantId=${merchant.id}`, { headers: { Authorization: `Bearer ${merchantAdmin.token}` } })).json() as { items: Array<Record<string, unknown>> }).items.find((item) => item.id === exceptionTicket.id)!;
    expect(exceptionView).toEqual(expect.objectContaining({ source: 'MERCHANT', type: 'EXCEPTION_REFUND', exceptionRefundApprovalStatus: ExceptionRefundApprovalStatus.APPROVED }));
    expect(exceptionView).not.toHaveProperty('submittedBy');
    expect(exceptionView).not.toHaveProperty('exceptionRefundApprovedBy');
    expect(exceptionView).not.toHaveProperty('exceptionRefundApprovalNote');
    expect((await request(`/api/support-tickets/${exceptionTicket.id}/resolve`, {
      method: 'POST', headers: { Authorization: `Bearer ${merchantAdmin.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ note: '商家不能自行结案。' }),
    })).status).toBe(403);
    const exceptionResolved = await request(`/api/support-tickets/${exceptionTicket.id}/resolve`, {
      method: 'POST', headers: { Authorization: `Bearer ${platform.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ note: '已转人工复核，并按平台补偿流程跟进。' }),
    });
    expect(exceptionResolved.status).toBe(403);

    const resolved = await request(`/api/support-tickets/${ticket.id}/resolve`, {
      method: 'POST', headers: { Authorization: `Bearer ${merchantAdmin.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ note: '已与顾客确认到店核销安排。' }),
    });
    expect(resolved.status).toBe(201);
    expect(await resolved.json()).toEqual(expect.objectContaining({ status: 'RESOLVED', resolutionNote: '已与顾客确认到店核销安排。' }));
    const resolvedNotification = await notificationRepo.findOneByOrFail({ eventType: 'SUPPORT_TICKET_RESOLVED', resourceId: ticket.id });
    expect(resolvedNotification).toEqual(expect.objectContaining({ channel: NotificationChannel.CUSTOMER_INBOX, status: NotificationOutboxStatus.PENDING }));
    expect((await (await request('/api/public/support-tickets', { headers: customer })).json() as Array<Record<string, unknown>>).find((item) => item.id === ticket.id)).toEqual(expect.objectContaining({ status: 'RESOLVED', resolutionNote: '已与顾客确认到店核销安排。', replies: expect.arrayContaining([expect.objectContaining({ content: '已与顾客确认到店核销安排。' })]) }));
    const audits = (await (await request(`/api/merchants/${merchant.id}/audits`, { headers: { Authorization: `Bearer ${merchantAdmin.token}` } })).json() as { items: Array<{ action: string; resourceId: string; actorId: string; actorRole: string; before?: unknown; after?: unknown; ipAddress?: string; userAgent?: string }> }).items;
    expect(audits).toEqual(expect.arrayContaining([expect.objectContaining({ action: 'SUPPORT_TICKET_RESOLVED', resourceId: ticket.id })]));
    const customerAudit = audits.find((item) => item.action === 'SUPPORT_TICKET_CREATED')!;
    expect(customerAudit).toEqual(expect.objectContaining({ actorId: 'customer', actorRole: 'CUSTOMER' }));
    expect(customerAudit).not.toHaveProperty('before');
    expect(customerAudit).not.toHaveProperty('after');
    expect(customerAudit).not.toHaveProperty('ipAddress');
    expect(customerAudit).not.toHaveProperty('userAgent');
    expect(audits).toEqual(expect.arrayContaining([expect.objectContaining({ action: 'EXCEPTION_REFUND_REQUESTED', resourceId: exceptionTicket.id })]));
  });

  it('keeps failed refunds non-verifiable and lets the platform execute approved exception refunds', async () => {
    const platform = await login('platform@demo.local');
    const merchantAdmin = await login('merchant@demo.local');
    const agency = await login('agency@demo.local');
    const users = app.get(DataSource).getRepository(User);
    const notificationRepo = app.get(DataSource).getRepository(NotificationOutbox);
    const breakGlass = await users.createQueryBuilder('user').addSelect('user.passwordHash').where('user.email = :email', { email: 'platform@demo.local' }).getOneOrFail();
    const reviewerEmail = `exception-refund-reviewer-${Date.now()}-${Math.floor(Math.random() * 100_000)}@demo.local`;
    await users.save({ email: reviewerEmail, name: '异常退款复核财务', passwordHash: breakGlass.passwordHash, role: UserRole.PLATFORM_ADMIN, platformAccessProfile: PlatformAccessProfile.FINANCE, agencyId: null, merchantId: null, storeIds: null, active: true });
    const reviewer = await login(reviewerEmail);
    const merchant = (await (await request('/api/merchants', { headers: { Authorization: `Bearer ${platform.token}` } })).json() as Array<{ id: string; brandName: string }>).find((item) => item.brandName === '花时间花艺')!;
    const store = (await (await request(`/api/public/merchants/${merchant.id}`)).json() as { stores: Array<{ id: string }> }).stores[0];
    const deal = (await (await request(`/api/public/merchants/${merchant.id}/packages`)).json() as Array<{ id: string; storeIds: string[] }>).find((item) => item.storeIds.includes(store.id))!;
    const platformHeaders = { Authorization: `Bearer ${platform.token}`, 'Content-Type': 'application/json' };
    const merchantHeaders = { Authorization: `Bearer ${merchantAdmin.token}`, 'Content-Type': 'application/json' };
    const reviewerHeaders = { Authorization: `Bearer ${reviewer.token}`, 'Content-Type': 'application/json' };

    const firstCustomer = await customerSession();
    const firstOrder = await (await request(`/api/public/merchants/${merchant.id}/orders`, {
      method: 'POST', headers: firstCustomer, body: JSON.stringify({ packageId: deal.id, storeId: store.id, quantity: 1 }),
    })).json() as { id: string };
    const firstPayment = await (await request(`/api/public/orders/${firstOrder.id}/mock-confirm`, { method: 'POST', headers: firstCustomer })).json() as { vouchers: Array<{ id: string }> };
    const firstVoucherId = firstPayment.vouchers[0].id;
    const firstVoucher = await app.get(DataSource).getRepository(Voucher).findOneByOrFail({ id: firstVoucherId });
    const reportBefore = await (await request(`/api/reports/summary?merchantId=${merchant.id}`, { headers: platformHeaders })).json() as { refundedAmountFen: number };
    app.get<MockPaymentProvider>(PAYMENT_PROVIDER).failNextRefund();
    expect((await request(`/api/public/vouchers/${firstVoucherId}/refund`, { method: 'POST', headers: firstCustomer })).status).toBe(503);
    // 退款失败后券回滚 UNUSED（不冻结在 REFUND_PENDING，顾客仍可核销或随后重试退款）
    expect(await app.get(DataSource).getRepository(Voucher).findOneByOrFail({ id: firstVoucherId })).toEqual(expect.objectContaining({ status: VoucherStatus.UNUSED }));
    const failedRefund = await app.get(DataSource).getRepository(Refund).findOneByOrFail({ voucherId: firstVoucherId });
    expect(failedRefund).toEqual(expect.objectContaining({ status: 'FAILED', amountFen: firstVoucher.faceValueFen, lastAttemptAt: expect.any(Date), attemptCount: 1 }));
    const failedRefundNotification = await notificationRepo.findOneByOrFail({ eventType: 'REFUND_FAILED', resourceId: failedRefund.id });
    expect(failedRefundNotification).toEqual(expect.objectContaining({ channel: NotificationChannel.CUSTOMER_INBOX, status: NotificationOutboxStatus.PENDING }));
    const customerRefundView = (await (await request('/api/public/vouchers', { headers: firstCustomer })).json() as Array<{ id: string; status: VoucherStatus; refundStatus: string | null }>).find((voucher) => voucher.id === firstVoucherId);
    expect(customerRefundView).toEqual(expect.objectContaining({ status: VoucherStatus.UNUSED, refundStatus: 'FAILED' }));
    const platformRefundView = (await (await request(`/api/vouchers?merchantId=${merchant.id}`, { headers: platformHeaders })).json() as { items: Array<{ id: string; status: VoucherStatus; refundStatus: string | null }> }).items.find((voucher) => voucher.id === firstVoucherId);
    expect(platformRefundView).toEqual(expect.objectContaining({ status: VoucherStatus.UNUSED, refundStatus: 'FAILED' }));
    expect((await (await request(`/api/reports/summary?merchantId=${merchant.id}`, { headers: platformHeaders })).json() as { refundedAmountFen: number }).refundedAmountFen).toBe(reportBefore.refundedAmountFen);
    // #13 顾客自助退款冷却：同券 30s 内重复发起一律拒绝。把上一次失败记录的创建时间推到冷却窗口外，
    // 等价于"顾客稍后重试"，从而验证失败退款经冷却后仍可自助重试成功。
    await app.get(DataSource).getRepository(Refund).update({ id: failedRefund.id }, { createdAt: new Date(Date.now() - 60_000) });
    const retriedRefund = await request(`/api/public/vouchers/${firstVoucherId}/refund`, { method: 'POST', headers: firstCustomer });
    expect(retriedRefund.status).toBe(201);
    expect(await retriedRefund.json()).toEqual(expect.objectContaining({ id: failedRefund.id, status: 'SUCCEEDED' }));
    const succeededRefundNotification = await notificationRepo.findOneByOrFail({ eventType: 'REFUND_SUCCEEDED', resourceId: failedRefund.id });
    expect(succeededRefundNotification).toEqual(expect.objectContaining({ channel: NotificationChannel.CUSTOMER_INBOX, status: NotificationOutboxStatus.PENDING }));
    expect(await app.get(DataSource).getRepository(Refund).findOneByOrFail({ id: failedRefund.id })).toEqual(expect.objectContaining({ attemptCount: 2, lastAttemptAt: expect.any(Date) }));
    expect((await (await request(`/api/reports/summary?merchantId=${merchant.id}`, { headers: platformHeaders })).json() as { refundedAmountFen: number }).refundedAmountFen).toBe(reportBefore.refundedAmountFen + firstVoucher.faceValueFen);

    const retryCustomer = await customerSession();
    const retryOrder = await (await request(`/api/public/merchants/${merchant.id}/orders`, {
      method: 'POST', headers: retryCustomer, body: JSON.stringify({ packageId: deal.id, storeId: store.id, quantity: 1 }),
    })).json() as { id: string };
    const retryPayment = await (await request(`/api/public/orders/${retryOrder.id}/mock-confirm`, { method: 'POST', headers: retryCustomer })).json() as { vouchers: Array<{ id: string }> };
    const retryVoucherId = retryPayment.vouchers[0].id;
    app.get<MockPaymentProvider>(PAYMENT_PROVIDER).failNextRefund();
    expect((await request(`/api/public/vouchers/${retryVoucherId}/refund`, { method: 'POST', headers: retryCustomer })).status).toBe(503);
    expect((await request(`/api/vouchers/${retryVoucherId}/retry-refund`, { method: 'POST', headers: { Authorization: `Bearer ${agency.token}` } })).status).toBe(403);
    const platformRetry = await request(`/api/vouchers/${retryVoucherId}/retry-refund`, { method: 'POST', headers: platformHeaders });
    expect(platformRetry.status).toBe(201);
    expect(await platformRetry.json()).toEqual(expect.objectContaining({ voucherId: retryVoucherId, reason: 'CUSTOMER_SELF_SERVICE', status: 'SUCCEEDED' }));
    expect((await request(`/api/vouchers/${retryVoucherId}/retry-refund`, { method: 'POST', headers: platformHeaders })).status).toBe(400);

    const secondCustomer = await customerSession();
    const secondOrder = await (await request(`/api/public/merchants/${merchant.id}/orders`, {
      method: 'POST', headers: secondCustomer, body: JSON.stringify({ packageId: deal.id, storeId: store.id, quantity: 1 }),
    })).json() as { id: string };
    const secondPayment = await (await request(`/api/public/orders/${secondOrder.id}/mock-confirm`, { method: 'POST', headers: secondCustomer })).json() as { vouchers: Array<{ id: string }> };
    const exceptionVoucherId = secondPayment.vouchers[0].id;
    const exceptionRequest = await request(`/api/merchants/${merchant.id}/exception-refund-requests`, {
      method: 'POST', headers: merchantHeaders, body: JSON.stringify({ voucherId: exceptionVoucherId, content: '门店临时停业，申请按平台补偿规则退款。' }),
    });
    expect(exceptionRequest.status).toBe(201);
    const exceptionTicket = await exceptionRequest.json() as { id: string; exceptionRefundApprovalStatus: string };
    expect(exceptionTicket.exceptionRefundApprovalStatus).toBe(ExceptionRefundApprovalStatus.PENDING_REVIEW);
    expect((await request(`/api/support-tickets/${exceptionTicket.id}/execute-exception-refund`, {
      method: 'POST', headers: { Authorization: `Bearer ${agency.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ note: '代理商无权执行退款。' }),
    })).status).toBe(403);
    expect((await request(`/api/support-tickets/${exceptionTicket.id}/execute-exception-refund`, {
      method: 'POST', headers: platformHeaders, body: JSON.stringify({ note: '未经审批不得执行退款。' }),
    })).status).toBe(400);
    const approval = await request(`/api/support-tickets/${exceptionTicket.id}/approve-exception-refund`, {
      method: 'POST', headers: reviewerHeaders, body: JSON.stringify({ note: '已独立核对门店停业记录、券状态和补偿依据，批准退款。' }),
    });
    expect(approval.status).toBe(201);
    expect(await approval.json()).toEqual(expect.objectContaining({
      status: 'OPEN', exceptionRefundApprovalStatus: ExceptionRefundApprovalStatus.APPROVED, exceptionRefundApprovedBy: reviewer.user.id,
    }));
    const merchantExceptionView = (await (await request(`/api/support-tickets?merchantId=${merchant.id}`, { headers: { Authorization: `Bearer ${merchantAdmin.token}` } })).json() as { items: Array<Record<string, unknown>> }).items.find((item) => item.id === exceptionTicket.id)!;
    expect(merchantExceptionView).toEqual(expect.objectContaining({ exceptionRefundApprovalStatus: ExceptionRefundApprovalStatus.APPROVED }));
    expect(merchantExceptionView).not.toHaveProperty('exceptionRefundApprovedBy');
    expect(merchantExceptionView).not.toHaveProperty('exceptionRefundApprovalNote');
    expect((await request(`/api/support-tickets/${exceptionTicket.id}/execute-exception-refund`, {
      method: 'POST', headers: reviewerHeaders, body: JSON.stringify({ note: '审批人与执行人不得为同一账号。' }),
    })).status).toBe(403);
    const execution = await request(`/api/support-tickets/${exceptionTicket.id}/execute-exception-refund`, {
      method: 'POST', headers: platformHeaders, body: JSON.stringify({ note: '已执行退款并确认支付适配器返回成功。' }),
    });
    expect(execution.status).toBe(201);
    expect(await execution.json()).toEqual(expect.objectContaining({ ticket: expect.objectContaining({ status: 'RESOLVED', resolutionNote: '平台已完成本次异常退款处理。' }), refund: expect.objectContaining({ voucherId: exceptionVoucherId, reason: 'PLATFORM_EXCEPTION_REFUND', status: 'SUCCEEDED' }) }));
    expect(await app.get(DataSource).getRepository(Voucher).findOneByOrFail({ id: exceptionVoucherId })).toEqual(expect.objectContaining({ status: VoucherStatus.REFUNDED }));
    const audits = await app.get(DataSource).getRepository(AuditLog).find({ where: { resourceId: exceptionTicket.id } });
    expect(audits).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: 'EXCEPTION_REFUND_APPROVED', actorId: reviewer.user.id }),
      expect.objectContaining({ action: 'EXCEPTION_REFUND_EXECUTED', actorId: platform.user.id }),
    ]));
    expect((await request(`/api/support-tickets/${exceptionTicket.id}/execute-exception-refund`, {
      method: 'POST', headers: platformHeaders, body: JSON.stringify({ note: '重复执行应被拒绝。' }),
    })).status).toBe(400);

    const failedExceptionCustomer = await customerSession();
    const failedExceptionOrder = await (await request(`/api/public/merchants/${merchant.id}/orders`, {
      method: 'POST', headers: failedExceptionCustomer, body: JSON.stringify({ packageId: deal.id, storeId: store.id, quantity: 1 }),
    })).json() as { id: string };
    const failedExceptionPayment = await (await request(`/api/public/orders/${failedExceptionOrder.id}/mock-confirm`, { method: 'POST', headers: failedExceptionCustomer })).json() as { vouchers: Array<{ id: string }> };
    const failedExceptionVoucherId = failedExceptionPayment.vouchers[0].id;
    const failedExceptionRequest = await request(`/api/merchants/${merchant.id}/exception-refund-requests`, {
      method: 'POST', headers: merchantHeaders, body: JSON.stringify({ voucherId: failedExceptionVoucherId, content: '支付确认异常，申请按已批准的补偿规则退款。' }),
    });
    expect(failedExceptionRequest.status).toBe(201);
    const failedExceptionTicket = await failedExceptionRequest.json() as { id: string };
    expect((await request(`/api/support-tickets/${failedExceptionTicket.id}/approve-exception-refund`, {
      method: 'POST', headers: reviewerHeaders, body: JSON.stringify({ note: '已复核补偿依据，批准退款支付。' }),
    })).status).toBe(201);
    app.get<MockPaymentProvider>(PAYMENT_PROVIDER).failNextRefund();
    expect((await request(`/api/support-tickets/${failedExceptionTicket.id}/execute-exception-refund`, {
      method: 'POST', headers: platformHeaders, body: JSON.stringify({ note: '首次退款支付确认。' }),
    })).status).toBe(503);
    expect(await app.get(DataSource).getRepository(Refund).findOneByOrFail({ voucherId: failedExceptionVoucherId })).toEqual(expect.objectContaining({ reason: 'PLATFORM_EXCEPTION_REFUND', status: 'FAILED' }));
    expect((await request(`/api/vouchers/${failedExceptionVoucherId}/retry-refund`, {
      method: 'POST', headers: reviewerHeaders, body: '{}',
    })).status).toBe(403);
    const retriedExceptionRefund = await request(`/api/vouchers/${failedExceptionVoucherId}/retry-refund`, {
      method: 'POST', headers: platformHeaders, body: '{}',
    });
    expect(retriedExceptionRefund.status).toBe(201);
    expect(await retriedExceptionRefund.json()).toEqual(expect.objectContaining({ voucherId: failedExceptionVoucherId, reason: 'PLATFORM_EXCEPTION_REFUND', status: 'SUCCEEDED' }));
    const completedRetryTicket = (await (await request(`/api/support-tickets?merchantId=${merchant.id}`, { headers: platformHeaders })).json() as { items: Array<Record<string, unknown>> }).items.find((item) => item.id === failedExceptionTicket.id)!;
    expect(completedRetryTicket).toEqual(expect.objectContaining({ status: 'RESOLVED', exceptionRefundApprovalStatus: ExceptionRefundApprovalStatus.APPROVED }));

    const rejectedExceptionCustomer = await customerSession();
    const rejectedExceptionOrder = await (await request(`/api/public/merchants/${merchant.id}/orders`, {
      method: 'POST', headers: rejectedExceptionCustomer, body: JSON.stringify({ packageId: deal.id, storeId: store.id, quantity: 1 }),
    })).json() as { id: string };
    const rejectedExceptionPayment = await (await request(`/api/public/orders/${rejectedExceptionOrder.id}/mock-confirm`, { method: 'POST', headers: rejectedExceptionCustomer })).json() as { vouchers: Array<{ id: string }> };
    const rejectedExceptionVoucherId = rejectedExceptionPayment.vouchers[0].id;
    const rejectedExceptionRequest = await request(`/api/merchants/${merchant.id}/exception-refund-requests`, {
      method: 'POST', headers: merchantHeaders, body: JSON.stringify({ voucherId: rejectedExceptionVoucherId, content: '材料待补充的异常退款申请。' }),
    });
    const rejectedExceptionTicket = await rejectedExceptionRequest.json() as { id: string };
    const rejected = await request(`/api/support-tickets/${rejectedExceptionTicket.id}/reject-exception-refund`, {
      method: 'POST', headers: platformHeaders, body: JSON.stringify({ note: '未提供足以证明无法履约的材料，请补充后重新申请。' }),
    });
    expect(rejected.status).toBe(201);
    expect(await rejected.json()).toEqual(expect.objectContaining({ status: 'RESOLVED', exceptionRefundApprovalStatus: ExceptionRefundApprovalStatus.REJECTED, resolutionNote: '平台已驳回本次异常退款申请。' }));
    expect(await app.get(DataSource).getRepository(Voucher).findOneByOrFail({ id: rejectedExceptionVoucherId })).toEqual(expect.objectContaining({ status: VoucherStatus.UNUSED }));
  });

  it('reconciles stale refund attempts without replaying fresh payment requests', async () => {
    const platform = await login('platform@demo.local');
    const merchant = (await (await request('/api/merchants', { headers: { Authorization: `Bearer ${platform.token}` } })).json() as Array<{ id: string; brandName: string }>).find((item) => item.brandName === '花时间花艺')!;
    const store = (await (await request(`/api/public/merchants/${merchant.id}`)).json() as { stores: Array<{ id: string }> }).stores[0];
    const deal = (await (await request(`/api/public/merchants/${merchant.id}/packages`)).json() as Array<{ id: string; storeIds: string[] }>).find((item) => item.storeIds.includes(store.id))!;
    const staleCustomer = await customerSession();
    const staleOrder = await (await request(`/api/public/merchants/${merchant.id}/orders`, {
      method: 'POST', headers: staleCustomer, body: JSON.stringify({ packageId: deal.id, storeId: store.id, quantity: 1 }),
    })).json() as { id: string };
    const stalePayment = await (await request(`/api/public/orders/${staleOrder.id}/mock-confirm`, { method: 'POST', headers: staleCustomer })).json() as { vouchers: Array<{ id: string }> };
    const staleVoucher = await app.get(DataSource).getRepository(Voucher).findOneByOrFail({ id: stalePayment.vouchers[0].id });
    staleVoucher.status = VoucherStatus.REFUND_PENDING;
    await app.get(DataSource).getRepository(Voucher).save(staleVoucher);
    const staleRefund = await app.get(DataSource).getRepository(Refund).save({
      voucherId: staleVoucher.id, orderId: staleVoucher.orderId, merchantId: staleVoucher.merchantId, amountFen: staleVoucher.faceValueFen,
      reason: 'CUSTOMER_SELF_SERVICE', status: 'PROCESSING', paymentReference: null, lastAttemptAt: new Date(Date.now() - 6 * 60_000), attemptCount: 1,
    });

    const freshCustomer = await customerSession();
    const freshOrder = await (await request(`/api/public/merchants/${merchant.id}/orders`, {
      method: 'POST', headers: freshCustomer, body: JSON.stringify({ packageId: deal.id, storeId: store.id, quantity: 1 }),
    })).json() as { id: string };
    const freshPayment = await (await request(`/api/public/orders/${freshOrder.id}/mock-confirm`, { method: 'POST', headers: freshCustomer })).json() as { vouchers: Array<{ id: string }> };
    const freshVoucher = await app.get(DataSource).getRepository(Voucher).findOneByOrFail({ id: freshPayment.vouchers[0].id });
    freshVoucher.status = VoucherStatus.REFUND_PENDING;
    await app.get(DataSource).getRepository(Voucher).save(freshVoucher);
    const freshRefund = await app.get(DataSource).getRepository(Refund).save({
      voucherId: freshVoucher.id, orderId: freshVoucher.orderId, merchantId: freshVoucher.merchantId, amountFen: freshVoucher.faceValueFen,
      reason: 'CUSTOMER_SELF_SERVICE', status: 'PROCESSING', paymentReference: null, lastAttemptAt: new Date(), attemptCount: 1,
    });

    // 新状态机对超时 PROCESSING 退款「查单先行」：渠道明确成功才落终态，禁止未经查单就重新提交
    const provider = app.get<MockPaymentProvider>(PAYMENT_PROVIDER);
    const refundQuerySpy = jest.spyOn(provider, 'queryRefund').mockResolvedValue({ status: 'SUCCEEDED', providerPaymentReference: 'mock-refund-query-stale' });
    const sweep = await app.get(LifecycleOrchestrationService).runSweep();
    refundQuerySpy.mockRestore();
    expect(sweep).toEqual(expect.objectContaining({ recoveredRefunds: expect.any(Number), failedRefundRecoveries: 0 }));
    expect(sweep.recoveredRefunds).toBeGreaterThanOrEqual(1);
    // 查单确认成功 → 直接收敛终态，attemptCount 保持 1（未重新提交渠道请求）
    expect(await app.get(DataSource).getRepository(Refund).findOneByOrFail({ id: staleRefund.id })).toEqual(expect.objectContaining({ status: 'SUCCEEDED', attemptCount: 1, paymentReference: 'mock-refund-query-stale' }));
    expect(await app.get(DataSource).getRepository(Voucher).findOneByOrFail({ id: staleVoucher.id })).toEqual(expect.objectContaining({ status: VoucherStatus.REFUNDED }));
    expect(await app.get(DataSource).getRepository(Refund).findOneByOrFail({ id: freshRefund.id })).toEqual(expect.objectContaining({ status: 'PROCESSING', attemptCount: 1 }));
    expect(await app.get(DataSource).getRepository(Voucher).findOneByOrFail({ id: freshVoucher.id })).toEqual(expect.objectContaining({ status: VoucherStatus.REFUND_PENDING }));
    // 查单收敛路径写 REFUND_SUCCEEDED 审计（不再经过重提分支）
    const recoveryAudits = await app.get(DataSource).getRepository(AuditLog).find({ where: { resourceId: staleRefund.id } });
    expect(recoveryAudits).toEqual(expect.arrayContaining([expect.objectContaining({ action: 'REFUND_SUCCEEDED', actorId: 'system' })]));
  });

  it('exposes merchant onboarding progress read-only and role-scoped while manual advancing is retired', async () => {
    const platform = await login('platform@demo.local');
    const agency = await login('agency@demo.local');
    const merchantAdmin = await login('merchant@demo.local');
    const staff = await login('staff@demo.local');
    const merchant = (await (await request('/api/merchants', { headers: { Authorization: `Bearer ${platform.token}` } })).json() as Array<{ id: string; brandName: string }>).find((item) => item.brandName === '花时间花艺')!;
    const path = `/api/merchants/${merchant.id}/registration`;
    const agencyHeaders = { Authorization: `Bearer ${agency.token}`, 'Content-Type': 'application/json' };
    const merchantHeaders = { Authorization: `Bearer ${merchantAdmin.token}`, 'Content-Type': 'application/json' };
    const platformHeaders = { Authorization: `Bearer ${platform.token}`, 'Content-Type': 'application/json' };

    // 读取仍可用且按角色收敛：平台/代理可读，核销员不可读
    const initial = await request(path, { headers: agencyHeaders });
    expect(initial.status).toBe(200);
    expect(await initial.json()).toEqual(expect.objectContaining({ merchantId: merchant.id, status: 'PENDING_MATERIALS' }));
    expect((await request(path, { headers: platformHeaders })).status).toBe(200);
    expect((await request(path, { headers: { Authorization: `Bearer ${staff.token}` } })).status).toBe(403);

    // 人工推进已下线（开户进度由微信真实状态同步）：具备该路由权限的角色一律 410；
    // 商家管理员不在该路由的允许角色内，由角色守卫先行拦下（403）
    expect((await request(path, { method: 'POST', headers: agencyHeaders, body: JSON.stringify({ status: 'SUBMITTED', note: '代理商不应能人工推进开户。' }) })).status).toBe(410);
    expect((await request(path, { method: 'POST', headers: platformHeaders, body: JSON.stringify({ status: 'PUBLISHABLE', note: '平台不应能人工推进开户。' }) })).status).toBe(410);
    expect((await request(path, { method: 'POST', headers: merchantHeaders, body: JSON.stringify({ status: 'PENDING_CONFIRMATION' }) })).status).toBe(403);

    // 被拒的人工推进不得改变开户进度
    const registration = await (await request(path, { headers: platformHeaders })).json() as { status: string };
    expect(registration.status).toBe('PENDING_MATERIALS');
  });

  it('keeps the legal subject freely editable at any onboarding stage while operational details stay operable', async () => {
    const platform = await login('platform@demo.local');
    const platformHeaders = { Authorization: `Bearer ${platform.token}`, 'Content-Type': 'application/json' };
    const agency = (await (await request('/api/agencies', { headers: platformHeaders })).json() as Array<{ id: string; name: string }>).find((item) => item.name === '华南精选生活代理')!;
    const suffix = Date.now().toString(36);
    const created = await request('/api/merchants', {
      method: 'POST', headers: platformHeaders,
      body: JSON.stringify({ agencyId: agency.id, legalName: `主体修改测试-${suffix}`, brandName: `资料维护测试-${suffix}`, servicePhone: '020-6666-0001' }),
    });
    expect(created.status).toBe(201);
    const merchant = await created.json() as { id: string };
    expect((await request(`/api/merchants/${merchant.id}`, {
      method: 'PATCH', headers: platformHeaders, body: JSON.stringify({ legalName: `主体预提交修正-${suffix}` }),
    })).status).toBe(200);
    const registrationPath = `/api/merchants/${merchant.id}/registration`;
    // 人工推进开户已下线（进度由微信真实状态同步）
    expect((await request(registrationPath, {
      method: 'POST', headers: platformHeaders, body: JSON.stringify({ status: 'SUBMITTED', note: '主体资料已提交审核。' }),
    })).status).toBe(410);
    // 主体资料锁定已按业务要求放开：任何开户阶段都允许直接修改 legalName
    expect((await request(`/api/merchants/${merchant.id}`, {
      method: 'PATCH', headers: platformHeaders, body: JSON.stringify({ legalName: `再次修正的主体-${suffix}` }),
    })).status).toBe(200);
    const operationalUpdate = await request(`/api/merchants/${merchant.id}`, {
      method: 'PATCH', headers: platformHeaders, body: JSON.stringify({ brandName: `更新后品牌-${suffix}`, servicePhone: '020-6666-0002', primaryColor: '#1d6f62' }),
    });
    expect(operationalUpdate.status).toBe(200);
    expect(await operationalUpdate.json()).toEqual(expect.objectContaining({ legalName: `再次修正的主体-${suffix}`, brandName: `更新后品牌-${suffix}`, servicePhone: '020-6666-0002', primaryColor: '#1d6f62' }));
  });

  it('rejects dynamic voucher codes with invalid signatures, segments, or signed payload fields', async () => {
    const platform = await login('platform@demo.local');
    const merchant = (await (await request('/api/merchants', { headers: { Authorization: `Bearer ${platform.token}` } })).json() as Array<{ id: string; brandName: string }>).find((item) => item.brandName === '花时间花艺')!;
    const customer = await customerSession();
    const storefront = await (await request(`/api/public/merchants/${merchant.id}`)).json() as { stores: Array<{ id: string }> };
    const deal = (await (await request(`/api/public/merchants/${merchant.id}/packages`)).json() as Array<{ id: string; storeIds: string[] }>).find((item) => item.storeIds.includes(storefront.stores[0].id))!;
    const order = await (await request(`/api/public/merchants/${merchant.id}/orders`, {
      method: 'POST', headers: customer, body: JSON.stringify({ packageId: deal.id, storeId: storefront.stores[0].id, quantity: 1 }),
    })).json() as { id: string };
    const payment = await (await request(`/api/public/orders/${order.id}/mock-confirm`, { method: 'POST', headers: customer })).json() as { vouchers: Array<{ id: string }> };
    const dynamic = await (await request(`/api/public/vouchers/${payment.vouchers[0].id}/dynamic-code`, { method: 'POST', headers: customer })).json() as { token: string };
    const [payload, signature] = dynamic.token.split('.');
    const tamperedSignature = `${payload}.${signature.slice(0, -1)}${signature.endsWith('A') ? 'B' : 'A'}`;
    const signedToken = (content: Record<string, unknown>) => {
      const encoded = Buffer.from(JSON.stringify(content)).toString('base64url');
      const signed = createHmac('sha256', process.env.VOUCHER_TOKEN_SECRET || 'dev-voucher-secret').update(encoded).digest('base64url');
      return `${encoded}.${signed}`;
    };
    const staff = await login('staff@demo.local');
    const headers = { Authorization: `Bearer ${staff.token}`, 'Content-Type': 'application/json' };
    const workingStoreId = storefront.stores[0].id;
    expect((await request('/api/verification/preview', { method: 'POST', headers, body: JSON.stringify({ token: tamperedSignature, workingStoreId }) })).status).toBe(400);
    expect((await request('/api/verification/preview', { method: 'POST', headers, body: JSON.stringify({ token: `${dynamic.token}.extra`, workingStoreId }) })).status).toBe(400);
    expect((await request('/api/verification/preview', {
      method: 'POST', headers, body: JSON.stringify({ token: signedToken({ voucherId: payment.vouchers[0].id, nonce: 'abcdef1234', exp: Math.floor(Date.now() / 1000) - 1 }), workingStoreId }),
    })).status).toBe(400);
    expect((await request('/api/verification/preview', {
      method: 'POST', headers, body: JSON.stringify({ token: signedToken({ voucherId: 'not-a-uuid', nonce: 'abcdef1234', exp: Math.floor(Date.now() / 1000) + 60 }), workingStoreId }),
    })).status).toBe(400);
  });

  it('rejects malformed identifiers and unexpected fields before business processing', async () => {
    const overpostedLogin = await request('/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'platform@demo.local', password: 'Demo123456', role: 'PLATFORM_ADMIN' }),
    });
    expect(overpostedLogin.status).toBe(400);
    const customerHeaders = await customerSession();
    expect((await request('/api/public/merchants/not-a-uuid/orders', {
      method: 'POST', headers: customerHeaders, body: JSON.stringify({ packageId: 'not-a-uuid', storeId: 'not-a-uuid', quantity: 1 }),
    })).status).toBe(400);
    const staff = await login('staff@demo.local');
    expect((await request('/api/verification/preview', {
      method: 'POST', headers: { Authorization: `Bearer ${staff.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ token: 'a'.repeat(16), unexpected: true }),
    })).status).toBe(400);

    const platform = await login('platform@demo.local');
    const platformHeaders = { Authorization: `Bearer ${platform.token}`, 'Content-Type': 'application/json' };
    const merchants = await (await request('/api/merchants', { headers: platformHeaders })).json() as Array<{ id: string; agencyId: string; brandName: string }>;
    const merchant = merchants.find((item) => item.brandName === '花时间花艺')!;
    expect((await request(`/api/merchants/${merchant.id}`, {
      method: 'PATCH', headers: platformHeaders, body: JSON.stringify({ primaryColor: '#112233', impersonatePlatform: true }),
    })).status).toBe(400);
    expect((await request('/api/merchants', {
      method: 'POST', headers: platformHeaders,
      body: JSON.stringify({ agencyId: merchant.agencyId, legalName: '字段校验测试主体', brandName: '字段校验测试品牌', adminName: '测试管理员', adminEmail: 'validation-admin@demo.local', adminPassword: 'ValidationPassword123', status: 'CLOSED' }),
    })).status).toBe(400);
    expect((await request(`/api/merchants/${merchant.id}/rates`, {
      method: 'POST', headers: platformHeaders, body: JSON.stringify({ rate: 0.08, effectiveFrom: '2030-01-01', note: '测试', actorId: platform.user.id }),
    })).status).toBe(400);
  });

  it('limits store staff to their authorized stores and their own verification history', async () => {
    const platform = await login('platform@demo.local');
    const merchants = await (await request('/api/merchants', { headers: { Authorization: `Bearer ${platform.token}` } })).json() as Array<{ id: string; brandName: string }>;
    const merchant = merchants.find((item) => item.brandName === '花时间花艺')!;
    const merchantAdmin = await login('merchant@demo.local');
    const merchantHeaders = { Authorization: `Bearer ${merchantAdmin.token}`, 'Content-Type': 'application/json' };
    const storeResponse = await request(`/api/merchants/${merchant.id}/stores`, {
      method: 'POST', headers: merchantHeaders, body: JSON.stringify({ name: '权限测试门店', address: '广州市天河区权限路 1 号', phone: '020-0000-0001', businessHours: '09:00-21:00' }),
    });
    expect(storeResponse.status).toBe(201);
    const additionalStore = await storeResponse.json() as { id: string };
    const packageResponse = await request(`/api/merchants/${merchant.id}/packages`, {
      method: 'POST', headers: merchantHeaders,
      body: JSON.stringify({ title: '权限隔离测试套餐', description: '仅用于权限测试', priceFen: 1000, saleLimit: 10, perCustomerLimit: 1, storeIds: [additionalStore.id], validFrom: '2026-01-01', validTo: '2027-12-31', status: 'ON_SALE' }),
    });
    expect(packageResponse.status).toBe(201);
    const additionalPackage = await packageResponse.json() as { id: string };
    const staffCreate = await request(`/api/merchants/${merchant.id}/staff`, {
      method: 'POST', headers: merchantHeaders,
      body: JSON.stringify({ email: 'scope-store-b@demo.local', name: '权限测试核销员', password: 'ScopeTestPassword123', storeIds: [additionalStore.id] }),
    });
    expect(staffCreate.status).toBe(201);
    const storeBStaff = await login('scope-store-b@demo.local', 'ScopeTestPassword123');
    const storeAStaff = await login('staff@demo.local');
    const customerHeaders = await customerSession();
    const order = await (await request(`/api/public/merchants/${merchant.id}/orders`, {
      method: 'POST', headers: customerHeaders, body: JSON.stringify({ packageId: additionalPackage.id, storeId: additionalStore.id, quantity: 1 }),
    })).json() as { id: string };
    const confirmation = await (await request(`/api/public/orders/${order.id}/mock-confirm`, { method: 'POST', headers: customerHeaders })).json() as { vouchers: Array<{ id: string }> };
    const voucherId = confirmation.vouchers[0].id;
    const dynamicCode = await (await request(`/api/public/vouchers/${voucherId}/dynamic-code`, { method: 'POST', headers: customerHeaders })).json() as { token: string };
    const invalidVerification = await request('/api/verification/confirm', {
      method: 'POST', headers: { Authorization: `Bearer ${storeBStaff.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ token: dynamicCode.token, workingStoreId: additionalStore.id, idempotencyKey: 'invalid' }),
    });
    expect(invalidVerification.status).toBe(400);
    const idempotencyKey = 'scope-store-b-verification';
    const verification = await request('/api/verification/confirm', {
      method: 'POST', headers: { Authorization: `Bearer ${storeBStaff.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ token: dynamicCode.token, workingStoreId: additionalStore.id, idempotencyKey }),
    });
    expect(verification.status).toBe(201);
    const firstVerification = await verification.json() as { id: string } & Record<string, unknown>;
    expect(firstVerification).not.toHaveProperty('idempotencyKey');
    const retry = await request('/api/verification/confirm', {
      method: 'POST', headers: { Authorization: `Bearer ${storeBStaff.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ token: dynamicCode.token, workingStoreId: additionalStore.id, idempotencyKey }),
    });
    expect(retry.status).toBe(201);
    const retriedVerification = await retry.json() as { id: string } & Record<string, unknown>;
    expect(retriedVerification.id).toBe(firstVerification.id);
    expect(retriedVerification).not.toHaveProperty('idempotencyKey');

    const storeAHeaders = { Authorization: `Bearer ${storeAStaff.token}` };
    const staffMerchantList = await (await request('/api/merchants', { headers: storeAHeaders })).json() as Array<Record<string, unknown>>;
    expect(staffMerchantList).toEqual([expect.objectContaining({ id: merchant.id, brandName: '花时间花艺', primaryColor: expect.any(String) })]);
    expect(staffMerchantList[0]).not.toHaveProperty('legalName');
    expect(staffMerchantList[0]).not.toHaveProperty('contractNumber');
    expect(staffMerchantList[0]).not.toHaveProperty('contractEndsAt');
    const staffDashboardResponse = await request(`/api/dashboard?merchantId=${merchant.id}`, { headers: storeAHeaders });
    expect(staffDashboardResponse.status).toBe(200);
    const staffDashboard = await staffDashboardResponse.json() as Record<string, unknown>;
    expect(staffDashboard).toEqual(expect.objectContaining({ scopeMerchantId: merchant.id, stores: expect.any(Number), verifications: expect.any(Number) }));
    expect(staffDashboard).not.toHaveProperty('orders');
    expect(staffDashboard).not.toHaveProperty('vouchers');
    expect((await request(`/api/merchants/${merchant.id}/packages`, { headers: storeAHeaders })).status).toBe(403);
    const verifications = (await (await request(`/api/verifications?merchantId=${merchant.id}`, { headers: storeAHeaders })).json() as { items: Array<{ storeId: string } & Record<string, unknown>> }).items;
    expect(verifications.some((record) => record.storeId === additionalStore.id)).toBe(false);
    expect(verifications.every((record) => !('idempotencyKey' in record))).toBe(true);
    expect((await request(`/api/orders?merchantId=${merchant.id}`, { headers: storeAHeaders })).status).toBe(403);
    expect((await request(`/api/vouchers?merchantId=${merchant.id}`, { headers: storeAHeaders })).status).toBe(403);
    expect((await request('/api/exports', { method: 'POST', headers: { ...storeAHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'orders', merchantId: merchant.id }) })).status).toBe(403);
  });

  it('requires an authorized multi-store employee to select the voucher work store before confirming', async () => {
    const suffix = `${Date.now()}-${Math.floor(Math.random() * 100_000)}`;
    const platform = await login('platform@demo.local');
    const merchant = (await (await request('/api/merchants', { headers: { Authorization: `Bearer ${platform.token}` } })).json() as Array<{ id: string; brandName: string }>).find((item) => item.brandName === '花时间花艺')!;
    const merchantAdmin = await login('merchant@demo.local');
    const merchantHeaders = { Authorization: `Bearer ${merchantAdmin.token}`, 'Content-Type': 'application/json' };
    const [firstStore] = await (await request(`/api/merchants/${merchant.id}/stores`, { headers: merchantHeaders })).json() as Array<{ id: string }>;
    const secondStore = await (await request(`/api/merchants/${merchant.id}/stores`, {
      method: 'POST', headers: merchantHeaders,
      body: JSON.stringify({ name: `轮班核销门店-${suffix}`, address: '广州市天河区核销路 8 号', phone: '020-1000-0008', businessHours: '10:00-20:00', openForSale: true }),
    })).json() as { id: string };
    const deal = await (await request(`/api/merchants/${merchant.id}/packages`, {
      method: 'POST', headers: merchantHeaders,
      body: JSON.stringify({ title: `轮班核销套餐-${suffix}`, description: '验证当前工作门店校验', priceFen: 1990, saleLimit: 10, perCustomerLimit: 1, storeIds: [secondStore.id], validFrom: '2026-01-01', validTo: '2027-12-31', status: 'ON_SALE' }),
    })).json() as { id: string };
    const staffEmail = `working-store-${suffix}@demo.local`;
    const staffCreate = await request(`/api/merchants/${merchant.id}/staff`, {
      method: 'POST', headers: merchantHeaders,
      body: JSON.stringify({ email: staffEmail, name: '轮班核销员', password: 'WorkingStorePassword123', storeIds: [firstStore.id, secondStore.id] }),
    });
    expect(staffCreate.status).toBe(201);
    const customerHeaders = await customerSession();
    const order = await (await request(`/api/public/merchants/${merchant.id}/orders`, {
      method: 'POST', headers: customerHeaders, body: JSON.stringify({ packageId: deal.id, storeId: secondStore.id, quantity: 1 }),
    })).json() as { id: string };
    const payment = await (await request(`/api/public/orders/${order.id}/mock-confirm`, { method: 'POST', headers: customerHeaders })).json() as { vouchers: Array<{ id: string }> };
    const dynamic = await (await request(`/api/public/vouchers/${payment.vouchers[0].id}/dynamic-code`, { method: 'POST', headers: customerHeaders })).json() as { token: string };
    const staff = await login(staffEmail, 'WorkingStorePassword123');
    const headers = { Authorization: `Bearer ${staff.token}`, 'Content-Type': 'application/json' };

    const mismatchPreview = await request('/api/verification/preview', { method: 'POST', headers, body: JSON.stringify({ token: dynamic.token, workingStoreId: firstStore.id }) });
    expect(mismatchPreview.status).toBe(201);
    expect(await mismatchPreview.json()).toEqual(expect.objectContaining({ workingStoreMatches: false, canVerify: false }));
    expect((await request('/api/verification/confirm', {
      method: 'POST', headers, body: JSON.stringify({ token: dynamic.token, workingStoreId: firstStore.id, idempotencyKey: 'working-store-mismatch' }),
    })).status).toBe(400);

    const matchingPreview = await request('/api/verification/preview', { method: 'POST', headers, body: JSON.stringify({ token: dynamic.token, workingStoreId: secondStore.id }) });
    expect(matchingPreview.status).toBe(201);
    expect(await matchingPreview.json()).toEqual(expect.objectContaining({ workingStoreMatches: true, canVerify: true }));
    expect((await request('/api/verification/confirm', {
      method: 'POST', headers, body: JSON.stringify({ token: dynamic.token, workingStoreId: secondStore.id, idempotencyKey: 'working-store-match' }),
    })).status).toBe(201);
  });

  it('does not suspend an operating merchant for legacy SaaS contract fields and completes exit only after fulfillment', async () => {
    const platform = await login('platform@demo.local');
    const platformHeaders = { Authorization: `Bearer ${platform.token}`, 'Content-Type': 'application/json' };
    const agency = (await (await request('/api/agencies', { headers: platformHeaders })).json() as Array<{ id: string; name: string }>).find((item) => item.name === '华南精选生活代理')!;
    const merchantResponse = await request('/api/merchants', {
      method: 'POST', headers: platformHeaders,
      body: JSON.stringify({ agencyId: agency.id, legalName: '合同测试商家主体', brandName: '合同到期测试店', servicePhone: '020-0000-0002', contractNumber: 'EXPIRED-TEST-001', contractEndsAt: '2020-01-01', adminName: '合同离场商家管理员', adminEmail: 'contract-exit-merchant@demo.local', adminPassword: 'ContractExitMerchant123' }),
    });
    expect(merchantResponse.status).toBe(201);
    const merchant = await merchantResponse.json() as { id: string; status: string };
    await app.get(DataSource).getRepository(CommissionRateVersion).save({ merchantId: merchant.id, rate: '0.0800', effectiveFrom: new Date('2020-01-01'), note: '支付服务商同步测试快照', createdBy: 'test' });
    const exitingMerchantAdmin = await login('contract-exit-merchant@demo.local', 'ContractExitMerchant123');
    const storeResponse = await request(`/api/merchants/${merchant.id}/stores`, {
      method: 'POST', headers: platformHeaders, body: JSON.stringify({ name: '合同测试门店', address: '广州市天河区合同路 1 号' }),
    });
    expect(storeResponse.status).toBe(201);
    const store = await storeResponse.json() as { id: string };
    const staffResponse = await request(`/api/merchants/${merchant.id}/staff`, {
      method: 'POST', headers: platformHeaders,
      body: JSON.stringify({ name: '合同离场核销员', email: 'contract-close-staff@demo.local', password: 'ContractClosePassword123', storeIds: [store.id] }),
    });
    expect(staffResponse.status).toBe(201);
    const closingStaff = await login('contract-close-staff@demo.local', 'ContractClosePassword123');
    const packageResponse = await request(`/api/merchants/${merchant.id}/packages`, {
      method: 'POST', headers: platformHeaders,
      body: JSON.stringify({ title: '合同测试套餐', description: '用于合同生命周期验证', priceFen: 1200, saleLimit: 10, perCustomerLimit: 2, storeIds: [store.id], validFrom: '2026-01-01', validTo: '2027-12-31', status: 'ON_SALE' }),
    });
    expect(packageResponse.status).toBe(201);
    const deal = await packageResponse.json() as { id: string };
    const customerHeaders = await customerSession();
    expect((await request(`/api/public/merchants/${merchant.id}`)).status).toBe(200);
    expect((await request(`/api/public/merchants/${merchant.id}/packages`)).status).toBe(200);
    const firstOrderResponse = await request(`/api/public/merchants/${merchant.id}/orders`, {
      method: 'POST', headers: customerHeaders, body: JSON.stringify({ idempotencyKey: 'merchant-exit-existing-order', packageId: deal.id, storeId: store.id, quantity: 1 }),
    });
    expect(firstOrderResponse.status).toBe(201);
    const existingOrder = await firstOrderResponse.json() as { id: string };

    const sweep = await app.get(LifecycleOrchestrationService).runSweep();
    expect(sweep.suspendedContracts).toBe(0);
    const activeMerchant = (await (await request('/api/merchants', { headers: platformHeaders })).json() as Array<{ id: string; status: string }>).find((item) => item.id === merchant.id)!;
    expect(activeMerchant.status).toBe('ACTIVE');
    expect((await request(`/api/public/merchants/${merchant.id}`)).status).toBe(200);
    const suspendSales = await request(`/api/merchants/${merchant.id}`, {
      method: 'PATCH', headers: platformHeaders, body: JSON.stringify({ status: 'SALES_SUSPENDED', expectedStatus: 'ACTIVE', statusReason: '门店设备检修期间暂停新增订单。' }),
    });
    expect(suspendSales.status).toBe(200);
    const existingPayment = await request(`/api/public/orders/${existingOrder.id}/mock-confirm`, { method: 'POST', headers: customerHeaders });
    expect(existingPayment.status).toBe(201);
    const paidVouchers = await existingPayment.json() as { vouchers: Array<{ id: string }> };
    const secondCustomer = await customerSession();
    expect((await request(`/api/public/merchants/${merchant.id}/orders`, { method: 'POST', headers: secondCustomer, body: JSON.stringify({ packageId: deal.id, storeId: store.id, quantity: 1 }) })).status).toBe(400);
    expect((await request(`/api/merchants/${merchant.id}`, {
      method: 'PATCH', headers: platformHeaders, body: JSON.stringify({ status: 'CLOSED', expectedStatus: 'SALES_SUSPENDED', statusReason: '试图跳过离场收尾。' }),
    })).status).toBe(400);
    const exitRequested = await request(`/api/merchants/${merchant.id}`, {
      method: 'PATCH', headers: platformHeaders, body: JSON.stringify({ status: 'EXITING', expectedStatus: 'SALES_SUSPENDED', statusReason: '商家申请退出经营，先完成全部已购券履约。' }),
    });
    expect(exitRequested.status).toBe(200);
    expect(await exitRequested.json()).toEqual(expect.objectContaining({ status: 'EXITING' }));
    expect((await (await request(`/api/merchants/${merchant.id}/exit-case`, { headers: platformHeaders })).json() as { status: string }).status).toBe('SALE_PAUSED');
    expect((await request(`/api/merchants/${merchant.id}/exit-case/start-fulfillment`, {
      method: 'POST', headers: platformHeaders, body: JSON.stringify({ note: '已暂停新售，开始跟进已购券履约和售后。' }),
    })).status).toBe(201);
    expect((await request(`/api/public/merchants/${merchant.id}`)).status).toBe(404);
    expect((await request(`/api/merchants/${merchant.id}/exit-readiness`, { headers: { Authorization: `Bearer ${closingStaff.token}` } })).status).toBe(403);
    const exitBlocked = await (await request(`/api/merchants/${merchant.id}/exit-readiness`, { headers: platformHeaders })).json() as { readyToClose: boolean; blockers: { activeVouchers: number } };
    expect(exitBlocked).toEqual(expect.objectContaining({ readyToClose: false, blockers: expect.objectContaining({ activeVouchers: 1 }) }));
    const dynamicCode = await request(`/api/public/vouchers/${paidVouchers.vouchers[0].id}/dynamic-code`, { method: 'POST', headers: customerHeaders });
    expect(dynamicCode.status).toBe(201);
    expect((await request('/api/verification/confirm', {
      method: 'POST', headers: { Authorization: `Bearer ${closingStaff.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: (await dynamicCode.json() as { token: string }).token, workingStoreId: store.id, idempotencyKey: 'closed-merchant-fulfilment' }),
    })).status).toBe(201);
    const exitReady = await (await request(`/api/merchants/${merchant.id}/exit-readiness`, { headers: platformHeaders })).json() as { readyToClose: boolean };
    expect(exitReady.readyToClose).toBe(true);
    expect((await request(`/api/merchants/${merchant.id}/exit-case/prepare-export`, {
      method: 'POST', headers: platformHeaders, body: JSON.stringify({ note: '已完成履约、退款、售后和结算检查，允许进行一次性数据交付。' }),
    })).status).toBe(201);
    const exitingMerchantHeaders = { Authorization: `Bearer ${exitingMerchantAdmin.token}`, 'Content-Type': 'application/json' };
    expect((await request(`/api/merchants/${merchant.id}/exit-case/confirm-data-export`, {
      method: 'POST', headers: exitingMerchantHeaders, body: JSON.stringify({ note: '商家已下载订单和核销明细，确认完成数据交付。' }),
    })).status).toBe(201);
    expect((await request(`/api/merchants/${merchant.id}/exit-case/acknowledge-authorization-revocation`, {
      method: 'POST', headers: exitingMerchantHeaders, body: JSON.stringify({ note: '商家管理员已知悉关闭后应在微信侧撤销小程序授权。' }),
    })).status).toBe(201);
    const closed = await request(`/api/merchants/${merchant.id}`, {
      method: 'PATCH', headers: platformHeaders, body: JSON.stringify({ status: 'CLOSED', expectedStatus: 'EXITING', statusReason: '已核对既有券履约、售后和月结事项，完成离场关闭。' }),
    });
    expect(closed.status).toBe(200);
    const retained = await request(`/api/merchants/${merchant.id}/exit-case/review-retention`, {
      method: 'POST', headers: platformHeaders, body: JSON.stringify({ retentionPolicyReference: 'TEST-RETENTION-001', retentionUntil: '2020-01-01', note: '测试环境仅验证清理资格，不执行任何物理删除。' }),
    });
    expect(retained.status).toBe(201);
    expect(await retained.json()).toEqual(expect.objectContaining({ status: 'PURGE_ELIGIBLE' }));
    expect((await request(`/api/merchants/${merchant.id}`, {
      method: 'PATCH', headers: platformHeaders, body: JSON.stringify({ status: 'ACTIVE', expectedStatus: 'CLOSED', statusReason: '尝试恢复已退出商家。' }),
    })).status).toBe(400);
    const statusAudit = await app.get(DataSource).getRepository(AuditLog).findOne({ where: { merchantId: merchant.id, action: 'MERCHANT_STATUS_CHANGED' }, order: { createdAt: 'DESC' } });
    expect(statusAudit?.after).toEqual(expect.objectContaining({ status: 'CLOSED', statusReason: '已核对既有券履约、售后和月结事项，完成离场关闭。' }));
  });

  it('keeps a merchant exit request distinct from the platform sales-pause decision', async () => {
    const merchantAdmin = await login('merchant@demo.local');
    const platform = await login('platform@demo.local');
    const agency = await login('agency@demo.local');
    const merchant = (await (await request('/api/merchants', { headers: { Authorization: `Bearer ${platform.token}` } })).json() as Array<{ id: string; brandName: string; status: string }>).find((item) => item.brandName === '花时间花艺')!;
    const merchantHeaders = { Authorization: `Bearer ${merchantAdmin.token}`, 'Content-Type': 'application/json' };
    const submitted = await request(`/api/merchants/${merchant.id}/exit-case`, {
      method: 'POST', headers: merchantHeaders, body: JSON.stringify({ note: '因门店整体调整申请退出，愿意继续完成全部已购券履约。' }),
    });
    expect(submitted.status).toBe(201);
    expect(await submitted.json()).toEqual(expect.objectContaining({ status: 'EXIT_REQUESTED', dataExportConfirmed: false, authorizationRevocationAcknowledged: false }));
    expect((await request(`/api/public/merchants/${merchant.id}`)).status).toBe(200);
    expect((await request(`/api/merchants/${merchant.id}/exit-case`, {
      method: 'POST', headers: { Authorization: `Bearer ${agency.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ note: '代理商不得重复代为提交。' }),
    })).status).toBe(403);
    const platformHeaders = { Authorization: `Bearer ${platform.token}`, 'Content-Type': 'application/json' };
    const paused = await request(`/api/merchants/${merchant.id}`, {
      method: 'PATCH', headers: platformHeaders, body: JSON.stringify({ status: 'EXITING', expectedStatus: merchant.status, statusReason: '平台确认退出申请，停止新订单并进入离场履约。' }),
    });
    expect(paused.status).toBe(200);
    expect((await (await request(`/api/merchants/${merchant.id}/exit-case`, { headers: platformHeaders })).json() as { status: string; salesPausedAt: string | null }).status).toBe('SALE_PAUSED');
    // This case intentionally proves the transition to EXITING. Restore the
    // shared seeded merchant afterwards so independent later cases can still
    // exercise public sales without inheriting an unrelated exit workflow.
    await app.get(DataSource).transaction(async (manager) => {
      await manager.delete(MerchantExitCase, { merchantId: merchant.id });
      await manager.update(Merchant, merchant.id, { status: MerchantStatus.ACTIVE });
    });
  });

  it.skip('requires a second finance reviewer before anchoring a fee-rate version to the China business day', async () => {
    const platform = await login('platform@demo.local');
    const merchants = await (await request('/api/merchants', { headers: { Authorization: `Bearer ${platform.token}` } })).json() as Array<{ id: string; brandName: string }>;
    const merchant = merchants.find((item) => item.brandName === '花时间花艺')!;
    const headers = { Authorization: `Bearer ${platform.token}`, 'Content-Type': 'application/json' };
    const users = app.get(DataSource).getRepository(User);
    const breakGlass = await users.createQueryBuilder('user').addSelect('user.passwordHash').where('user.email = :email', { email: 'platform@demo.local' }).getOneOrFail();
    const reviewerEmail = `rate-reviewer-${Date.now()}-${Math.floor(Math.random() * 100_000)}@demo.local`;
    await users.save({ email: reviewerEmail, name: '费率复核财务', passwordHash: breakGlass.passwordHash, role: UserRole.PLATFORM_ADMIN, platformAccessProfile: PlatformAccessProfile.FINANCE, agencyId: null, merchantId: null, storeIds: null, active: true });
    const reviewer = await login(reviewerEmail);
    const reviewerHeaders = { Authorization: `Bearer ${reviewer.token}`, 'Content-Type': 'application/json' };
    const idempotencyKey = 'rate-version-timezone-001';
    const response = await request(`/api/merchants/${merchant.id}/rates`, {
      method: 'POST', headers: { ...headers, 'Idempotency-Key': idempotencyKey }, body: JSON.stringify({ rate: 0.1234, effectiveFrom: '2030-01-02', note: '时区边界验证' }),
    });
    expect(response.status).toBe(201);
    const rateChangeRequest = await response.json() as { id: string; status: string; effectiveFrom: string; idempotencyKey?: string; requestHash?: string };
    expect(rateChangeRequest.status).toBe(RateChangeRequestStatus.PENDING_REVIEW);
    expect(new Date(rateChangeRequest.effectiveFrom).toISOString()).toBe('2030-01-01T16:00:00.000Z');
    expect(rateChangeRequest).not.toHaveProperty('idempotencyKey');
    expect(rateChangeRequest).not.toHaveProperty('requestHash');
    expect(await app.get(DataSource).getRepository(CommissionRateVersion).countBy({ merchantId: merchant.id, effectiveFrom: new Date('2030-01-01T16:00:00.000Z') })).toBe(0);
    const replay = await request(`/api/merchants/${merchant.id}/rates`, {
      method: 'POST', headers: { ...headers, 'Idempotency-Key': idempotencyKey }, body: JSON.stringify({ rate: 0.1234, effectiveFrom: '2030-01-02', note: '时区边界验证' }),
    });
    expect(replay.status).toBe(201);
    expect((await replay.json() as { id: string }).id).toBe(rateChangeRequest.id);
    const reusedKeyWithDifferentContent = await request(`/api/merchants/${merchant.id}/rates`, {
      method: 'POST', headers: { ...headers, 'Idempotency-Key': idempotencyKey }, body: JSON.stringify({ rate: 0.1200, effectiveFrom: '2030-01-02', note: '时区边界验证' }),
    });
    expect(reusedKeyWithDifferentContent.status).toBe(409);
    const missingIdempotencyKey = await request(`/api/merchants/${merchant.id}/rates`, {
      method: 'POST', headers, body: JSON.stringify({ rate: 0.1200, effectiveFrom: '2030-01-03', note: '缺少请求键测试' }),
    });
    expect(missingIdempotencyKey.status).toBe(400);
    const listedRequests = await (await request(`/api/merchants/${merchant.id}/rate-change-requests`, { headers: { Authorization: `Bearer ${platform.token}` } })).json() as Array<{ id: string; status: string; idempotencyKey?: string; requestHash?: string }>;
    expect(listedRequests).toEqual(expect.arrayContaining([expect.objectContaining({ id: rateChangeRequest.id, status: RateChangeRequestStatus.PENDING_REVIEW })]));
    expect(listedRequests.every((item) => !('idempotencyKey' in item) && !('requestHash' in item))).toBe(true);
    const selfApproval = await request(`/api/merchants/${merchant.id}/rate-change-requests/${rateChangeRequest.id}/approve`, {
      method: 'POST', headers, body: JSON.stringify({ note: '发起人不能自审。' }),
    });
    expect(selfApproval.status).toBe(403);
    const approved = await request(`/api/merchants/${merchant.id}/rate-change-requests/${rateChangeRequest.id}/approve`, {
      method: 'POST', headers: reviewerHeaders, body: JSON.stringify({ note: '合同附件与生效日期复核通过。' }),
    });
    expect(approved.status).toBe(201);
    expect((await approved.json() as { status: string }).status).toBe(RateChangeRequestStatus.APPROVED);
    const versions = await (await request(`/api/merchants/${merchant.id}/rates`, { headers: { Authorization: `Bearer ${platform.token}` } })).json() as Array<{ id: string; rate: number; effectiveFrom: string; idempotencyKey?: string; requestHash?: string }>;
    expect(versions[0]).toEqual(expect.objectContaining({ rate: 0.1234 }));
    expect(versions.every((item) => !('idempotencyKey' in item) && !('requestHash' in item))).toBe(true);
    const version = versions.find((item) => new Date(item.effectiveFrom).toISOString() === '2030-01-01T16:00:00.000Z')!;
    const rateAudit = await app.get(DataSource).getRepository(AuditLog).findOneByOrFail({ merchantId: merchant.id, action: 'RATE_VERSION_CREATED', resourceId: version.id });
    expect(rateAudit.after).toEqual(expect.objectContaining({ rate: 0.1234, effectiveFrom: '2030-01-02', reason: '时区边界验证' }));
    expect(await app.get(DataSource).getRepository(AuditLog).countBy({ merchantId: merchant.id, action: 'RATE_VERSION_CREATED', resourceId: version.id })).toBe(1);
    expect(await app.get(DataSource).getRepository(AuditLog).countBy({ merchantId: merchant.id, action: 'RATE_CHANGE_REQUESTED', resourceId: rateChangeRequest.id })).toBe(1);
    expect(await app.get(DataSource).getRepository(AuditLog).countBy({ merchantId: merchant.id, action: 'RATE_CHANGE_APPROVED', resourceId: rateChangeRequest.id })).toBe(1);
    const rejected = await request(`/api/merchants/${merchant.id}/rates`, {
      method: 'POST', headers: { ...headers, 'Idempotency-Key': 'rate-version-rejected-001' }, body: JSON.stringify({ rate: 0.1200, effectiveFrom: '2030-01-03', note: '待驳回的费率调整' }),
    });
    expect(rejected.status).toBe(201);
    const rejectedRequest = await rejected.json() as { id: string };
    expect((await request(`/api/merchants/${merchant.id}/rate-change-requests/${rejectedRequest.id}/reject`, {
      method: 'POST', headers: reviewerHeaders, body: JSON.stringify({ note: '合同审批材料不完整，暂不通过。' }),
    })).status).toBe(201);
    expect(await app.get(DataSource).getRepository(CommissionRateVersion).countBy({ merchantId: merchant.id, effectiveFrom: new Date('2030-01-02T16:00:00.000Z') })).toBe(0);
    expect(await app.get(DataSource).getRepository(RateChangeRequest).countBy({ id: rejectedRequest.id, status: RateChangeRequestStatus.REJECTED })).toBe(1);
    const agency = await login('agency@demo.local');
    expect((await request(`/api/merchants/${merchant.id}/rates`, { headers: { Authorization: `Bearer ${agency.token}` } })).status).toBe(403);
    const invalid = await request(`/api/merchants/${merchant.id}/rates`, {
      method: 'POST', headers: { ...headers, 'Idempotency-Key': 'rate-version-invalid-date' }, body: JSON.stringify({ rate: 0.1, effectiveFrom: '2030-02-30', note: '无效日期' }),
    });
    expect(invalid.status).toBe(400);
  });

  it.skip('deduplicates concurrent fee-rate change requests without creating a commercial version', async () => {
    const platform = await login('platform@demo.local');
    const merchant = (await (await request('/api/merchants', { headers: { Authorization: `Bearer ${platform.token}` } })).json() as Array<{ id: string; brandName: string }>).find((item) => item.brandName === '花时间花艺')!;
    const headers = { Authorization: `Bearer ${platform.token}`, 'Content-Type': 'application/json', 'Idempotency-Key': 'rate-version-concurrent-001' };
    const body = JSON.stringify({ rate: 0.1025, effectiveFrom: '2030-01-06', note: '合同 C-2030-006 完成双方审批后调整费率' });
    const [first, second] = await Promise.all([
      request(`/api/merchants/${merchant.id}/rates`, { method: 'POST', headers, body }),
      request(`/api/merchants/${merchant.id}/rates`, { method: 'POST', headers, body }),
    ]);
    expect([first.status, second.status]).toEqual([201, 201]);
    const [firstRequest, secondRequest] = await Promise.all([first.json(), second.json()]) as Array<{ id: string; status: string }>;
    expect(firstRequest.id).toBe(secondRequest.id);
    expect(firstRequest.status).toBe(RateChangeRequestStatus.PENDING_REVIEW);
    expect(await app.get(DataSource).getRepository(RateChangeRequest).countBy({ merchantId: merchant.id, effectiveFrom: new Date('2030-01-05T16:00:00.000Z'), status: RateChangeRequestStatus.PENDING_REVIEW })).toBe(1);
    expect(await app.get(DataSource).getRepository(CommissionRateVersion).countBy({ merchantId: merchant.id, effectiveFrom: new Date('2030-01-05T16:00:00.000Z') })).toBe(0);
    expect(await app.get(DataSource).getRepository(AuditLog).countBy({ merchantId: merchant.id, action: 'RATE_CHANGE_REQUESTED', resourceId: firstRequest.id })).toBe(1);
  });

  it.skip('separates platform operations, finance, compliance and security duties while keeping break-glass compatibility', async () => {
    const users = app.get(DataSource).getRepository(User);
    const breakGlass = await users.createQueryBuilder('user').addSelect('user.passwordHash').where('user.email = :email', { email: 'platform@demo.local' }).getOneOrFail();
    const suffix = `${Date.now()}-${Math.floor(Math.random() * 100_000)}`;
    await users.save([
      { email: `finance-${suffix}@demo.local`, name: '平台财务', passwordHash: breakGlass.passwordHash, role: UserRole.PLATFORM_ADMIN, platformAccessProfile: PlatformAccessProfile.FINANCE, agencyId: null, merchantId: null, storeIds: null, active: true },
      { email: `finance-reviewer-${suffix}@demo.local`, name: '平台复核财务', passwordHash: breakGlass.passwordHash, role: UserRole.PLATFORM_ADMIN, platformAccessProfile: PlatformAccessProfile.FINANCE, agencyId: null, merchantId: null, storeIds: null, active: true },
      { email: `operations-${suffix}@demo.local`, name: '平台运营', passwordHash: breakGlass.passwordHash, role: UserRole.PLATFORM_ADMIN, platformAccessProfile: PlatformAccessProfile.OPERATIONS, agencyId: null, merchantId: null, storeIds: null, active: true },
      { email: `compliance-${suffix}@demo.local`, name: '平台合规', passwordHash: breakGlass.passwordHash, role: UserRole.PLATFORM_ADMIN, platformAccessProfile: PlatformAccessProfile.COMPLIANCE, agencyId: null, merchantId: null, storeIds: null, active: true },
      { email: `security-${suffix}@demo.local`, name: '平台安全', passwordHash: breakGlass.passwordHash, role: UserRole.PLATFORM_ADMIN, platformAccessProfile: PlatformAccessProfile.SECURITY, agencyId: null, merchantId: null, storeIds: null, active: true },
    ]);
    const [finance, financeReviewer, operations, compliance, security, breakGlassSession] = await Promise.all([
      login(`finance-${suffix}@demo.local`), login(`finance-reviewer-${suffix}@demo.local`), login(`operations-${suffix}@demo.local`), login(`compliance-${suffix}@demo.local`), login(`security-${suffix}@demo.local`), login('platform@demo.local'),
    ]);
    expect(finance.user).toEqual(expect.objectContaining({ platformAccessProfile: PlatformAccessProfile.FINANCE }));
    const merchant = (await (await request('/api/merchants', { headers: { Authorization: `Bearer ${breakGlassSession.token}` } })).json() as Array<{ id: string; brandName: string }>).find((item) => item.brandName === '花时间花艺')!;
    const financeHeaders = { Authorization: `Bearer ${finance.token}`, 'Content-Type': 'application/json', 'Idempotency-Key': `scoped-finance-rate-${suffix}` };
    const submittedRateChange = await request(`/api/merchants/${merchant.id}/rates`, {
      method: 'POST', headers: financeHeaders, body: JSON.stringify({ rate: 0.101, effectiveFrom: '2031-01-02', note: '年度财务审批已完成费率调整' }),
    });
    expect(submittedRateChange.status).toBe(201);
    const submittedRateRequest = await submittedRateChange.json() as { id: string; status: string };
    expect(submittedRateRequest.status).toBe(RateChangeRequestStatus.PENDING_REVIEW);
    const reviewQueue = await request('/api/platform/rate-change-requests', { headers: { Authorization: `Bearer ${finance.token}` } });
    expect(reviewQueue.status).toBe(200);
    expect(await reviewQueue.json()).toEqual(expect.arrayContaining([expect.objectContaining({ id: submittedRateRequest.id, merchantId: merchant.id, merchantBrandName: '花时间花艺', status: RateChangeRequestStatus.PENDING_REVIEW })]));
    expect((await request(`/api/merchants/${merchant.id}/rate-change-requests/${submittedRateRequest.id}/approve`, {
      method: 'POST', headers: { Authorization: `Bearer ${finance.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ note: '同一财务账号不得自审。' }),
    })).status).toBe(403);
    expect((await request(`/api/merchants/${merchant.id}/rate-change-requests/${submittedRateRequest.id}/approve`, {
      method: 'POST', headers: { Authorization: `Bearer ${financeReviewer.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ note: '独立财务复核通过。' }),
    })).status).toBe(201);
    expect((await app.get(DataSource).getRepository(AuditLog).findOneOrFail({ where: { actorId: finance.user.id, action: 'RATE_CHANGE_REQUESTED' } })).actorRole).toBe('PLATFORM_ADMIN:FINANCE');
    expect((await app.get(DataSource).getRepository(AuditLog).findOneOrFail({ where: { actorId: financeReviewer.user.id, action: 'RATE_VERSION_CREATED' } })).actorRole).toBe('PLATFORM_ADMIN:FINANCE');
    const financeWorkQueue = await request('/api/platform/work-queue', { headers: { Authorization: `Bearer ${finance.token}` } });
    expect(financeWorkQueue.status).toBe(200);
    expect(await financeWorkQueue.json()).toEqual(expect.objectContaining({
      totals: expect.objectContaining({ contractsExpiring: 0, salesSuspended: 0, draftPackages: 0, supportFirstResponseOverdue: 0 }),
      contractsExpiring: [], salesSuspended: [], draftPackages: [], supportFirstResponseOverdue: [],
    }));
    expect((await request('/api/platform/work-queue', { headers: { Authorization: `Bearer ${operations.token}` } })).status).toBe(200);
    expect((await request('/api/platform/rate-change-requests', { headers: { Authorization: `Bearer ${operations.token}` } })).status).toBe(403);
    expect((await request(`/api/merchants/${merchant.id}/rates`, { headers: { Authorization: `Bearer ${operations.token}` } })).status).toBe(403);
    expect((await request(`/api/merchants/${merchant.id}/exit-readiness`, { headers: { Authorization: `Bearer ${compliance.token}` } })).status).toBe(200);
    expect((await request(`/api/merchants/${merchant.id}/rates`, { headers: { Authorization: `Bearer ${compliance.token}` } })).status).toBe(403);
    expect((await request('/api/platform/audits', { headers: { Authorization: `Bearer ${security.token}` } })).status).toBe(200);
    expect((await request('/api/platform/audits/integrity', { headers: { Authorization: `Bearer ${security.token}` } })).status).toBe(200);
    expect((await request('/api/platform/health/ready', { headers: { Authorization: `Bearer ${security.token}` } })).status).toBe(200);
    expect((await request('/api/platform/health/ready', { headers: { Authorization: `Bearer ${operations.token}` } })).status).toBe(200);
    expect((await request('/api/platform/health/ready', { headers: { Authorization: `Bearer ${finance.token}` } })).status).toBe(403);
    expect((await request('/api/platform/audits', { headers: { Authorization: `Bearer ${operations.token}` } })).status).toBe(403);
    expect((await request(`/api/merchants/${merchant.id}/stores`, { headers: { Authorization: `Bearer ${finance.token}` } })).status).toBe(403);
    expect((await request(`/api/merchants/${merchant.id}/registration`, { headers: { Authorization: `Bearer ${operations.token}` } })).status).toBe(403);
    expect((await request(`/api/orders?merchantId=${merchant.id}`, { headers: { Authorization: `Bearer ${compliance.token}` } })).status).toBe(403);
    expect((await request(`/api/merchants/${merchant.id}/audits`, { headers: { Authorization: `Bearer ${operations.token}` } })).status).toBe(403);
    expect((await request(`/api/merchants/${merchant.id}/audits`, { headers: { Authorization: `Bearer ${security.token}` } })).status).toBe(200);
    expect((await request(`/api/bills?merchantId=${merchant.id}`, { headers: { Authorization: `Bearer ${operations.token}` } })).status).toBe(403);
    expect((await request(`/api/bills?merchantId=${merchant.id}`, { headers: { Authorization: `Bearer ${finance.token}` } })).status).toBe(200);
  });

  it.skip('keeps legacy billing out of the lifecycle worker before an independently reviewed historical payment confirmation', async () => {
    const platform = await login('platform@demo.local');
    const merchants = await (await request('/api/merchants', { headers: { Authorization: `Bearer ${platform.token}` } })).json() as Array<{ id: string; brandName: string }>;
    const merchant = merchants.find((item) => item.brandName === '花时间花艺')!;
    const bills = app.get(DataSource).getRepository(MonthlyBill);
    const bill = await bills.save({
      merchantId: merchant.id, period: '2020-01', verifiedAmountFen: 3990, serviceFeeFen: 319,
      status: BillStatus.DISPUTE_WINDOW, invoiceNumber: null,
      disputeEndsAt: new Date(Date.now() - 60_000), dueAt: new Date(Date.now() + 86_400_000),
    });
    const firstSweep = await app.get(LifecycleOrchestrationService).runSweep();
    expect(firstSweep.confirmedBills).toBe(0);
    expect((await bills.findOneByOrFail({ id: bill.id })).status).toBe(BillStatus.DISPUTE_WINDOW);
    const firstProgress = await app.get(BillingService).advanceBills();
    expect(firstProgress.confirmed).toBeGreaterThanOrEqual(1);
    expect((await bills.findOneByOrFail({ id: bill.id })).status).toBe(BillStatus.CONFIRMED);
    await bills.update(bill.id, { dueAt: new Date(Date.now() - 60_000) });
    const secondSweep = await app.get(LifecycleOrchestrationService).runSweep();
    expect(secondSweep.overdueBills).toBe(0);
    expect(secondSweep.suspendedForOverdueBills).toBe(0);
    const secondProgress = await app.get(BillingService).advanceBills();
    expect(secondProgress.overdue).toBeGreaterThanOrEqual(1);
    expect((await bills.findOneByOrFail({ id: bill.id })).status).toBe(BillStatus.OVERDUE);
    const merchantAfterOverdue = (await (await request('/api/merchants', { headers: { Authorization: `Bearer ${platform.token}` } })).json() as Array<{ id: string; status: string }>).find((item) => item.id === merchant.id)!;
    expect(merchantAfterOverdue.status).toBe('ACTIVE');
    expect((await request(`/api/merchants/${merchant.id}`, {
      method: 'PATCH', headers: { Authorization: `Bearer ${platform.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'ACTIVE', expectedStatus: 'SALES_SUSPENDED', statusReason: '账单仍逾期，尝试恢复销售。' }),
    })).status).toBe(409);
    const users = app.get(DataSource).getRepository(User);
    const breakGlass = await users.createQueryBuilder('user').addSelect('user.passwordHash').where('user.email = :email', { email: 'platform@demo.local' }).getOneOrFail();
    const reviewerEmail = `bill-payment-reviewer-${Date.now()}-${Math.floor(Math.random() * 100_000)}@demo.local`;
    await users.save({ email: reviewerEmail, name: '收款复核财务', passwordHash: breakGlass.passwordHash, role: UserRole.PLATFORM_ADMIN, platformAccessProfile: PlatformAccessProfile.FINANCE, agencyId: null, merchantId: null, storeIds: null, active: true });
    const reviewer = await login(reviewerEmail);
    const submissionHeaders = { Authorization: `Bearer ${platform.token}`, 'Content-Type': 'application/json', 'Idempotency-Key': 'bill-payment-confirmation-001' };
    const confirmationBody = JSON.stringify({ paymentReference: 'BANK-STATEMENT-DEMO-2020-001', note: '已逐笔核对商家对公流水、账单金额与到账日期。' });
    const submitted = await request(`/api/bills/${bill.id}/payment-confirmation-requests`, {
      method: 'POST', headers: submissionHeaders, body: confirmationBody,
    });
    expect(submitted.status).toBe(201);
    const paymentConfirmation = await submitted.json() as { id: string; status: string; paymentReference: string; idempotencyKey?: string; requestHash?: string };
    expect(paymentConfirmation).toEqual(expect.objectContaining({ status: BillPaymentConfirmationRequestStatus.PENDING_REVIEW, paymentReference: 'BANK-STATEMENT-DEMO-2020-001' }));
    expect(paymentConfirmation).not.toHaveProperty('idempotencyKey');
    expect(paymentConfirmation).not.toHaveProperty('requestHash');
    expect((await bills.findOneByOrFail({ id: bill.id })).status).toBe(BillStatus.OVERDUE);
    const replay = await request(`/api/bills/${bill.id}/payment-confirmation-requests`, { method: 'POST', headers: submissionHeaders, body: confirmationBody });
    expect(replay.status).toBe(201);
    expect((await replay.json() as { id: string }).id).toBe(paymentConfirmation.id);
    expect((await request(`/api/bills/${bill.id}/payment-confirmation-requests`, { method: 'POST', headers: submissionHeaders, body: JSON.stringify({ paymentReference: 'BANK-STATEMENT-DEMO-2020-002', note: '不同内容不可复用请求标识。' }) })).status).toBe(409);
    expect((await request(`/api/bills/${bill.id}/payment-confirmation-requests/${paymentConfirmation.id}/approve`, {
      method: 'POST', headers: { Authorization: `Bearer ${platform.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ note: '申请账号不能自行复核。' }),
    })).status).toBe(403);
    const queue = await request('/api/platform/bill-payment-confirmation-requests', { headers: { Authorization: `Bearer ${reviewer.token}` } });
    expect(queue.status).toBe(200);
    expect(await queue.json()).toEqual(expect.arrayContaining([expect.objectContaining({ id: paymentConfirmation.id, billId: bill.id, merchantBrandName: '花时间花艺', status: BillPaymentConfirmationRequestStatus.PENDING_REVIEW })]));
    const approved = await request(`/api/bills/${bill.id}/payment-confirmation-requests/${paymentConfirmation.id}/approve`, {
      method: 'POST', headers: { Authorization: `Bearer ${reviewer.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ note: '独立复核对账流水、金额与商家主体一致，确认入账。' }),
    });
    expect(approved.status).toBe(201);
    expect(await approved.json()).toEqual(expect.objectContaining({ status: BillPaymentConfirmationRequestStatus.APPROVED }));
    expect(await bills.findOneByOrFail({ id: bill.id })).toEqual(expect.objectContaining({ status: BillStatus.PAID, invoiceStatus: InvoiceStatus.PENDING, invoiceNumber: null, accountingLockedAt: expect.any(Date), accountingLockedBy: reviewer.user.id }));
    const merchantAdmin = await login('merchant@demo.local');
    const merchantBill = ((await (await request(`/api/bills?merchantId=${merchant.id}`, { headers: { Authorization: `Bearer ${merchantAdmin.token}` } })).json()) as Array<{ id: string; paymentConfirmationRequest?: Record<string, unknown> | null }>).find((item) => item.id === bill.id)!;
    expect(merchantBill.paymentConfirmationRequest).toEqual(expect.objectContaining({ status: BillPaymentConfirmationRequestStatus.APPROVED }));
    expect(merchantBill.paymentConfirmationRequest).not.toHaveProperty('paymentReference');
    expect(merchantBill.paymentConfirmationRequest).not.toHaveProperty('note');
    expect((await request(`/api/bills/${bill.id}/paid`, { method: 'POST', headers: { Authorization: `Bearer ${platform.token}`, 'Content-Type': 'application/json' }, body: '{}' })).status).toBe(404);
    expect((await request(`/api/bills/${bill.id}/invoice`, {
      method: 'POST', headers: { Authorization: `Bearer ${platform.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ invoiceStatus: InvoiceStatus.PENDING }),
    })).status).toBe(201);
    expect((await request(`/api/bills/${bill.id}/invoice`, {
      method: 'POST', headers: { Authorization: `Bearer ${platform.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ invoiceStatus: InvoiceStatus.ISSUED }),
    })).status).toBe(400);
    const issued = await request(`/api/bills/${bill.id}/invoice`, {
      method: 'POST', headers: { Authorization: `Bearer ${platform.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ invoiceStatus: InvoiceStatus.ISSUED, invoiceNumber: 'INV-DEMO-2020-002' }),
    });
    expect(issued.status).toBe(201);
    expect(await issued.json()).toEqual(expect.objectContaining({ invoiceStatus: InvoiceStatus.ISSUED, invoiceNumber: 'INV-DEMO-2020-002' }));
    expect((await request(`/api/bills/${bill.id}/invoice`, {
      method: 'POST', headers: { Authorization: `Bearer ${merchantAdmin.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ invoiceStatus: InvoiceStatus.NOT_REQUIRED }),
    })).status).toBe(403);
    const audits = (await (await request(`/api/merchants/${merchant.id}/audits`, { headers: { Authorization: `Bearer ${platform.token}` } })).json() as { items: Array<{ action: string; resourceId: string }> }).items;
    expect(audits).not.toEqual(expect.arrayContaining([expect.objectContaining({ action: 'MERCHANT_SUSPENDED_FOR_OVERDUE_BILL', resourceId: merchant.id })]));
  });

  it.skip('posts, rejects, reverses and balances four-eyes bill adjustments, while refusing locked periods', async () => {
    const platform = await login('platform@demo.local');
    const headers = { Authorization: `Bearer ${platform.token}`, 'Content-Type': 'application/json' };
    const merchants = await (await request('/api/merchants', { headers })).json() as Array<{ id: string; brandName: string }>;
    const merchant = merchants.find((item) => item.brandName === '花时间花艺')!;
    const users = app.get(DataSource).getRepository(User);
    const bills = app.get(DataSource).getRepository(MonthlyBill);
    const ledger = app.get(DataSource).getRepository(SettlementLedgerEntry);
    const adjustments = app.get(DataSource).getRepository(BillAdjustment);
    const breakGlass = await users.createQueryBuilder('user').addSelect('user.passwordHash').where('user.email = :email', { email: 'platform@demo.local' }).getOneOrFail();
    const reviewerEmail = `adjustment-reviewer-${Date.now()}-${Math.floor(Math.random() * 100_000)}@demo.local`;
    await users.save({ email: reviewerEmail, name: '账务调整复核财务', passwordHash: breakGlass.passwordHash, role: UserRole.PLATFORM_ADMIN, platformAccessProfile: PlatformAccessProfile.FINANCE, agencyId: null, merchantId: null, storeIds: null, active: true });
    const reviewer = await login(reviewerEmail);
    const reviewerHeaders = { Authorization: `Bearer ${reviewer.token}`, 'Content-Type': 'application/json' };
    const bill = await bills.save({
      merchantId: merchant.id, period: '2018-11', verifiedAmountFen: 1_000, serviceFeeFen: 80,
      status: BillStatus.CONFIRMED, invoiceNumber: null, disputeEndsAt: new Date(Date.now() - 10 * 86400000), dueAt: new Date(Date.now() + 10 * 86400000),
      accountingLockedAt: null, accountingLockedBy: null, adjustmentVersion: 0,
    });
    await ledger.save({ merchantId: merchant.id, voucherId: randomUUID(), verificationId: randomUUID(), verifiedAmountFen: 1_000, serviceFeeFen: 80, rateSnapshot: '0.0800', entryType: 'VERIFIED', occurredAt: new Date('2018-11-15T12:00:00.000Z') });

    const createBody = JSON.stringify({ verifiedAmountDeltaFen: 100, serviceFeeDeltaFen: 8, reasonCode: 'MANUAL_RECONCILIATION', note: '补录一笔已核销但未进入原始月结的凭证。' });
    const createHeaders = { ...headers, 'Idempotency-Key': 'bill-adjustment-create-001' };
    const createdResponse = await request(`/api/bills/${bill.id}/adjustments`, { method: 'POST', headers: createHeaders, body: createBody });
    expect(createdResponse.status).toBe(201);
    const created = await createdResponse.json() as { id: string; status: string; idempotencyKey?: string; requestHash?: string };
    expect(created).toEqual(expect.objectContaining({ status: AccountingAdjustmentStatus.PENDING_REVIEW }));
    expect(created).not.toHaveProperty('idempotencyKey');
    expect(created).not.toHaveProperty('requestHash');
    expect((await (await request(`/api/bills/${bill.id}/adjustments`, { method: 'POST', headers: createHeaders, body: createBody })).json() as { id: string }).id).toBe(created.id);
    expect((await request(`/api/bills/${bill.id}/adjustments`, { method: 'POST', headers: createHeaders, body: JSON.stringify({ ...JSON.parse(createBody), note: '同一请求键不可复用为不同调整。' }) })).status).toBe(409);
    const listed = await (await request(`/api/bills/${bill.id}/adjustments`, { headers })).json() as Array<{ id: string; idempotencyKey?: string; requestHash?: string }>;
    expect(listed).toEqual(expect.arrayContaining([expect.objectContaining({ id: created.id })]));
    expect(listed.every((item) => !('idempotencyKey' in item) && !('requestHash' in item))).toBe(true);
    expect((await request(`/api/bills/adjustments/${created.id}/approve`, { method: 'POST', headers, body: JSON.stringify({ note: '发起财务账号不得自行复核。' }) })).status).toBe(403);
    const approved = await request(`/api/bills/adjustments/${created.id}/approve`, { method: 'POST', headers: reviewerHeaders, body: JSON.stringify({ note: '已独立核对原始核销记录并批准入账。' }) });
    expect(approved.status).toBe(201);
    expect(await approved.json()).toEqual(expect.objectContaining({ status: AccountingAdjustmentStatus.POSTED }));
    expect(await bills.findOneByOrFail({ id: bill.id })).toEqual(expect.objectContaining({ verifiedAmountFen: 1_100, serviceFeeFen: 88, adjustmentVersion: 1 }));
    expect(await (await request(`/api/bills/${bill.id}/balance-check`, { headers })).json()).toEqual(expect.objectContaining({ balanced: true, differenceVerifiedAmountFen: 0, differenceServiceFeeFen: 0 }));

    const rejectedResponse = await request(`/api/bills/${bill.id}/adjustments`, { method: 'POST', headers: { ...headers, 'Idempotency-Key': 'bill-adjustment-reject-001' }, body: JSON.stringify({ verifiedAmountDeltaFen: 50, serviceFeeDeltaFen: 4, reasonCode: 'DATA_CORRECTION', note: '待驳回的错误录入。' }) });
    expect(rejectedResponse.status).toBe(201);
    const rejected = await rejectedResponse.json() as { id: string };
    expect((await request(`/api/bills/adjustments/${rejected.id}/reject`, { method: 'POST', headers: reviewerHeaders, body: JSON.stringify({ note: '证据不足，驳回本次调整。' }) })).status).toBe(201);
    expect(await bills.findOneByOrFail({ id: bill.id })).toEqual(expect.objectContaining({ verifiedAmountFen: 1_100, serviceFeeFen: 88, adjustmentVersion: 1 }));
    expect(await adjustments.countBy({ id: rejected.id, status: AccountingAdjustmentStatus.REJECTED })).toBe(1);

    const reversalHeaders = { ...reviewerHeaders, 'Idempotency-Key': 'bill-adjustment-reversal-001' };
    const reversalBody = JSON.stringify({ note: '原调整已被后续对账确认，应以不可变冲正抵销。' });
    const reversalResponse = await request(`/api/bills/adjustments/${created.id}/reversal`, { method: 'POST', headers: reversalHeaders, body: reversalBody });
    expect(reversalResponse.status).toBe(201);
    const reversal = await reversalResponse.json() as { id: string; status: string };
    expect(reversal.status).toBe(AccountingAdjustmentStatus.PENDING_REVIEW);
    expect((await (await request(`/api/bills/adjustments/${created.id}/reversal`, { method: 'POST', headers: reversalHeaders, body: reversalBody })).json() as { id: string }).id).toBe(reversal.id);
    expect((await request(`/api/bills/adjustments/${reversal.id}/approve`, { method: 'POST', headers, body: JSON.stringify({ note: '独立复核冲正金额与原调整一致。' }) })).status).toBe(201);
    expect(await bills.findOneByOrFail({ id: bill.id })).toEqual(expect.objectContaining({ verifiedAmountFen: 1_000, serviceFeeFen: 80, adjustmentVersion: 2 }));
    expect(await adjustments.countBy({ id: created.id, status: AccountingAdjustmentStatus.REVERSED })).toBe(1);
    expect(await (await request(`/api/bills/${bill.id}/balance-check`, { headers })).json()).toEqual(expect.objectContaining({ balanced: true }));

    await bills.update(bill.id, { status: BillStatus.PAID, accountingLockedAt: new Date(), accountingLockedBy: reviewer.user.id });
    expect((await request(`/api/bills/${bill.id}/adjustments`, { method: 'POST', headers: { ...headers, 'Idempotency-Key': 'bill-adjustment-locked-001' }, body: JSON.stringify({ verifiedAmountDeltaFen: 10, serviceFeeDeltaFen: 1, reasonCode: 'POST_LOCK', note: '锁账后不应允许直接调整。' }) })).status).toBe(409);
  });

  it.skip('generates only ended billing periods once and audits the platform action', async () => {
    const platform = await login('platform@demo.local');
    const headers = { Authorization: `Bearer ${platform.token}`, 'Content-Type': 'application/json' };
    const merchant = (await (await request('/api/merchants', { headers })).json() as Array<{ id: string; brandName: string }>).find((item) => item.brandName === '花时间花艺')!;
    const period = '2001-02';
    const ledgerRefs = Array.from({ length: 5 }, () => ({ voucherId: randomUUID(), verificationId: randomUUID() }));
    await app.get(DataSource).getRepository(SettlementLedgerEntry).save({
      merchantId: merchant.id, ...ledgerRefs[0], verifiedAmountFen: 4990, serviceFeeFen: 399,
      rateSnapshot: '0.0800', entryType: 'VERIFIED', occurredAt: new Date('2001-02-15T12:00:00.000Z'),
    });
    await app.get(DataSource).getRepository(SettlementLedgerEntry).save([
      { merchantId: merchant.id, ...ledgerRefs[1], verifiedAmountFen: 1000, serviceFeeFen: 80, rateSnapshot: '0.0800', entryType: 'VERIFIED', occurredAt: new Date('2001-01-31T15:59:59.999Z') },
      { merchantId: merchant.id, ...ledgerRefs[2], verifiedAmountFen: 101, serviceFeeFen: 8, rateSnapshot: '0.0800', entryType: 'VERIFIED', occurredAt: new Date('2001-01-31T16:00:00.000Z') },
      { merchantId: merchant.id, ...ledgerRefs[3], verifiedAmountFen: 202, serviceFeeFen: 16, rateSnapshot: '0.0800', entryType: 'VERIFIED', occurredAt: new Date('2001-02-28T15:59:59.999Z') },
      { merchantId: merchant.id, ...ledgerRefs[4], verifiedAmountFen: 2000, serviceFeeFen: 160, rateSnapshot: '0.0800', entryType: 'VERIFIED', occurredAt: new Date('2001-02-28T16:00:00.000Z') },
    ]);
    expect((await request('/api/bills/generate', { method: 'POST', headers, body: JSON.stringify({ period: '2099-01' }) })).status).toBe(400);
    const idempotencyKey = `bill-generation-${Date.now()}-001`;
    const [first, second] = await Promise.all([
      request('/api/bills/generate', { method: 'POST', headers: { ...headers, 'Idempotency-Key': idempotencyKey }, body: JSON.stringify({ period }) }),
      request('/api/bills/generate', { method: 'POST', headers: { ...headers, 'Idempotency-Key': idempotencyKey }, body: JSON.stringify({ period }) }),
    ]);
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    const firstBill = (await first.json() as Array<{ id: string; merchantId: string; period: string; verifiedAmountFen: number; serviceFeeFen: number; disputeEndsAt: string; dueAt: string }>).find((item) => item.merchantId === merchant.id)!;
    const secondPayload = await second.json() as Array<{ id: string }>;
    const secondBill = secondPayload.find((item) => item.id === firstBill.id)!;
    expect(secondBill).toBeDefined();
    expect(firstBill).toEqual(expect.objectContaining({ period, verifiedAmountFen: 5293, serviceFeeFen: 423 }));
    expect(new Date(firstBill.dueAt).getTime()).toBeGreaterThan(new Date(firstBill.disputeEndsAt).getTime() + 4 * 86400000);
    const bills = await app.get(DataSource).getRepository(MonthlyBill).findBy({ merchantId: merchant.id, period });
    expect(bills).toHaveLength(1);
    expect((await request('/api/bills/generate', {
      method: 'POST', headers: { ...headers, 'Idempotency-Key': idempotencyKey }, body: JSON.stringify({ period: '2001-03' }),
    })).status).toBe(409);
    const commands = await app.get(DataSource).getRepository(MonthlyBillGenerationCommand).createQueryBuilder('command')
      .addSelect(['command.idempotencyKey', 'command.requestHash'])
      .where('command.requestedBy = :requestedBy', { requestedBy: platform.user.id })
      .getMany();
    expect(commands).toEqual(expect.arrayContaining([expect.objectContaining({ period, idempotencyKey, requestHash: expect.stringMatching(/^[a-f0-9]{64}$/) })]));
    expect(await app.get(DataSource).getRepository(AuditLog).countBy({ action: 'MONTHLY_BILL_GENERATED', resourceId: firstBill.id })).toBe(1);
    expect((await request('/api/bills/generate', { method: 'POST', headers, body: JSON.stringify({ period }) })).status).toBe(201);
    const audits = (await (await request(`/api/merchants/${merchant.id}/audits`, { headers })).json() as { items: Array<{ action: string; resourceId: string }> }).items;
    expect(audits).toEqual(expect.arrayContaining([expect.objectContaining({ action: 'MONTHLY_BILL_GENERATED', resourceId: firstBill.id })]));
  });

  it('does not expose customer identity, payment references, or fee snapshots in operational transaction views', async () => {
    const platform = await login('platform@demo.local');
    const merchants = await (await request('/api/merchants', { headers: { Authorization: `Bearer ${platform.token}` } })).json() as Array<{ id: string; brandName: string }>;
    const merchant = merchants.find((item) => item.brandName === '花时间花艺')!;
    const merchantAdmin = await login('merchant@demo.local');
    const merchantHeaders = { Authorization: `Bearer ${merchantAdmin.token}` };
    const staffUser = (await (await request(`/api/merchants/${merchant.id}/users`, { headers: merchantHeaders })).json() as Array<{ email: string; storeIds: string[] }>).find((user) => user.email === 'staff@demo.local')!;
    const customerHeaders = await customerSession();
    const storefront = await (await request(`/api/public/merchants/${merchant.id}`)).json() as { stores: Array<{ id: string }> };
    const deals = await (await request(`/api/public/merchants/${merchant.id}/packages`)).json() as Array<{ id: string; storeIds: string[] }>;
    const deal = deals.find((candidate) => candidate.storeIds.includes(staffUser.storeIds[0]))!;
    const store = storefront.stores.find((candidate) => deal.storeIds.includes(candidate.id))!;
    const orderResponse = await request(`/api/public/merchants/${merchant.id}/orders`, {
      method: 'POST', headers: customerHeaders, body: JSON.stringify({ packageId: deal.id, storeId: store.id, quantity: 1 }),
    });
    expect(orderResponse.status).toBe(201);
    const order = await orderResponse.json() as { id: string };
    const paidResponse = await request(`/api/public/orders/${order.id}/mock-confirm`, { method: 'POST', headers: customerHeaders });
    expect(paidResponse.status).toBe(201);
    const paid = await paidResponse.json() as { vouchers: Array<{ id: string }> };
    const voucherId = paid.vouchers[0].id;
    const orderView = (await (await request(`/api/orders?merchantId=${merchant.id}`, { headers: merchantHeaders })).json() as { items: Array<Record<string, unknown>> }).items.find((record) => record.id === order.id)!;
    const voucherView = (await (await request(`/api/vouchers?merchantId=${merchant.id}`, { headers: merchantHeaders })).json() as { items: Array<Record<string, unknown>> }).items.find((record) => record.id === voucherId)!;
    expect(orderView).not.toHaveProperty('customerId');
    expect(orderView).not.toHaveProperty('paymentReference');
    expect(orderView).not.toHaveProperty('commissionRateSnapshot');
    expect(voucherView).not.toHaveProperty('customerId');
    expect(voucherView).not.toHaveProperty('commissionRateSnapshot');

    const code = await (await request(`/api/public/vouchers/${voucherId}/dynamic-code`, { method: 'POST', headers: customerHeaders })).json() as { token: string };
    const staff = await login('staff@demo.local');
    const preview = await (await request('/api/verification/preview', {
      method: 'POST', headers: { Authorization: `Bearer ${staff.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ token: code.token, workingStoreId: store.id }),
    })).json() as { voucher: Record<string, unknown>; canVerify: boolean };
    expect(preview.voucher).not.toHaveProperty('customerId');
    expect(preview.voucher).not.toHaveProperty('commissionRateSnapshot');
    expect(preview.voucher).toEqual(expect.objectContaining({ storeId: store.id, storeName: expect.any(String) }));
    expect(preview.canVerify).toBe(true);
    await app.get(DataSource).getRepository(Voucher).update(voucherId, { validFrom: new Date('2099-01-01T00:00:00Z') });
    const notStartedPreview = await request('/api/verification/preview', {
      method: 'POST', headers: { Authorization: `Bearer ${staff.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ token: code.token, workingStoreId: store.id }),
    });
    expect(notStartedPreview.status).toBe(201);
    expect((await notStartedPreview.json() as { canVerify: boolean }).canVerify).toBe(false);
  });

  it('records a correlatable audit trail with actor role and request metadata', async () => {
    const platform = await login('platform@demo.local');
    const merchants = await (await request('/api/merchants', { headers: { Authorization: `Bearer ${platform.token}` } })).json() as Array<{ id: string; brandName: string }>;
    const merchant = merchants.find((item) => item.brandName === '花时间花艺')!;
    const requestId = 'audit-test-request-20260718';
    const update = await request(`/api/merchants/${merchant.id}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${platform.token}`, 'Content-Type': 'application/json', 'X-Request-Id': requestId, 'User-Agent': 'audit-integration-test/1.0' },
      body: JSON.stringify({ primaryColor: '#123456' }),
    });
    expect(update.status).toBe(200);
    expect(update.headers.get('x-request-id')).toBe(requestId);
    const auditPage = await (await request(`/api/merchants/${merchant.id}/audits?page=1&pageSize=1`, { headers: { Authorization: `Bearer ${platform.token}` } })).json() as { items: Array<Record<string, unknown>>; page: number; pageSize: number; total: number };
    expect(auditPage).toEqual(expect.objectContaining({ page: 1, pageSize: 1, total: expect.any(Number) }));
    expect(auditPage.items).toHaveLength(1);
    const record = auditPage.items.find((item) => item.requestId === requestId)!;
    expect(record).toEqual(expect.objectContaining({ actorId: platform.user.id, actorRole: 'PLATFORM_ADMIN:SYSTEM_ADMIN', action: 'MERCHANT_UPDATED', userAgent: 'audit-integration-test/1.0' }));
    expect(record.ipAddress).toBeTruthy();
    expect(record).not.toHaveProperty('before');
    expect(record).not.toHaveProperty('after');
    expect((await request(`/api/merchants/${merchant.id}/audits?pageSize=101`, { headers: { Authorization: `Bearer ${platform.token}` } })).status).toBe(400);
  });

  it('restores a package configuration from audited history without changing sold quantity', async () => {
    const platform = await login('platform@demo.local');
    const merchant = (await (await request('/api/merchants', { headers: { Authorization: `Bearer ${platform.token}` } })).json() as Array<{ id: string; brandName: string }>).find((item) => item.brandName === '花时间花艺')!;
    const merchantAdmin = await login('merchant@demo.local');
    const headers = { Authorization: `Bearer ${merchantAdmin.token}`, 'Content-Type': 'application/json' };
    const source = (await (await request(`/api/merchants/${merchant.id}/packages`, { headers })).json() as Array<{ id: string; version: number; title: string; description: string; priceFen: number; saleLimit: number; soldCount: number; perCustomerLimit: number; storeIds: string[]; validFrom: string; validTo: string; status: string }>).find((item) => item.status === 'ON_SALE')!;
    const payload = (item: typeof source, changes: Partial<typeof source>) => ({
      id: item.id, expectedVersion: item.version, title: item.title, description: item.description, priceFen: item.priceFen,
      saleLimit: item.saleLimit, perCustomerLimit: item.perCustomerLimit, storeIds: item.storeIds,
      validFrom: String(item.validFrom).slice(0, 10), validTo: String(item.validTo).slice(0, 10), status: item.status,
      ...changes,
    });
    const revised = await request(`/api/merchants/${merchant.id}/packages`, {
      method: 'POST', headers,
      body: JSON.stringify(payload(source, { title: '可恢复套餐版本', description: '应被恢复的套餐配置', priceFen: source.priceFen + 111 })),
    });
    expect(revised.status).toBe(201);
    const versionToRestore = await revised.json() as typeof source & { version: number };
    const later = await request(`/api/merchants/${merchant.id}/packages`, {
      method: 'POST', headers,
      body: JSON.stringify(payload(versionToRestore, { title: '不应保留的套餐版本', description: '后续错误配置', priceFen: versionToRestore.priceFen + 222 })),
    });
    expect(later.status).toBe(201);
    const latest = await later.json() as typeof source & { version: number };
    const stale = await request(`/api/merchants/${merchant.id}/packages`, {
      method: 'POST', headers,
      body: JSON.stringify(payload(source, { title: '不应覆盖的新版本' })),
    });
    expect(stale.status).toBe(409);
    const versions = await (await request(`/api/merchants/${merchant.id}/packages/${source.id}/versions`, { headers })).json() as Array<{ auditId: string; version: number; title: string; priceFen: number; action: string }>;
    const historical = versions.find((item) => item.version === versionToRestore.version && item.title === versionToRestore.title)!;
    expect(historical).toEqual(expect.objectContaining({ priceFen: versionToRestore.priceFen, action: 'PACKAGE_UPDATED' }));
    const restored = await request(`/api/merchants/${merchant.id}/packages/${source.id}/versions/${historical.auditId}/restore`, { method: 'POST', headers, body: JSON.stringify({ expectedVersion: latest.version }) });
    expect(restored.status).toBe(201);
    expect(await restored.json()).toEqual(expect.objectContaining({ title: versionToRestore.title, description: versionToRestore.description, priceFen: versionToRestore.priceFen, soldCount: source.soldCount, version: latest.version + 1 }));

    const after = await (await request(`/api/merchants/${merchant.id}/packages/${source.id}/versions`, { headers })).json() as Array<{ action: string; version: number; title: string }>;
    expect(after[0]).toEqual(expect.objectContaining({ action: 'PACKAGE_VERSION_RESTORED', version: latest.version + 1, title: versionToRestore.title }));
    const staff = await login('staff@demo.local');
    expect((await request(`/api/merchants/${merchant.id}/packages/${source.id}/versions`, { headers: { Authorization: `Bearer ${staff.token}` } })).status).toBe(403);
  });

  it('throttles repeated login failures without disclosing account state', async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await request('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'throttle-test@demo.local', password: 'wrong-password' }) });
      expect(response.status).toBe(401);
    }
    const throttle = (await app.get(DataSource).getRepository(LoginThrottle).find()).find((record) => record.failureCount === 5);
    expect(throttle).toEqual(expect.objectContaining({ failureCount: 5 }));
    expect(throttle?.throttleKey).toMatch(/^[a-f0-9]{64}$/);
    const blocked = await request('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'throttle-test@demo.local', password: 'wrong-password' }) });
    expect(blocked.status).toBe(429);
    const blockedBody = await blocked.json() as { retryAfterSeconds: number };
    expect(blockedBody).toEqual(expect.objectContaining({ retryAfterSeconds: expect.any(Number) }));
    expect(blocked.headers.get('retry-after')).toBe(String(blockedBody.retryAfterSeconds));
  });

  it('keeps login throttling correct across concurrent failed requests', async () => {
    const responses = await Promise.all(Array.from({ length: 10 }, () => request('/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'parallel-throttle@demo.local', password: 'wrong-password' }),
    })));
    expect(responses.every((response) => response.status === 401)).toBe(true);
    const throttle = (await app.get(DataSource).getRepository(LoginThrottle).find()).find((record) => record.failureCount === 10 && record.blockedUntil !== null);
    expect(throttle).toEqual(expect.objectContaining({ failureCount: 10 }));
    const blocked = await request('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'parallel-throttle@demo.local', password: 'wrong-password' }) });
    expect(blocked.status).toBe(429);
  });

  it('purges expired login throttles in bounded batches without removing active blocks', async () => {
    const auth = app.get(AuthService);
    const throttles = app.get(DataSource).getRepository(LoginThrottle);
    await throttles.clear();
    const suffix = Date.now().toString(36);
    const expiredFirst = `expired-login-throttle-first-${suffix}`;
    const expiredSecond = `expired-login-throttle-second-${suffix}`;
    const active = `active-login-throttle-${suffix}`;
    await throttles.save([
      { throttleKey: expiredFirst, failureCount: 1, resetAt: new Date(Date.now() - 120_000), blockedUntil: null },
      { throttleKey: expiredSecond, failureCount: 2, resetAt: new Date(Date.now() - 60_000), blockedUntil: null },
      { throttleKey: active, failureCount: 5, resetAt: new Date(Date.now() + 60_000), blockedUntil: new Date(Date.now() + 60_000) },
    ]);
    expect(await auth.purgeExpiredLoginThrottles(1)).toBe(1);
    expect(await throttles.count()).toBe(2);
    expect(await auth.purgeExpiredLoginThrottles(1_000)).toBe(1);
    expect(await throttles.findOneBy({ throttleKey: active })).toEqual(expect.objectContaining({ blockedUntil: expect.any(Date) }));
  });

  it('limits password spraying from one source without retaining the raw IP address', async () => {
    const auth = app.get(AuthService);
    const ipAddress = '198.51.100.42';
    const context = { ipAddress, userAgent: 'integration-test' };
    for (let index = 0; index < 20; index += 1) {
      await expect(auth.login(`password-spray-${index}@demo.local`, 'wrong-password', context)).rejects.toMatchObject({ status: 401 });
    }
    await expect(auth.login('password-spray-over-limit@demo.local', 'wrong-password', context)).rejects.toMatchObject({ status: 429 });
    const throttle = (await app.get(DataSource).getRepository(LoginThrottle).find()).find((record) => record.failureCount === 20);
    expect(throttle).toEqual(expect.objectContaining({ blockedUntil: expect.any(Date) }));
    expect(throttle?.throttleKey).toMatch(/^[a-f0-9]{64}$/);
    expect(throttle?.throttleKey).not.toContain(ipAddress);
  });

  it('limits high-cost public actions with hashed keys and cleans up expired throttle records', async () => {
    const throttles = app.get(RequestThrottleService);
    const identity = 'customer-private-identity-for-rate-limit';
    await throttles.consume('test-public-action', identity, 2, 60_000);
    await throttles.consume('test-public-action', identity, 2, 60_000);
    await expect(throttles.consume('test-public-action', identity, 2, 60_000)).rejects.toMatchObject({ status: 429 });
    const record = (await app.get(DataSource).getRepository(RequestThrottle).find()).find((item) => item.hitCount === 3)!;
    expect(record.throttleKey).toMatch(/^[a-f0-9]{64}$/);
    expect(record.throttleKey).not.toContain(identity);
    await app.get(DataSource).getRepository(RequestThrottle).save({ throttleKey: 'a'.repeat(64), hitCount: 1, resetAt: new Date(Date.now() - 60_000) });
    expect(await throttles.purgeExpired(0)).toBeGreaterThanOrEqual(1);
  });

  it('atomically applies request throttle capacity during concurrent requests', async () => {
    const throttles = app.get(RequestThrottleService);
    const results = await Promise.allSettled(Array.from({ length: 10 }, () => throttles.consume('test-public-concurrent-action', 'concurrent-customer-identity', 3, 60_000)));
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(3);
    const rejected = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
    expect(rejected).toHaveLength(7);
    rejected.forEach((result) => expect(result.reason).toMatchObject({ status: 429 }));
    expect((await app.get(DataSource).getRepository(RequestThrottle).find()).find((record) => record.hitCount === 10)).toEqual(expect.objectContaining({ resetAt: expect.any(Date) }));
  });

  it('enforces one password-strength policy across self-service, account creation, and supervisor reset', async () => {
    const platform = await login('platform@demo.local');
    const headers = { Authorization: `Bearer ${platform.token}`, 'Content-Type': 'application/json' };
    const weakPassword = 'alllowercase123';
    expect((await request('/api/auth/password', {
      method: 'POST', headers, body: JSON.stringify({ currentPassword: 'Demo123456', newPassword: weakPassword }),
    })).status).toBe(400);
    expect((await request('/api/auth/me', { headers: { Authorization: `Bearer ${platform.token}` } })).status).toBe(200);
    expect((await request('/api/agencies', {
      method: 'POST', headers, body: JSON.stringify({ name: `弱密码测试代理-${Date.now()}`, managerName: '弱密码测试', managerEmail: `weak-password-${Date.now()}@demo.local`, password: weakPassword }),
    })).status).toBe(400);
    const merchant = (await (await request('/api/merchants', { headers })).json() as Array<{ id: string; brandName: string }>).find((item) => item.brandName === '花时间花艺')!;
    const merchantUsers = await (await request(`/api/merchants/${merchant.id}/users`, { headers })).json() as Array<{ id: string; role: string }>;
    const merchantAdmin = merchantUsers.find((record) => record.role === 'MERCHANT_ADMIN')!;
    expect((await request(`/api/auth/users/${merchantAdmin.id}/password-reset`, {
      method: 'POST', headers, body: JSON.stringify({ newPassword: weakPassword }),
    })).status).toBe(400);
  });

  it('cryptographically separates operator and customer session tokens', async () => {
    const platform = await login('platform@demo.local');
    const operatorClaims = jwt.decode(platform.token) as jwt.JwtPayload;
    expect(operatorClaims).toEqual(expect.objectContaining({ iss: TOKEN_ISSUER, aud: OPERATOR_TOKEN_AUDIENCE }));
    const customerHeaders = await customerSession();

    expect((await request('/api/public/vouchers', { headers: { Authorization: `Bearer ${platform.token}` } })).status).toBe(401);
    expect((await request('/api/auth/me', { headers: customerHeaders })).status).toBe(401);

    const wrongIssuerOperatorToken = jwt.sign(
      { sub: operatorClaims.sub, sid: operatorClaims.sid, sv: operatorClaims.sv },
      process.env.JWT_SECRET || 'dev-jwt-secret',
      { issuer: 'another-service', audience: OPERATOR_TOKEN_AUDIENCE, expiresIn: '1h' },
    );
    expect((await request('/api/auth/me', { headers: { Authorization: `Bearer ${wrongIssuerOperatorToken}` } })).status).toBe(401);

    const wrongIssuerCustomerToken = jwt.sign(
      { sub: 'isolated-customer', scope: 'CUSTOMER' },
      process.env.JWT_SECRET || 'dev-jwt-secret',
      { issuer: 'another-service', audience: CUSTOMER_TOKEN_AUDIENCE, expiresIn: '1h' },
    );
    expect((await request('/api/public/vouchers', { headers: { Authorization: `Bearer ${wrongIssuerCustomerToken}` } })).status).toBe(401);
  });

  it('records devices, permits per-device logout, and never exposes another users sessions', async () => {
    const first = await login('platform@demo.local', 'Demo123456', 'session-test-device-a');
    const second = await login('platform@demo.local', 'Demo123456', 'session-test-device-b');
    const firstHeaders = { Authorization: `Bearer ${first.token}` };
    const sessions = await (await request('/api/auth/sessions', { headers: firstHeaders })).json() as Array<{ id: string; userAgent: string; current: boolean; userId?: string; sessionVersion?: number }>;
    const secondSession = sessions.find((session) => session.userAgent === 'session-test-device-b');
    expect(sessions.some((session) => session.userAgent === 'session-test-device-a' && session.current)).toBe(true);
    expect(secondSession).toBeDefined();
    expect(sessions.every((session) => !('userId' in session) && !('sessionVersion' in session))).toBe(true);

    const revoke = await request(`/api/auth/sessions/${secondSession!.id}`, { method: 'DELETE', headers: firstHeaders });
    expect(revoke.status).toBe(200);
    expect((await request('/api/auth/me', { headers: { Authorization: `Bearer ${second.token}` } })).status).toBe(401);
    expect((await request('/api/auth/me', { headers: firstHeaders })).status).toBe(200);
  });

  it('revokes other devices and the current device through server-side logout endpoints', async () => {
    const current = await login('agency@demo.local', 'Demo123456', 'logout-current-device');
    const other = await login('agency@demo.local', 'Demo123456', 'logout-other-device');
    const currentHeaders = { Authorization: `Bearer ${current.token}` };
    expect((await request('/api/auth/logout-others', { method: 'POST', headers: currentHeaders })).status).toBe(201);
    expect((await request('/api/auth/me', { headers: { Authorization: `Bearer ${other.token}` } })).status).toBe(401);
    expect((await request('/api/auth/me', { headers: currentHeaders })).status).toBe(200);
    expect((await request('/api/auth/logout', { method: 'POST', headers: currentHeaders })).status).toBe(201);
    expect((await request('/api/auth/me', { headers: currentHeaders })).status).toBe(401);
  });

  it('changes an accounts own password only after current-password verification and revokes every device', async () => {
    const platform = await login('platform@demo.local');
    const create = await request('/api/agencies', {
      method: 'POST', headers: { Authorization: `Bearer ${platform.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '自助改密验证代理', managerName: '改密管理员', managerEmail: 'self-password-change@demo.local', password: 'InitialPassword123' }),
    });
    expect(create.status).toBe(201);
    const createdAgency = await create.json() as { id: string };
    const first = await login('self-password-change@demo.local', 'InitialPassword123', 'self-password-device-a');
    const second = await login('self-password-change@demo.local', 'InitialPassword123', 'self-password-device-b');
    const firstHeaders = { Authorization: `Bearer ${first.token}`, 'Content-Type': 'application/json' };
    expect((await request('/api/auth/password', {
      method: 'POST', headers: firstHeaders, body: JSON.stringify({ currentPassword: 'wrong-current-password', newPassword: 'SelfPassword456' }),
    })).status).toBe(401);
    const changed = await request('/api/auth/password', {
      method: 'POST', headers: firstHeaders, body: JSON.stringify({ currentPassword: 'InitialPassword123', newPassword: 'SelfPassword456' }),
    });
    expect(changed.status).toBe(201);
    expect(await changed.json()).toEqual({ ok: true });
    expect((await request('/api/auth/me', { headers: { Authorization: `Bearer ${first.token}` } })).status).toBe(401);
    expect((await request('/api/auth/me', { headers: { Authorization: `Bearer ${second.token}` } })).status).toBe(401);
    expect((await request('/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'self-password-change@demo.local', password: 'InitialPassword123' }),
    })).status).toBe(401);
    await expect(login('self-password-change@demo.local', 'SelfPassword456', 'self-password-device-new')).resolves.toEqual(expect.objectContaining({ user: expect.objectContaining({ email: 'self-password-change@demo.local' }) }));
    const agencyAudit = await app.get(DataSource).getRepository(AuditLog).findOneByOrFail({ action: 'AGENCY_CREATED', resourceId: createdAgency.id });
    expect(agencyAudit).toEqual(expect.objectContaining({ actorId: platform.user.id, merchantId: null, after: expect.objectContaining({ name: '自助改密验证代理' }) }));
    const passwordAudit = await app.get(DataSource).getRepository(AuditLog).findOneByOrFail({ action: 'USER_PASSWORD_CHANGED', resourceId: first.user.id });
    expect(passwordAudit).toEqual(expect.objectContaining({ actorId: first.user.id, merchantId: null, after: expect.objectContaining({ sessionsInvalidated: true }) }));
    expect(JSON.stringify(passwordAudit)).not.toContain('SelfPassword456');
  });

  it('invalidates every existing staff session after a password reset or deactivation', async () => {
    const platform = await login('platform@demo.local');
    const merchants = await (await request('/api/merchants', { headers: { Authorization: `Bearer ${platform.token}` } })).json() as Array<{ id: string; brandName: string }>;
    const merchant = merchants.find((item) => item.brandName === '花时间花艺')!;
    const staffFirst = await login('staff@demo.local', 'Demo123456', 'staff-password-reset-a');
    const staffSecond = await login('staff@demo.local', 'Demo123456', 'staff-password-reset-b');
    const merchantAdmin = await login('merchant@demo.local');
    const users = await (await request(`/api/merchants/${merchant.id}/users`, { headers: { Authorization: `Bearer ${merchantAdmin.token}` } })).json() as Array<{ id: string; email: string; name: string; role: string; storeIds: string[] }>;
    const staff = users.find((user) => user.role === 'STORE_STAFF')!;

    const reset = await request(`/api/merchants/${merchant.id}/staff`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${merchantAdmin.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: staff.id, email: staff.email, name: staff.name, storeIds: staff.storeIds, password: 'NewDemoPassword123' }),
    });
    expect(reset.status).toBe(201);
    const passwordResetAudit = await app.get(DataSource).getRepository(AuditLog).findOneByOrFail({ merchantId: merchant.id, action: 'STAFF_UPDATED', resourceId: staff.id });
    expect(passwordResetAudit.after).toEqual(expect.objectContaining({ passwordReset: true }));
    expect(JSON.stringify(passwordResetAudit)).not.toContain('NewDemoPassword123');
    expect((await request('/api/auth/me', { headers: { Authorization: `Bearer ${staffFirst.token}` } })).status).toBe(401);
    expect((await request('/api/auth/me', { headers: { Authorization: `Bearer ${staffSecond.token}` } })).status).toBe(401);

    const currentStaff = await login('staff@demo.local', 'NewDemoPassword123', 'staff-deactivation');
    const disabled = await request(`/api/merchants/${merchant.id}/staff/${staff.id}/active`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${merchantAdmin.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ active: false }),
    });
    expect(disabled.status).toBe(201);
    expect((await request('/api/auth/me', { headers: { Authorization: `Bearer ${currentStaff.token}` } })).status).toBe(401);
  });

  it('deduplicates concurrent staff activation commands without repeatedly revoking sessions', async () => {
    const platform = await login('platform@demo.local');
    const headers = { Authorization: `Bearer ${platform.token}`, 'Content-Type': 'application/json' };
    const merchant = (await (await request('/api/merchants', { headers })).json() as Array<{ id: string; agencyId: string; brandName: string }>).find((item) => item.brandName === '花时间花艺')!;
    const staff = await app.get(DataSource).getRepository(User).save({
      email: `staff-idempotency-${Date.now()}-${Math.floor(Math.random() * 100_000)}@demo.local`, name: '员工启停幂等回归', passwordHash: 'not-used-by-this-test', role: UserRole.STORE_STAFF,
      agencyId: merchant.agencyId, merchantId: merchant.id, storeIds: [], active: true, sessionVersion: 7, platformAccessProfile: null,
    });
    const idempotencyKey = `staff-active-${Date.now()}-001`;
    const [first, second] = await Promise.all([
      request(`/api/merchants/${merchant.id}/staff/${staff.id}/active`, { method: 'POST', headers: { ...headers, 'Idempotency-Key': idempotencyKey }, body: JSON.stringify({ active: false }) }),
      request(`/api/merchants/${merchant.id}/staff/${staff.id}/active`, { method: 'POST', headers: { ...headers, 'Idempotency-Key': idempotencyKey }, body: JSON.stringify({ active: false }) }),
    ]);
    expect([first.status, second.status]).toEqual([201, 201]);
    const [firstStaff, secondStaff] = await Promise.all([
      first.json() as Promise<Record<string, unknown>>,
      second.json() as Promise<Record<string, unknown>>,
    ]);
    expect(firstStaff).toEqual(expect.objectContaining({ id: staff.id, active: false }));
    expect(secondStaff).toEqual(expect.objectContaining({ id: staff.id, active: false }));
    expect(firstStaff).not.toHaveProperty('idempotencyKey');
    expect(secondStaff).not.toHaveProperty('requestHash');
    expect((await app.get(DataSource).getRepository(User).findOneByOrFail({ id: staff.id })).sessionVersion).toBe(8);
    expect((await request(`/api/merchants/${merchant.id}/staff/${staff.id}/active`, {
      method: 'POST', headers: { ...headers, 'Idempotency-Key': idempotencyKey }, body: JSON.stringify({ active: true }),
    })).status).toBe(409);
    const commands = await app.get(DataSource).getRepository(StaffActiveCommand).createQueryBuilder('command')
      .addSelect(['command.idempotencyKey', 'command.requestHash'])
      .where('command.staffId = :staffId AND command.requestedBy = :requestedBy', { staffId: staff.id, requestedBy: platform.user.id })
      .getMany();
    expect(commands).toHaveLength(1);
    expect(commands[0]).toEqual(expect.objectContaining({ active: false, idempotencyKey, requestHash: expect.stringMatching(/^[a-f0-9]{64}$/) }));
    expect(await app.get(DataSource).getRepository(AuditLog).countBy({ action: 'STAFF_DISABLED', resourceId: staff.id })).toBe(1);
    const legacyRetry = await request(`/api/merchants/${merchant.id}/staff/${staff.id}/active`, {
      method: 'POST', headers, body: JSON.stringify({ active: true }),
    });
    expect(legacyRetry.status).toBe(201);
    expect(await legacyRetry.json()).toEqual(expect.objectContaining({ id: staff.id, active: true }));
    expect((await app.get(DataSource).getRepository(User).findOneByOrFail({ id: staff.id })).sessionVersion).toBe(9);
  });

  it('allows only upstream roles to reset managed account passwords and invalidates all sessions', async () => {
    const platform = await login('platform@demo.local');
    const platformHeaders = { Authorization: `Bearer ${platform.token}`, 'Content-Type': 'application/json' };
    const agencyResponse = await request('/api/agencies', {
      method: 'POST', headers: platformHeaders,
      body: JSON.stringify({ name: '账号救援测试代理', managerName: '代理救援管理员', managerEmail: 'managed-reset-agency@demo.local', password: 'AgencyInitialPassword123' }),
    });
    expect(agencyResponse.status).toBe(201);
    const agency = await agencyResponse.json() as { id: string };
    const agencyFirst = await login('managed-reset-agency@demo.local', 'AgencyInitialPassword123', 'managed-reset-agency-device');

    const merchantResponse = await request('/api/merchants', {
      method: 'POST', headers: platformHeaders,
      body: JSON.stringify({ agencyId: agency.id, legalName: '账号救援测试商家主体', brandName: '账号救援测试商家', adminName: '商家救援管理员', adminEmail: 'managed-reset-merchant@demo.local', adminPassword: 'MerchantInitialPassword123' }),
    });
    expect(merchantResponse.status).toBe(201);
    const merchant = await merchantResponse.json() as { id: string };
    const merchantFirst = await login('managed-reset-merchant@demo.local', 'MerchantInitialPassword123', 'managed-reset-merchant-device');

    const resetAgency = await request(`/api/auth/users/${agencyFirst.user.id}/password-reset`, {
      method: 'POST', headers: platformHeaders, body: JSON.stringify({ newPassword: 'AgencyReplacementPassword456' }),
    });
    expect(resetAgency.status).toBe(201);
    expect((await request('/api/auth/me', { headers: { Authorization: `Bearer ${agencyFirst.token}` } })).status).toBe(401);
    const agencyAfterReset = await login('managed-reset-agency@demo.local', 'AgencyReplacementPassword456', 'managed-reset-agency-new-device');

    const merchantUsers = await (await request(`/api/merchants/${merchant.id}/users`, { headers: { Authorization: `Bearer ${agencyAfterReset.token}` } })).json() as Array<{ id: string; role: string }>;
    const merchantAdministrator = merchantUsers.find((record) => record.role === 'MERCHANT_ADMIN')!;
    const resetMerchant = await request(`/api/auth/users/${merchantAdministrator.id}/password-reset`, {
      method: 'POST', headers: { Authorization: `Bearer ${agencyAfterReset.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ newPassword: 'MerchantReplacementPassword456' }),
    });
    expect(resetMerchant.status).toBe(201);
    expect((await request('/api/auth/me', { headers: { Authorization: `Bearer ${merchantFirst.token}` } })).status).toBe(401);
    const merchantAfterReset = await login('managed-reset-merchant@demo.local', 'MerchantReplacementPassword456');

    expect((await request(`/api/auth/users/${agencyAfterReset.user.id}/password-reset`, {
      method: 'POST', headers: { Authorization: `Bearer ${merchantAfterReset.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ newPassword: 'NotAllowedPassword456' }),
    })).status).toBe(403);
    expect((await request(`/api/auth/users/${platform.user.id}/password-reset`, {
      method: 'POST', headers: platformHeaders, body: JSON.stringify({ newPassword: 'PlatformOwnPassword456' }),
    })).status).toBe(400);

    const audits = await app.get(DataSource).getRepository(AuditLog).find({ where: { action: 'USER_PASSWORD_RESET_BY_SUPERVISOR' } });
    expect(audits).toEqual(expect.arrayContaining([
      expect.objectContaining({ actorId: platform.user.id, resourceId: agencyFirst.user.id, merchantId: null, after: expect.objectContaining({ sessionsInvalidated: true }) }),
      expect.objectContaining({ actorId: agencyAfterReset.user.id, resourceId: merchantAdministrator.id, merchantId: merchant.id, after: expect.objectContaining({ sessionsInvalidated: true }) }),
    ]));

    const platformAuditResponse = await request('/api/platform/audits?page=1&pageSize=25', { headers: platformHeaders });
    expect(platformAuditResponse.status).toBe(200);
    const platformAudits = await platformAuditResponse.json() as { items: Array<Record<string, unknown>>; page: number; pageSize: number; total: number };
    expect(platformAudits).toEqual(expect.objectContaining({ page: 1, pageSize: 25, total: expect.any(Number) }));
    expect(platformAudits.items).toEqual(expect.arrayContaining([expect.objectContaining({ action: 'USER_PASSWORD_RESET_BY_SUPERVISOR', resourceId: agencyFirst.user.id })]));
    expect(platformAudits.items.every((item) => !('before' in item) && !('after' in item))).toBe(true);
    expect((await request('/api/platform/audits', { headers: { Authorization: `Bearer ${agencyAfterReset.token}` } })).status).toBe(403);
  });

  it('detects audit-record tampering through the platform integrity check', async () => {
    const platform = await login('platform@demo.local');
    const platformHeaders = { Authorization: `Bearer ${platform.token}` };
    const initial = await request('/api/platform/audits/integrity', { headers: platformHeaders });
    expect(initial.status).toBe(200);
    expect(await initial.json()).toEqual(expect.objectContaining({ valid: true, checked: expect.any(Number), reason: null }));
    const agency = await login('agency@demo.local');
    expect((await request('/api/platform/audits/integrity', { headers: { Authorization: `Bearer ${agency.token}` } })).status).toBe(403);

    const audit = await app.get(DataSource).getRepository(AuditLog).findOne({ where: { chainVersion: 1 }, order: { chainSequence: 'ASC' } });
    expect(audit).toEqual(expect.objectContaining({ recordHash: expect.stringMatching(/^[0-9a-f]{64}$/), previousHash: expect.stringMatching(/^[0-9a-f]{64}$/) }));
    await app.get(DataSource).getRepository(AuditLog).update(audit!.id, { action: 'TAMPERED_AUDIT_ACTION' });
    const afterTamper = await request('/api/platform/audits/integrity', { headers: platformHeaders });
    expect(afterTamper.status).toBe(200);
    expect(await afterTamper.json()).toEqual(expect.objectContaining({ valid: false, firstInvalidSequence: String(audit!.chainSequence), reason: '审计记录签名不匹配' }));
  });

  it('builds a scoped, actionable readiness check from current merchant operations', async () => {
    const platform = await login('platform@demo.local');
    const platformHeaders = { Authorization: `Bearer ${platform.token}`, 'Content-Type': 'application/json' };
    const agency = (await (await request('/api/agencies', { headers: platformHeaders })).json() as Array<{ id: string }>)[0];
    const suffix = Date.now().toString(36);
    const createdResponse = await request('/api/merchants', {
      method: 'POST', headers: platformHeaders,
      body: JSON.stringify({
        agencyId: agency.id, legalName: `运营检查主体-${suffix}`, brandName: `运营检查商家-${suffix}`,
        adminName: '运营检查管理员', adminEmail: `merchant-readiness-${suffix}@demo.local`, adminPassword: 'ReadinessPassword123',
      }),
    });
    expect(createdResponse.status).toBe(201);
    const merchant = await createdResponse.json() as { id: string };
    const merchantAdmin = await login(`merchant-readiness-${suffix}@demo.local`, 'ReadinessPassword123');
    const merchantHeaders = { Authorization: `Bearer ${merchantAdmin.token}`, 'Content-Type': 'application/json' };

    const initialResponse = await request(`/api/merchants/${merchant.id}/readiness`, { headers: merchantHeaders });
    expect(initialResponse.status).toBe(200);
    const initial = await initialResponse.json() as { merchantId: string; checks: Array<{ key: string; state: string; action?: string }> };
    expect(initial.merchantId).toBe(merchant.id);
    expect(initial).not.toHaveProperty('legalName');
    expect(initial.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'sales', state: 'READY' }),
      expect.objectContaining({ key: 'stores', state: 'BLOCKED', action: 'stores' }),
      expect.objectContaining({ key: 'packages', state: 'BLOCKED', action: 'packages' }),
      expect.objectContaining({ key: 'contact', state: 'WARNING', action: 'profile' }),
    ]));

    expect((await request(`/api/merchants/${merchant.id}`, {
      method: 'PATCH', headers: merchantHeaders, body: JSON.stringify({ servicePhone: '020-5555-1234', primaryColor: '#126b5e' }),
    })).status).toBe(200);
    const storeResponse = await request(`/api/merchants/${merchant.id}/stores`, {
      method: 'POST', headers: merchantHeaders,
      body: JSON.stringify({ name: '运营检查门店', address: '广州市天河区运营路 1 号', phone: '020-5555-1234', businessHours: '10:00-20:00', latitude: 23.1291, longitude: 113.2644, openForSale: true }),
    });
    expect(storeResponse.status).toBe(201);
    const store = await storeResponse.json() as { id: string };
    expect((await request(`/api/merchants/${merchant.id}/packages`, {
      method: 'POST', headers: merchantHeaders,
      body: JSON.stringify({ title: '运营检查套餐', description: '用于确认经营检查状态更新', priceFen: 1990, saleLimit: 20, perCustomerLimit: 2, storeIds: [store.id], validFrom: '2026-01-01', validTo: '2027-12-31', status: 'ON_SALE' }),
    })).status).toBe(201);
    expect((await request(`/api/merchants/${merchant.id}/staff`, {
      method: 'POST', headers: merchantHeaders,
      body: JSON.stringify({ name: '运营检查核销员', email: `staff-readiness-${suffix}@demo.local`, password: 'StaffReadiness123', storeIds: [store.id] }),
    })).status).toBe(201);

    const updated = await (await request(`/api/merchants/${merchant.id}/readiness`, { headers: merchantHeaders })).json() as { checks: Array<{ key: string; state: string }> };
    expect(updated.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'stores', state: 'READY' }),
      expect.objectContaining({ key: 'packages', state: 'READY' }),
      expect.objectContaining({ key: 'staff', state: 'READY' }),
      expect.objectContaining({ key: 'contact', state: 'READY' }),
      expect.objectContaining({ key: 'navigation', state: 'READY' }),
    ]));

    const otherMerchant = (await (await request('/api/merchants', { headers: platformHeaders })).json() as Array<{ id: string; brandName: string }>).find((item) => item.brandName === '午间食堂')!;
    expect((await request(`/api/merchants/${otherMerchant.id}/readiness`, { headers: merchantHeaders })).status).toBe(403);
    const staff = await login(`staff-readiness-${suffix}@demo.local`, 'StaffReadiness123');
    expect((await request(`/api/merchants/${merchant.id}/readiness`, { headers: { Authorization: `Bearer ${staff.token}` } })).status).toBe(403);
  });

  it('gives only platform administrators an actionable operations work queue', async () => {
    const platform = await login('platform@demo.local');
    const headers = { Authorization: `Bearer ${platform.token}`, 'Content-Type': 'application/json' };
    const merchant = (await (await request('/api/merchants', { headers })).json() as Array<{ id: string; brandName: string }>).find((item) => item.brandName === '花时间花艺')!;
    const contractEndsAt = new Date(Date.now() + 10 * 86400000).toISOString().slice(0, 10);
    expect((await request(`/api/merchants/${merchant.id}`, {
      method: 'PATCH', headers, body: JSON.stringify({ contractEndsAt }),
    })).status).toBe(200);
    const store = (await (await request(`/api/merchants/${merchant.id}/stores`, { headers })).json() as Array<{ id: string }>)[0];
    const draft = await request(`/api/merchants/${merchant.id}/packages`, {
      method: 'POST', headers,
      body: JSON.stringify({ title: '待发布运营检查套餐', description: '用于平台待办队列测试', priceFen: 990, saleLimit: 10, perCustomerLimit: 1, storeIds: [store.id], validFrom: '2026-01-01', validTo: '2027-12-31', status: 'DRAFT' }),
    });
    expect(draft.status).toBe(201);
    const draftPackage = await draft.json() as { id: string };
    const bill = await app.get(DataSource).getRepository(MonthlyBill).save({
      merchantId: merchant.id, period: '2026-06', verifiedAmountFen: 990, serviceFeeFen: 79,
      status: BillStatus.OVERDUE, invoiceNumber: null,
      disputeEndsAt: new Date(Date.now() - 10 * 86400000), dueAt: new Date(Date.now() - 86400000),
    });
    const publicDeal = (await (await request(`/api/public/merchants/${merchant.id}/packages`)).json() as Array<{ id: string; storeIds: string[] }>).find((deal) => deal.storeIds.includes(store.id))!;
    const refundCustomer = await customerSession();
    const refundOrder = await (await request(`/api/public/merchants/${merchant.id}/orders`, {
      method: 'POST', headers: refundCustomer, body: JSON.stringify({ packageId: publicDeal.id, storeId: store.id, quantity: 1 }),
    })).json() as { id: string };
    const refundPayment = await (await request(`/api/public/orders/${refundOrder.id}/mock-confirm`, { method: 'POST', headers: refundCustomer })).json() as { vouchers: Array<{ id: string }> };
    const refundVoucher = await app.get(DataSource).getRepository(Voucher).findOneByOrFail({ id: refundPayment.vouchers[0].id });
    refundVoucher.status = VoucherStatus.REFUND_PENDING;
    await app.get(DataSource).getRepository(Voucher).save(refundVoucher);
    const failedRefund = await app.get(DataSource).getRepository(Refund).save({
      voucherId: refundVoucher.id, orderId: refundVoucher.orderId, merchantId: merchant.id, amountFen: refundVoucher.faceValueFen,
      reason: 'CUSTOMER_SELF_SERVICE', status: 'FAILED', paymentReference: null,
    });
    const overdueSupportTicket = await app.get(DataSource).getRepository(SupportTicket).save({
      merchantId: merchant.id, customerId: 'platform-queue-customer', source: SupportTicketSource.CUSTOMER, type: SupportTicketType.GENERAL,
      submittedBy: null, voucherId: null, contactPhone: '', content: '等待超过首次响应承诺的售后问题。', status: SupportTicketStatus.OPEN,
      firstResponseDueAt: new Date(Date.now() - 60_000), firstRespondedAt: null, firstRespondedBy: null, resolutionNote: '', resolvedBy: null, resolvedAt: null,
    });

    const queueResponse = await request('/api/platform/work-queue', { headers });
    expect(queueResponse.status).toBe(200);
    const queue = await queueResponse.json() as {
      totals: { contractsExpiring: number; draftPackages: number; billsRequiringAttention: number; failedRefunds: number; supportFirstResponseOverdue: number };
      contractsExpiring: Array<{ merchantId: string; daysRemaining: number }>;
      draftPackages: Array<{ packageId: string; merchantId: string }>;
      billsRequiringAttention: Array<{ billId: string; merchantId: string; status: string }>;
      failedRefunds: Array<{ refundId: string; voucherId: string; merchantId: string; amountFen: number; attemptCount: number; lastAttemptAt: string | null }>;
      supportFirstResponseOverdue: Array<{ ticketId: string; merchantId: string; firstResponseDueAt: string }>;
    };
    expect(queue.totals.contractsExpiring).toBeGreaterThan(0);
    expect(queue.totals.draftPackages).toBeGreaterThan(0);
    expect(queue.totals.billsRequiringAttention).toBeGreaterThan(0);
    expect(queue.totals.failedRefunds).toBeGreaterThan(0);
    expect(queue.totals.supportFirstResponseOverdue).toBeGreaterThan(0);
    expect(queue.contractsExpiring).toEqual(expect.arrayContaining([expect.objectContaining({ merchantId: merchant.id, daysRemaining: expect.any(Number) })]));
    expect(queue.draftPackages).toEqual(expect.arrayContaining([expect.objectContaining({ packageId: draftPackage.id, merchantId: merchant.id })]));
    expect(queue.billsRequiringAttention).toEqual(expect.arrayContaining([expect.objectContaining({ billId: bill.id, merchantId: merchant.id, status: BillStatus.OVERDUE })]));
    expect(queue.failedRefunds).toEqual(expect.arrayContaining([expect.objectContaining({ refundId: failedRefund.id, voucherId: refundVoucher.id, merchantId: merchant.id, amountFen: refundVoucher.faceValueFen, attemptCount: expect.any(Number), lastAttemptAt: null })]));
    expect(queue.supportFirstResponseOverdue).toEqual(expect.arrayContaining([expect.objectContaining({ ticketId: overdueSupportTicket.id, merchantId: merchant.id, firstResponseDueAt: expect.any(String) })]));

    const users = app.get(DataSource).getRepository(User);
    const breakGlass = await users.createQueryBuilder('user').addSelect('user.passwordHash').where('user.email = :email', { email: 'platform@demo.local' }).getOneOrFail();
    const suffix = `${Date.now()}-${Math.floor(Math.random() * 100_000)}`;
    await users.save([
      { email: `queue-finance-${suffix}@demo.local`, name: '待办财务', passwordHash: breakGlass.passwordHash, role: UserRole.PLATFORM_ADMIN, platformAccessProfile: PlatformAccessProfile.FINANCE, agencyId: null, merchantId: null, storeIds: null, active: true },
      { email: `queue-operations-${suffix}@demo.local`, name: '待办运营', passwordHash: breakGlass.passwordHash, role: UserRole.PLATFORM_ADMIN, platformAccessProfile: PlatformAccessProfile.OPERATIONS, agencyId: null, merchantId: null, storeIds: null, active: true },
    ]);
    const [finance, operations] = await Promise.all([login(`queue-finance-${suffix}@demo.local`), login(`queue-operations-${suffix}@demo.local`)]);
    const financeQueue = await request('/api/platform/work-queue', { headers: { Authorization: `Bearer ${finance.token}` } });
    expect(financeQueue.status).toBe(200);
    expect(await financeQueue.json()).toEqual(expect.objectContaining({
      totals: expect.objectContaining({ contractsExpiring: 0, draftPackages: 0, supportFirstResponseOverdue: 0, billsRequiringAttention: expect.any(Number), failedRefunds: expect.any(Number) }),
      contractsExpiring: [], draftPackages: [], supportFirstResponseOverdue: [],
      billsRequiringAttention: expect.arrayContaining([expect.objectContaining({ billId: bill.id })]),
      failedRefunds: expect.arrayContaining([expect.objectContaining({ refundId: failedRefund.id })]),
    }));
    const operationsQueue = await request('/api/platform/work-queue', { headers: { Authorization: `Bearer ${operations.token}` } });
    expect(operationsQueue.status).toBe(200);
    expect(await operationsQueue.json()).toEqual(expect.objectContaining({
      totals: expect.objectContaining({ contractsExpiring: expect.any(Number), draftPackages: expect.any(Number), supportFirstResponseOverdue: expect.any(Number), billsRequiringAttention: 0, failedRefunds: 0 }),
      contractsExpiring: expect.arrayContaining([expect.objectContaining({ merchantId: merchant.id })]),
      draftPackages: expect.arrayContaining([expect.objectContaining({ packageId: draftPackage.id })]),
      supportFirstResponseOverdue: expect.arrayContaining([expect.objectContaining({ ticketId: overdueSupportTicket.id })]),
      billsRequiringAttention: [], failedRefunds: [],
    }));

    const agency = await login('agency@demo.local');
    const merchantAdmin = await login('merchant@demo.local');
    expect((await request('/api/platform/work-queue', { headers: { Authorization: `Bearer ${agency.token}` } })).status).toBe(403);
    expect((await request('/api/platform/work-queue', { headers: { Authorization: `Bearer ${merchantAdmin.token}` } })).status).toBe(403);
  });

  it('revokes an agency administrator immediately when the platform disables that agency', async () => {
    const platform = await login('platform@demo.local');
    const platformHeaders = { Authorization: `Bearer ${platform.token}`, 'Content-Type': 'application/json' };
    const suffix = Date.now().toString(36);
    const email = `disable-agency-${suffix}@demo.local`;
    const password = 'DisableAgencyPassword123';
    const createdResponse = await request('/api/agencies', {
      method: 'POST', headers: platformHeaders,
      body: JSON.stringify({ name: `停用测试代理-${suffix}`, managerName: '停用测试管理员', managerEmail: email, password }),
    });
    expect(createdResponse.status).toBe(201);
    const agency = await createdResponse.json() as { id: string; active: boolean };
    const firstSession = await login(email, password, 'disabled-agency-first-device');
    const secondSession = await login(email, password, 'disabled-agency-second-device');

    const disabledResponse = await request(`/api/agencies/${agency.id}/active`, { method: 'POST', headers: platformHeaders, body: JSON.stringify({ active: false }) });
    expect(disabledResponse.status).toBe(201);
    expect(await disabledResponse.json()).toEqual(expect.objectContaining({ id: agency.id, active: false }));
    expect((await request('/api/merchants', { headers: { Authorization: `Bearer ${firstSession.token}` } })).status).toBe(401);
    expect((await request('/api/auth/me', { headers: { Authorization: `Bearer ${secondSession.token}` } })).status).toBe(401);
    expect((await request('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) })).status).toBe(401);
    expect((await request('/api/merchants', {
      method: 'POST', headers: platformHeaders,
      body: JSON.stringify({ agencyId: agency.id, legalName: '停用代理主体', brandName: '停用代理商家' }),
    })).status).toBe(400);

    const restoredResponse = await request(`/api/agencies/${agency.id}/active`, { method: 'POST', headers: platformHeaders, body: JSON.stringify({ active: true }) });
    expect(restoredResponse.status).toBe(201);
    expect(await restoredResponse.json()).toEqual(expect.objectContaining({ id: agency.id, active: true }));
    const restoredSession = await login(email, password, 'restored-agency-device');
    expect((await request('/api/merchants', { headers: { Authorization: `Bearer ${restoredSession.token}` } })).status).toBe(200);
  });

  it('holds a merchant bill dispute out of lifecycle collection until the platform records a resolution', async () => {
    const platform = await login('platform@demo.local');
    const merchantAdmin = await login('merchant@demo.local');
    const agency = await login('agency@demo.local');
    const platformHeaders = { Authorization: `Bearer ${platform.token}`, 'Content-Type': 'application/json' };
    const merchantHeaders = { Authorization: `Bearer ${merchantAdmin.token}`, 'Content-Type': 'application/json' };
    const merchant = (await (await request('/api/merchants', { headers: { Authorization: `Bearer ${platform.token}` } })).json() as Array<{ id: string; brandName: string }>).find((item) => item.brandName === '花时间花艺')!;
    const bill = await app.get(DataSource).getRepository(MonthlyBill).save({
      merchantId: merchant.id, period: `DISPUTE-${Date.now()}`, verifiedAmountFen: 6400, serviceFeeFen: 512,
      status: BillStatus.DISPUTE_WINDOW, invoiceNumber: null,
      disputeEndsAt: new Date(Date.now() + 60_000), dueAt: new Date(Date.now() - 60_000),
    });

    expect((await request(`/api/bills/${bill.id}/dispute`, { method: 'POST', headers: { Authorization: `Bearer ${agency.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ content: '代理商不能提交账单申诉。' }) })).status).toBe(403);
    const submitted = await request(`/api/bills/${bill.id}/dispute`, { method: 'POST', headers: merchantHeaders, body: JSON.stringify({ content: '核销金额与门店日报存在差异，请平台核对。' }) });
    expect(submitted.status).toBe(201);
    expect(await submitted.json()).toEqual(expect.objectContaining({ billId: bill.id, status: 'OPEN' }));
    expect((await request(`/api/bills/${bill.id}/dispute`, { method: 'POST', headers: merchantHeaders, body: JSON.stringify({ content: '重复申诉。' }) })).status).toBe(400);
    // 争议中的账单状态为 DISPUTED，不在可提交收款确认的状态集合内（400 当前账单状态不允许）
    expect((await request(`/api/bills/${bill.id}/payment-confirmation-requests`, { method: 'POST', headers: { ...platformHeaders, 'Idempotency-Key': `disputed-bill-payment-${Date.now()}` }, body: JSON.stringify({ paymentReference: 'BANK-DISPUTED-BILL-001', note: '账单存在申诉时不允许提交收款确认。' }) })).status).toBe(400);

    await app.get(LifecycleOrchestrationService).runSweep();
    expect((await app.get(DataSource).getRepository(MonthlyBill).findOneByOrFail({ id: bill.id })).status).toBe(BillStatus.DISPUTED);
    const queued = await (await request('/api/platform/work-queue', { headers: { Authorization: `Bearer ${platform.token}` } })).json() as { billsRequiringAttention: Array<{ billId: string; status: string }> };
    expect(queued.billsRequiringAttention).toEqual(expect.arrayContaining([expect.objectContaining({ billId: bill.id, status: BillStatus.DISPUTED })]));

    const resolved = await request(`/api/bills/${bill.id}/dispute/resolve`, { method: 'POST', headers: platformHeaders, body: JSON.stringify({ note: '已复核原始核销记录，账单金额正确；给予处理结论后的付款宽限。' }) });
    expect(resolved.status).toBe(201);
    expect(await resolved.json()).toEqual(expect.objectContaining({ billId: bill.id, status: 'RESOLVED', resolutionNote: expect.stringContaining('已复核') }));
    const updatedBill = await app.get(DataSource).getRepository(MonthlyBill).findOneByOrFail({ id: bill.id });
    expect(updatedBill.status).toBe(BillStatus.CONFIRMED);
    expect(new Date(updatedBill.dueAt).getTime()).toBeGreaterThan(Date.now() + 4 * 86400000);
    const merchantBills = await (await request(`/api/bills?merchantId=${merchant.id}`, { headers: { Authorization: `Bearer ${merchantAdmin.token}` } })).json() as Array<{ id: string; dispute: { status: string; resolutionNote: string } | null }>;
    expect(merchantBills.find((record) => record.id === bill.id)?.dispute).toEqual(expect.objectContaining({ status: 'RESOLVED', resolutionNote: expect.stringContaining('已复核') }));
    const audits = (await (await request(`/api/merchants/${merchant.id}/audits`, { headers: { Authorization: `Bearer ${platform.token}` } })).json() as { items: Array<{ action: string; resourceId: string }> }).items;
    expect(audits).toEqual(expect.arrayContaining([expect.objectContaining({ action: 'BILL_DISPUTE_SUBMITTED', resourceId: bill.id }), expect.objectContaining({ action: 'BILL_DISPUTE_RESOLVED', resourceId: bill.id })]));
  });

  it('paginates operational transactions and exports every authorized order beyond the first 200', async () => {
    const platform = await login('platform@demo.local');
    const headers = { Authorization: `Bearer ${platform.token}` };
    const merchant = (await (await request('/api/merchants', { headers })).json() as Array<{ id: string; brandName: string }>).find((item) => item.brandName === '花时间花艺')!;
    const store = (await (await request(`/api/merchants/${merchant.id}/stores`, { headers })).json() as Array<{ id: string }>)[0];
    const deal = (await (await request(`/api/merchants/${merchant.id}/packages`, { headers })).json() as Array<{ id: string; title: string }>)[0];
    const prefix = `PAGE-EXPORT-${Date.now().toString(36).toUpperCase()}`;
    const now = new Date();
    await app.get(DataSource).getRepository(Order).save(Array.from({ length: 205 }, (_, index) => ({
      orderNo: `${prefix}-${String(index).padStart(3, '0')}`,
      merchantId: merchant.id, packageId: deal.id, storeId: store.id, customerId: `pagination-customer-${index}`,
      quantity: 1, amountFen: 1000, unitPriceFen: 1000, packageTitleSnapshot: deal.title,
      packageVersionSnapshot: 1, validFromSnapshot: new Date('2026-01-01'), validToSnapshot: new Date('2027-12-31'),
      commissionRateSnapshot: '0.0800', status: OrderStatus.PAID, paymentExpiresAt: now, paymentReference: null, createdAt: now,
    })));
    await app.get(DataSource).getRepository(Order).save({
      orderNo: '\t=SUM(1,1)', merchantId: merchant.id, packageId: deal.id, storeId: store.id, customerId: 'csv-formula-test',
      quantity: 1, amountFen: 1000, unitPriceFen: 1000, packageTitleSnapshot: deal.title,
      packageVersionSnapshot: 1, validFromSnapshot: new Date('2026-01-01'), validToSnapshot: new Date('2027-12-31'),
      commissionRateSnapshot: '0.0800', status: OrderStatus.PAID, paymentExpiresAt: now, paymentReference: null, createdAt: now,
    });
    const listResponse = await request(`/api/orders?merchantId=${merchant.id}&page=2&pageSize=25`, { headers });
    expect(listResponse.status).toBe(200);
    const list = await listResponse.json() as { items: Array<Record<string, unknown>>; page: number; pageSize: number; total: number };
    expect(list).toEqual(expect.objectContaining({ page: 2, pageSize: 25, total: expect.any(Number) }));
    expect(list.total).toBeGreaterThanOrEqual(205);
    expect(list.items).toHaveLength(25);
    expect(list.items.every((item) => !('customerId' in item) && !('paymentReference' in item) && !('commissionRateSnapshot' in item))).toBe(true);
    expect((await request(`/api/orders?merchantId=${merchant.id}&pageSize=101`, { headers })).status).toBe(400);
    expect((await request(`/api/orders?merchantId=${merchant.id}&page=1001&pageSize=100`, { headers })).status).toBe(400);

    const firstPageResponse = await request(`/api/orders?merchantId=${merchant.id}&page=1&pageSize=100`, { headers });
    const firstPageRepeatResponse = await request(`/api/orders?merchantId=${merchant.id}&page=1&pageSize=100`, { headers });
    const secondPageResponse = await request(`/api/orders?merchantId=${merchant.id}&page=2&pageSize=100`, { headers });
    const firstPage = await firstPageResponse.json() as { items: Array<{ id: string; orderNo: string }> };
    const firstPageRepeat = await firstPageRepeatResponse.json() as { items: Array<{ id: string; orderNo: string }> };
    const secondPage = await secondPageResponse.json() as { items: Array<{ id: string; orderNo: string }> };
    expect(firstPage.items.map((item) => item.id)).toEqual(firstPageRepeat.items.map((item) => item.id));
    const firstPageIds = new Set(firstPage.items.map((item) => item.id));
    expect(secondPage.items.some((item) => firstPageIds.has(item.id))).toBe(false);
    const tiedOrdersAcrossPages = [...firstPage.items, ...secondPage.items].filter((item) => item.orderNo.startsWith(prefix));
    expect(tiedOrdersAcrossPages.length).toBeGreaterThanOrEqual(199);
    expect(tiedOrdersAcrossPages.length).toBeLessThanOrEqual(200);

    const exportRequest = await request('/api/exports', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'orders', merchantId: merchant.id }) });
    expect(exportRequest.status).toBe(201);
    const exportJob = await exportRequest.json() as { id: string; status: string };
    await app.get(ExportService).process();
    const exportStatus = await request(`/api/exports/${exportJob.id}`, { headers });
    expect(exportStatus.status).toBe(200);
    expect(await exportStatus.json()).toEqual(expect.objectContaining({ id: exportJob.id, status: 'READY', recordCount: expect.any(Number), artifactSha256: expect.stringMatching(/^[a-f0-9]{64}$/) }));
    const exportResponse = await request(`/api/exports/${exportJob.id}/download`, { headers });
    expect(exportResponse.status).toBe(200);
    expect(exportResponse.headers.get('content-disposition')).toContain('attachment');
    const csv = await exportResponse.text();
    expect(csv.match(new RegExp(prefix, 'g'))).toHaveLength(205);
    expect(csv).toContain(`"'\t=SUM(1,1)"`);
    const exportDay = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(now);
    const historicalOrderNo = `${prefix}-HISTORICAL`;
    await app.get(DataSource).getRepository(Order).save({
      orderNo: historicalOrderNo, merchantId: merchant.id, packageId: deal.id, storeId: store.id, customerId: 'historical-export-customer',
      quantity: 1, amountFen: 1000, unitPriceFen: 1000, packageTitleSnapshot: deal.title,
      packageVersionSnapshot: 1, validFromSnapshot: new Date('2024-01-01'), validToSnapshot: new Date('2024-12-31'),
      commissionRateSnapshot: '0.0800', status: OrderStatus.PAID, paymentExpiresAt: new Date('2024-06-01'), paymentReference: null, createdAt: new Date('2024-06-01'),
    });
    const scopedExportRequest = await request('/api/exports', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'orders', merchantId: merchant.id, from: exportDay, to: exportDay }) });
    expect(scopedExportRequest.status).toBe(201);
    const scopedExportJob = await scopedExportRequest.json() as { id: string };
    await app.get(ExportService).process();
    const scopedExport = await request(`/api/exports/${scopedExportJob.id}/download`, { headers });
    expect(scopedExport.status).toBe(200);
    const scopedCsv = await scopedExport.text();
    expect(scopedCsv).toContain(prefix);
    expect(scopedCsv).not.toContain(historicalOrderNo);
    expect((await request('/api/exports', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'orders', merchantId: merchant.id, from: exportDay }) })).status).toBe(400);
    expect((await request('/api/exports', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'orders', merchantId: merchant.id, from: '2024-01-01', to: '2024-04-02' }) })).status).toBe(400);
    const exportAudits = (await (await request(`/api/merchants/${merchant.id}/audits`, { headers })).json() as { items: Array<{ action: string; resourceType: string; resourceId: string }> }).items;
    expect(exportAudits).toEqual(expect.arrayContaining([expect.objectContaining({ action: 'DATA_EXPORT_REQUESTED', resourceType: 'ExportJob', resourceId: exportJob.id }), expect.objectContaining({ action: 'DATA_EXPORT_READY', resourceType: 'ExportJob', resourceId: exportJob.id }), expect.objectContaining({ action: 'DATA_EXPORT_DOWNLOADED', resourceType: 'ExportJob', resourceId: exportJob.id })]));
    const rangeAudit = await app.get(DataSource).getRepository(AuditLog).findOne({ where: { action: 'DATA_EXPORT_REQUESTED', resourceId: scopedExportJob.id }, order: { createdAt: 'DESC' } });
    expect(rangeAudit?.after).toEqual(expect.objectContaining({ from: exportDay, to: exportDay }));

    expect(() => (app.get(ExportService) as unknown as { assertSize: (size: number) => void }).assertSize(10_001)).toThrow('导出结果超过 10,000 条');
  });

  it('isolates, revokes, limits and expires encrypted export artifacts', async () => {
    const platform = await login('platform@demo.local');
    const merchantAdmin = await login('merchant@demo.local');
    const headers = { Authorization: `Bearer ${platform.token}`, 'Content-Type': 'application/json' };
    const merchantHeaders = { Authorization: `Bearer ${merchantAdmin.token}`, 'Content-Type': 'application/json' };
    const merchant = (await (await request('/api/merchants', { headers })).json() as Array<{ id: string; brandName: string }>).find((item) => item.brandName === '花时间花艺')!;

    const requested = await request('/api/exports', { method: 'POST', headers, body: JSON.stringify({ kind: 'orders', merchantId: merchant.id }) });
    expect(requested.status).toBe(201);
    const job = await requested.json() as { id: string };
    await app.get(ExportService).process();
    expect((await request(`/api/exports/${job.id}`, { headers: merchantHeaders })).status).toBe(404);
    expect((await request(`/api/exports/${job.id}/download`, { headers: merchantHeaders })).status).toBe(404);
    expect((await request(`/api/exports/${job.id}/revoke`, { method: 'POST', headers: merchantHeaders, body: '{}' })).status).toBe(404);
    expect((await request('/api/exports', { headers: merchantHeaders })).status).toBe(200);
    expect((await (await request('/api/exports', { headers: merchantHeaders })).json() as Array<{ id: string }>).some((item) => item.id === job.id)).toBe(false);

    for (let download = 1; download <= 3; download += 1) expect((await request(`/api/exports/${job.id}/download`, { headers })).status).toBe(200);
    expect((await request(`/api/exports/${job.id}/download`, { headers })).status).toBe(409);
    const exhausted = await app.get(DataSource).getRepository(ExportJob).findOneByOrFail({ id: job.id });
    expect(exhausted.downloadCount).toBe(3);

    const revocableRequest = await request('/api/exports', { method: 'POST', headers, body: JSON.stringify({ kind: 'verifications', merchantId: merchant.id }) });
    const revocable = await revocableRequest.json() as { id: string };
    await app.get(ExportService).process();
    expect((await request(`/api/exports/${revocable.id}/revoke`, { method: 'POST', headers, body: '{}' })).status).toBe(201);
    expect((await request(`/api/exports/${revocable.id}/download`, { headers })).status).toBe(409);
    expect((await app.get(DataSource).getRepository(ExportJob).findOneByOrFail({ id: revocable.id })).encryptedArtifact).toBeNull();

    const expiringRequest = await request('/api/exports', { method: 'POST', headers, body: JSON.stringify({ kind: 'orders', merchantId: merchant.id }) });
    const expiring = await expiringRequest.json() as { id: string };
    await app.get(ExportService).process();
    await app.get(DataSource).getRepository(ExportJob).update({ id: expiring.id }, { expiresAt: new Date(Date.now() - 1_000) });
    expect(await app.get(ExportService).expire()).toBeGreaterThanOrEqual(1);
    expect((await request(`/api/exports/${expiring.id}/download`, { headers })).status).toBe(409);
    const expired = await app.get(DataSource).getRepository(ExportJob).findOneByOrFail({ id: expiring.id });
    expect(expired.status).toBe('EXPIRED');
    expect(expired.encryptedArtifact).toBeNull();
  });

  it('throttles export and verification endpoints by the authenticated operator identity', async () => {
    const platform = await login('platform@demo.local');
    const platformHeaders = { Authorization: `Bearer ${platform.token}`, 'Content-Type': 'application/json' };
    const merchant = (await (await request('/api/merchants', { headers: platformHeaders })).json() as Array<{ id: string; brandName: string }>).find((item) => item.brandName === '花时间花艺')!;
    const workingStoreId = (await (await request(`/api/merchants/${merchant.id}/stores`, { headers: platformHeaders })).json() as Array<{ id: string }>)[0].id;
    const staffEmail = `rate-limit-staff-${Date.now()}@demo.local`;
    const staffPassword = 'RateLimitStaff123';
    const createdStaff = await request(`/api/merchants/${merchant.id}/staff`, {
      method: 'POST', headers: platformHeaders,
      body: JSON.stringify({ name: '限流测试核销员', email: staffEmail, password: staffPassword, storeIds: [workingStoreId] }),
    });
    expect(createdStaff.status).toBe(201);
    const staff = await login(staffEmail, staffPassword);
    const staffHeaders = { Authorization: `Bearer ${staff.token}`, 'Content-Type': 'application/json' };
    // The suite intentionally exercises prior export requests. Reset only the
    // test throttle table before pre-filling this case's exact thresholds.
    await app.get(DataSource).getRepository(RequestThrottle).clear();
    const throttles = app.get(RequestThrottleService);

    for (let attempt = 0; attempt < 10; attempt += 1) await throttles.consume('operator-export-create', platform.user.id, 10, 15 * 60_000);
    expect((await request('/api/exports', {
      method: 'POST', headers: platformHeaders, body: JSON.stringify({ kind: 'orders', merchantId: merchant.id }),
    })).status).toBe(429);

    for (let attempt = 0; attempt < 120; attempt += 1) await throttles.consume('staff-verification-preview', staff.user.id, 120, 60_000);
    expect((await request('/api/verification/preview', {
      method: 'POST', headers: staffHeaders, body: JSON.stringify({ token: 'x'.repeat(16), workingStoreId }),
    })).status).toBe(429);

    for (let attempt = 0; attempt < 60; attempt += 1) await throttles.consume('staff-verification-confirm', staff.user.id, 60, 60_000);
    expect((await request('/api/verification/confirm', {
      method: 'POST', headers: staffHeaders, body: JSON.stringify({ token: 'x'.repeat(16), workingStoreId, idempotencyKey: 'verification-rate-limit-test' }),
    })).status).toBe(429);
  });

  it('creates encrypted one-time merchant admin invites with replay, revoke and acceptance controls', async () => {
    const platform = await login('platform@demo.local');
    const platformHeaders = { Authorization: `Bearer ${platform.token}`, 'Content-Type': 'application/json' };
    const merchants = await (await request('/api/merchants', { headers: platformHeaders })).json() as Array<{ id: string; agencyId: string }>;
    const source = merchants[0];
    const suffix = randomUUID().slice(0, 8);
    const createdMerchant = await request('/api/merchants', {
      method: 'POST', headers: { ...platformHeaders, 'Idempotency-Key': `invite-merchant-${suffix}` },
      body: JSON.stringify({ agencyId: source.agencyId, legalName: `邀请主体-${suffix}`, brandName: `邀请商家-${suffix}`, servicePhone: '020-0000-0099' }),
    });
    expect(createdMerchant.status).toBe(201);
    const merchant = await createdMerchant.json() as { id: string };
    const email = `invite-admin-${suffix}@demo.local`;
    const body = JSON.stringify({ name: '邀请管理员', email });
    const key = `merchant-invite-${suffix}`;
    const firstResponse = await request(`/api/merchants/${merchant.id}/admin-invites`, { method: 'POST', headers: { ...platformHeaders, 'Idempotency-Key': key }, body });
    expect(firstResponse.status).toBe(201);
    const first = await firstResponse.json() as { id: string; token: string; expiresAt: string; tokenHash?: string };
    expect(first.token).toMatch(/^[A-Za-z0-9_-]{32,}$/);
    expect(first).not.toHaveProperty('tokenHash');
    const notificationOutbox = app.get(DataSource).getRepository(NotificationOutbox);
    const inviteNotification = await notificationOutbox.findOneByOrFail({ dedupeKey: `merchant-admin-invite:${first.id}` });
    expect(inviteNotification).toEqual(expect.objectContaining({ status: expect.any(String), eventType: 'MERCHANT_ADMIN_INVITE_CREATED', templateKey: 'merchant-admin-invite-created', channel: 'EMAIL' }));
    expect(inviteNotification.recipientCiphertext).not.toContain(email);
    await app.get(NotificationOutboxService).process();
    expect((await notificationOutbox.findOneByOrFail({ id: inviteNotification.id })).status).toBe(NotificationOutboxStatus.SENT);
    const notificationService = app.get(NotificationOutboxService);
    const mockNotificationProvider = app.get(MockNotificationProvider);
    const retryDedupeKey = `notification-retry-${suffix}`;
    await app.get(DataSource).transaction((manager) => notificationService.enqueue(manager, {
      eventType: 'E2E_NOTIFICATION_RETRY', templateKey: 'e2e-retry', channel: NotificationChannel.EMAIL,
      recipient: `retry-${suffix}@demo.local`, merchantId: merchant.id, resourceType: 'Merchant', resourceId: merchant.id,
      payload: { merchantId: merchant.id }, dedupeKey: retryDedupeKey,
    }));
    mockNotificationProvider.failNextDelivery('模拟通知失败');
    expect(await notificationService.process()).toEqual({ sent: 0, failed: 0 });
    const retryEvent = await notificationOutbox.findOneByOrFail({ dedupeKey: retryDedupeKey });
    expect(retryEvent).toEqual(expect.objectContaining({ status: NotificationOutboxStatus.PENDING, attemptCount: 1, lastError: '模拟通知失败' }));
    retryEvent.nextAttemptAt = new Date();
    await notificationOutbox.save(retryEvent);
    expect(await notificationService.process()).toEqual({ sent: 1, failed: 0 });
    expect((await notificationOutbox.findOneByOrFail({ id: retryEvent.id })).status).toBe(NotificationOutboxStatus.SENT);
    const failedOperatorDedupeKey = `notification-operator-retry-${suffix}`;
    const failedOperatorEvent = await app.get(DataSource).transaction((manager) => notificationService.enqueue(manager, {
      eventType: 'E2E_NOTIFICATION_OPERATOR_RETRY', templateKey: 'e2e-operator-retry', channel: NotificationChannel.EMAIL,
      recipient: `operator-retry-${suffix}@demo.local`, merchantId: merchant.id, resourceType: 'Merchant', resourceId: merchant.id,
      payload: { merchantId: merchant.id, internalOnly: 'must-not-leak' }, dedupeKey: failedOperatorDedupeKey,
    }));
    await notificationOutbox.update(failedOperatorEvent.id, { status: NotificationOutboxStatus.FAILED, attemptCount: 8, lastError: '模拟终态失败' });
    const notificationList = await request(`/api/platform/notifications?status=FAILED&merchantId=${merchant.id}&limit=10`, { headers: platformHeaders });
    expect(notificationList.status).toBe(200);
    const failedNotificationView = (await notificationList.json() as Array<Record<string, unknown>>).find((item) => item.id === failedOperatorEvent.id)!;
    expect(failedNotificationView).toEqual(expect.objectContaining({ eventType: 'E2E_NOTIFICATION_OPERATOR_RETRY', status: NotificationOutboxStatus.FAILED, payloadKeys: ['internalOnly', 'merchantId'] }));
    expect(failedNotificationView).not.toHaveProperty('recipientCiphertext');
    expect(failedNotificationView).not.toHaveProperty('payload');
    const agency = await login('agency@demo.local');
    expect((await request('/api/platform/notifications', { headers: { Authorization: `Bearer ${agency.token}` } })).status).toBe(403);
    const retriedNotification = await request(`/api/platform/notifications/${failedOperatorEvent.id}/retry`, { method: 'POST', headers: platformHeaders });
    expect(retriedNotification.status).toBe(201);
    expect(await retriedNotification.json()).toEqual(expect.objectContaining({ id: failedOperatorEvent.id, status: NotificationOutboxStatus.PENDING, attemptCount: 8 }));
    expect(await app.get(DataSource).getRepository(AuditLog).findOneBy({ action: 'NOTIFICATION_RETRY_REQUESTED', resourceId: failedOperatorEvent.id })).toEqual(expect.objectContaining({ actorId: platform.user.id, merchantId: merchant.id }));
    const replay = await request(`/api/merchants/${merchant.id}/admin-invites`, { method: 'POST', headers: { ...platformHeaders, 'Idempotency-Key': key }, body });
    expect(replay.status).toBe(201);
    expect((await replay.json() as { id: string; token: string })).toEqual(expect.objectContaining({ id: first.id, token: first.token }));
    expect((await request(`/api/merchants/${merchant.id}/admin-invites`, { method: 'POST', headers: { ...platformHeaders, 'Idempotency-Key': key }, body: JSON.stringify({ name: '另一个管理员', email }) })).status).toBe(409);
    const listed = await (await request(`/api/merchants/${merchant.id}/admin-invites`, { headers: platformHeaders })).json() as Array<Record<string, unknown>>;
    expect(listed[0]).toEqual(expect.objectContaining({ id: first.id, email }));
    expect(listed[0]).not.toHaveProperty('token');
    expect((await request(`/api/merchants/${merchant.id}/admin-invites/${first.id}/revoke`, { method: 'POST', headers: platformHeaders })).status).toBe(201);
    expect((await request('/api/auth/merchant-admin-invites/accept', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: first.token, password: 'InviteAccept123!' }) })).status).toBe(400);

    const secondKey = `merchant-invite-2-${suffix}`;
    const secondResponse = await request(`/api/merchants/${merchant.id}/admin-invites`, { method: 'POST', headers: { ...platformHeaders, 'Idempotency-Key': secondKey }, body });
    expect(secondResponse.status).toBe(201);
    const second = await secondResponse.json() as { token: string };
    const accepted = await request('/api/auth/merchant-admin-invites/accept', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: second.token, password: 'InviteAccept123!' }) });
    expect(accepted.status).toBe(201);
    expect(await accepted.json()).toEqual(expect.objectContaining({ ok: true, merchantId: merchant.id, email }));
    expect((await login(email, 'InviteAccept123!')).user.role).toBe(UserRole.MERCHANT_ADMIN);
    expect((await request('/api/auth/merchant-admin-invites/accept', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: second.token, password: 'InviteAccept123!' }) })).status).toBe(400);
  });

  it('pauses all new sales atomically and requires an independent operator to resume them', async () => {
    const dataSource = app.get(DataSource);
    const users = dataSource.getRepository(User);
    const breakGlass = await users.createQueryBuilder('user').addSelect('user.passwordHash').where('user.email = :email', { email: 'platform@demo.local' }).getOneOrFail();
    const agency = await dataSource.getRepository(Agency).findOneByOrFail({ name: '华南精选生活代理' });
    const suffix = randomUUID().slice(0, 8);
    const merchant = await dataSource.getRepository(Merchant).save({ agencyId: agency.id, legalName: `全局止售主体-${suffix}`, brandName: `全局止售商家-${suffix}`, status: MerchantStatus.ACTIVE, contractEndsAt: new Date('2027-12-31'), servicePhone: '020-0000-9090' });
    const store = await dataSource.getRepository(Store).save({ merchantId: merchant.id, name: '全局止售测试门店', address: '广州市天河区止售路 1 号', phone: '020-0000-9090', businessHours: '09:00-21:00', openForSale: true, openForVerification: true, version: 1 });
    const deal = await dataSource.getRepository(DealPackage).save({ merchantId: merchant.id, title: `全局止售套餐-${suffix}`, description: '验证平台级销售控制。', priceFen: 1990, saleLimit: 20, soldCount: 0, perCustomerLimit: 5, storeIds: [store.id], validFrom: new Date('2026-01-01'), validTo: new Date('2027-12-31'), status: PackageStatus.ON_SALE });
    await dataSource.getRepository(CommissionRateVersion).save({ merchantId: merchant.id, rate: '0.0800', effectiveFrom: new Date('2026-01-01'), note: '全局止售测试费率', createdBy: 'test' });
    await dataSource.getRepository(PackageStore).save({ merchantId: merchant.id, packageId: deal.id, storeId: store.id });
    const staffEmail = `global-sales-staff-${suffix}@demo.local`;
    await users.save({ email: staffEmail, name: '全局止售核销员', passwordHash: breakGlass.passwordHash, role: UserRole.STORE_STAFF, agencyId: agency.id, merchantId: merchant.id, storeIds: [store.id], active: true });
    const firstOperatorEmail = `global-sales-operator-${suffix}@demo.local`;
    const secondOperatorEmail = `global-sales-reviewer-${suffix}@demo.local`;
    await users.save([
      { email: firstOperatorEmail, name: '全局止售运营一', passwordHash: breakGlass.passwordHash, role: UserRole.PLATFORM_ADMIN, platformAccessProfile: PlatformAccessProfile.OPERATIONS, agencyId: null, merchantId: null, storeIds: null, active: true },
      { email: secondOperatorEmail, name: '全局止售运营二', passwordHash: breakGlass.passwordHash, role: UserRole.PLATFORM_ADMIN, platformAccessProfile: PlatformAccessProfile.OPERATIONS, agencyId: null, merchantId: null, storeIds: null, active: true },
    ]);
    const firstOperator = await login(firstOperatorEmail);
    const secondOperator = await login(secondOperatorEmail);
    const firstOperatorHeaders = { Authorization: `Bearer ${firstOperator.token}`, 'Content-Type': 'application/json' };
    const secondOperatorHeaders = { Authorization: `Bearer ${secondOperator.token}`, 'Content-Type': 'application/json' };
    const customerHeaders = await customerSession();
    const firstOrderResponse = await request(`/api/public/merchants/${merchant.id}/orders`, { method: 'POST', headers: customerHeaders, body: JSON.stringify({ packageId: deal.id, storeId: store.id, quantity: 1, idempotencyKey: `global-sales-before-${suffix}` }) });
    expect(firstOrderResponse.status).toBe(201);
    const firstOrder = await firstOrderResponse.json() as { id: string };
    const confirmed = await request(`/api/public/orders/${firstOrder.id}/mock-confirm`, { method: 'POST', headers: customerHeaders });
    expect(confirmed.status).toBe(201);
    const voucher = (await confirmed.json() as { vouchers: Array<{ id: string }> }).vouchers[0];

    const initial = await (await request('/api/platform/runtime-controls/sales', { headers: firstOperatorHeaders })).json() as { status: string; version: number };
    expect(initial).toEqual(expect.objectContaining({ status: 'ENABLED' }));
    const pauseKey = `global-sales-pause-${suffix}`;
    const pauseHeaders = { ...firstOperatorHeaders, 'Idempotency-Key': pauseKey };
    const paused = await request('/api/platform/runtime-controls/sales/pause', { method: 'POST', headers: pauseHeaders, body: JSON.stringify({ expectedVersion: initial.version, note: '支付通道异常，暂停售卖新订单。' }) });
    expect(paused.status).toBe(201);
    const pausedControl = await paused.json() as { status: string; version: number };
    expect(pausedControl).toEqual(expect.objectContaining({ status: 'PAUSED', enabled: false }));
    const pauseReplay = await request('/api/platform/runtime-controls/sales/pause', { method: 'POST', headers: pauseHeaders, body: JSON.stringify({ expectedVersion: initial.version, note: '支付通道异常，暂停售卖新订单。' }) });
    expect(pauseReplay.status).toBe(201);
    expect(await pauseReplay.json()).toEqual(expect.objectContaining({ status: 'PAUSED', version: pausedControl.version }));
    expect((await request('/api/platform/runtime-controls/sales/pause', { method: 'POST', headers: pauseHeaders, body: JSON.stringify({ expectedVersion: initial.version, note: '同一请求标识不能修改操作说明。' }) })).status).toBe(409);
    const blockedOrder = await request(`/api/public/merchants/${merchant.id}/orders`, { method: 'POST', headers: customerHeaders, body: JSON.stringify({ packageId: deal.id, storeId: store.id, quantity: 1, idempotencyKey: `global-sales-blocked-${suffix}` }) });
    expect(blockedOrder.status).toBe(503);

    const dynamicCode = await request(`/api/public/vouchers/${voucher.id}/dynamic-code`, { method: 'POST', headers: customerHeaders });
    expect(dynamicCode.status).toBe(201);
    const dynamic = await dynamicCode.json() as { token: string };
    const staff = await login(staffEmail);
    const staffHeaders = { Authorization: `Bearer ${staff.token}`, 'Content-Type': 'application/json' };
    expect((await request('/api/verification/preview', { method: 'POST', headers: staffHeaders, body: JSON.stringify({ token: dynamic.token, workingStoreId: store.id }) })).status).toBe(201);
    expect((await request('/api/verification/confirm', { method: 'POST', headers: staffHeaders, body: JSON.stringify({ token: dynamic.token, workingStoreId: store.id, idempotencyKey: `global-sales-verify-${suffix}` }) })).status).toBe(201);

    const resumeRequestKey = `global-sales-resume-request-${suffix}`;
    const resumeRequestHeaders = { ...firstOperatorHeaders, 'Idempotency-Key': resumeRequestKey };
    const requested = await request('/api/platform/runtime-controls/sales/resume-request', { method: 'POST', headers: resumeRequestHeaders, body: JSON.stringify({ expectedVersion: pausedControl.version, note: '支付通道恢复，申请双人复核恢复新订单。' }) });
    expect(requested.status).toBe(201);
    const pending = await requested.json() as { status: string; version: number; resumeRequestedBy: string };
    expect(pending).toEqual(expect.objectContaining({ status: 'RESUME_PENDING', resumeRequestedBy: firstOperator.user.id }));
    const resumeRequestReplay = await request('/api/platform/runtime-controls/sales/resume-request', { method: 'POST', headers: resumeRequestHeaders, body: JSON.stringify({ expectedVersion: pausedControl.version, note: '支付通道恢复，申请双人复核恢复新订单。' }) });
    expect(resumeRequestReplay.status).toBe(201);
    expect(await resumeRequestReplay.json()).toEqual(expect.objectContaining({ status: 'RESUME_PENDING', version: pending.version }));
    expect((await request('/api/platform/runtime-controls/sales/resume-approve', { method: 'POST', headers: firstOperatorHeaders, body: JSON.stringify({ expectedVersion: pending.version, note: '申请人不能自行复核。' }) })).status).toBe(409);
    const resumeApproveHeaders = { ...secondOperatorHeaders, 'Idempotency-Key': `global-sales-resume-approve-${suffix}` };
    const resumed = await request('/api/platform/runtime-controls/sales/resume-approve', { method: 'POST', headers: resumeApproveHeaders, body: JSON.stringify({ expectedVersion: pending.version, note: '已独立确认支付通道恢复，开放新订单。' }) });
    expect(resumed.status).toBe(201);
    expect(await resumed.json()).toEqual(expect.objectContaining({ status: 'ENABLED', enabled: true, resumeRequestedBy: null }));
    const resumeReplay = await request('/api/platform/runtime-controls/sales/resume-approve', { method: 'POST', headers: resumeApproveHeaders, body: JSON.stringify({ expectedVersion: pending.version, note: '已独立确认支付通道恢复，开放新订单。' }) });
    expect(resumeReplay.status).toBe(201);
    expect(await resumeReplay.json()).toEqual(expect.objectContaining({ status: 'ENABLED', enabled: true, resumeRequestedBy: null }));
    const afterResume = await request(`/api/public/merchants/${merchant.id}/orders`, { method: 'POST', headers: customerHeaders, body: JSON.stringify({ packageId: deal.id, storeId: store.id, quantity: 1, idempotencyKey: `global-sales-after-${suffix}` }) });
    expect(afterResume.status).toBe(201);
    const actions = (await dataSource.getRepository(AuditLog).find({ where: { resourceType: 'PlatformRuntimeControl', resourceId: 'SALES' }, order: { createdAt: 'ASC' } })).map((record) => record.action);
    expect(actions).toEqual(expect.arrayContaining(['GLOBAL_SALES_PAUSED', 'GLOBAL_SALES_RESUME_REQUESTED', 'GLOBAL_SALES_RESUMED']));
  });
});
