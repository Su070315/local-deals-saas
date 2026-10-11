import 'reflect-metadata';
import { randomUUID } from 'crypto';
import { DataType, newDb } from 'pg-mem';
import { DataSource } from 'typeorm';
import { Agency, AuditChainState, AuthSession, BillDispute, BillDisputeStatus, BillPaymentConfirmationRequest, BillPaymentConfirmationRequestStatus, CommissionRateVersion, ExceptionRefundApprovalStatus, ExportJob, ExportJobStatus, ExportKind, Merchant, MerchantPaymentProfile, MerchantPaymentProfileStatus, MerchantRegistration, MerchantRegistrationStatus, MerchantStatus, MerchantStatusChangeCommand, MonthlyBillGenerationCommand, PlatformAccessProfile, RateChangeRequest, RateChangeRequestStatus, Refund, RequestThrottle, StaffActiveCommand, Store, SupportTicket, SupportTicketSource, SupportTicketStatus, SupportTicketType, User, UserRole, entities } from '../domain/entities';
import { migrations } from './index';

describe('initial PostgreSQL schema migration', () => {
  let dataSource: DataSource;

  beforeAll(async () => {
    process.env.TYPEORM_MIGRATION_TEST = 'true';
    const database = newDb({ autoCreateForeignKeyIndices: true });
    database.public.registerFunction({ name: 'version', returns: DataType.text, implementation: () => 'PostgreSQL 16.0 (migration test)' });
    database.public.registerFunction({ name: 'current_database', returns: DataType.text, implementation: () => 'migration_test' });
    database.registerExtension('uuid-ossp', (schema) => {
      schema.registerFunction({ name: 'uuid_generate_v4', returns: DataType.uuid, implementation: randomUUID, impure: true });
    });
    dataSource = await database.adapters.createTypeormDataSource({
      type: 'postgres', entities, migrations, synchronize: false, migrationsRun: false,
    }).initialize();
  });

  afterAll(async () => {
    await dataSource.destroy();
    delete process.env.TYPEORM_MIGRATION_TEST;
  });

  it('creates the full baseline once and records it as applied', async () => {
    const applied = await dataSource.runMigrations({ transaction: 'each' });
    expect(applied).toHaveLength(migrations.length);
    expect(await dataSource.showMigrations()).toBe(false);
    const registration = await dataSource.getRepository(MerchantRegistration).save({
      merchantId: randomUUID(), status: MerchantRegistrationStatus.DRAFT, note: '', failureReason: '', updatedBy: null,
    });
    expect(registration.id).toMatch(/^[0-9a-f-]{36}$/);
    await expect(dataSource.getRepository(Store).save({ merchantId: randomUUID(), name: '迁移履约状态测试门店', address: '广州市天河区迁移路 1 号', latitude: null, longitude: null, phone: '', businessHours: '09:00-21:00', openForSale: true, version: 1 })).resolves.toEqual(expect.objectContaining({ openForVerification: true }));
    await expect(dataSource.getRepository(RequestThrottle).save({ throttleKey: 'b'.repeat(64), hitCount: 1, resetAt: new Date() })).resolves.toEqual(expect.objectContaining({ hitCount: 1 }));
    await expect(dataSource.getRepository(AuthSession).save({ userId: randomUUID(), sessionVersion: 1, ipAddress: '', userAgent: '', expiresAt: new Date(Date.now() + 60_000), lastSeenAt: new Date(), stepUpVerifiedAt: null, revokedAt: null })).resolves.toEqual(expect.objectContaining({ stepUpVerifiedAt: null }));
    await expect(dataSource.getRepository(SupportTicket).save({ merchantId: randomUUID(), customerId: null, source: SupportTicketSource.MERCHANT, type: SupportTicketType.EXCEPTION_REFUND, submittedBy: randomUUID(), voucherId: null, contactPhone: '', content: '测试异常退款申请迁移。', status: SupportTicketStatus.OPEN, exceptionRefundApprovalStatus: ExceptionRefundApprovalStatus.PENDING_REVIEW, exceptionRefundApprovedBy: null, exceptionRefundApprovalNote: '', exceptionRefundApprovedAt: null, resolutionNote: '', resolvedBy: null, resolvedAt: null })).resolves.toEqual(expect.objectContaining({ type: SupportTicketType.EXCEPTION_REFUND, exceptionRefundApprovalStatus: ExceptionRefundApprovalStatus.PENDING_REVIEW, exceptionRefundApprovedBy: null, exceptionRefundApprovalNote: '' }));
    const supportTickets = dataSource.getRepository(SupportTicket);
    const supportCustomerId = randomUUID();
    await supportTickets.save({ merchantId: randomUUID(), customerId: supportCustomerId, source: SupportTicketSource.CUSTOMER, type: SupportTicketType.GENERAL, submittedBy: null, voucherId: null, idempotencyKey: 'migration-support-ticket-key', requestHash: 's'.repeat(64), contactPhone: '', content: '测试顾客售后提交幂等迁移。', status: SupportTicketStatus.OPEN, exceptionRefundApprovalStatus: null, exceptionRefundApprovedBy: null, exceptionRefundApprovalNote: '', exceptionRefundApprovedAt: null, resolutionNote: '', resolvedBy: null, resolvedAt: null });
    await expect(supportTickets.save({ merchantId: randomUUID(), customerId: supportCustomerId, source: SupportTicketSource.CUSTOMER, type: SupportTicketType.GENERAL, submittedBy: null, voucherId: null, idempotencyKey: 'migration-support-ticket-key', requestHash: 't'.repeat(64), contactPhone: '', content: '同一顾客不能重复使用售后提交标识。', status: SupportTicketStatus.OPEN, exceptionRefundApprovalStatus: null, exceptionRefundApprovedBy: null, exceptionRefundApprovalNote: '', exceptionRefundApprovedAt: null, resolutionNote: '', resolvedBy: null, resolvedAt: null })).rejects.toBeDefined();
    await expect(dataSource.getRepository(Refund).save({ voucherId: randomUUID(), orderId: randomUUID(), merchantId: randomUUID(), amountFen: 990, reason: 'TEST', status: 'PROCESSING', paymentReference: null, lastAttemptAt: new Date(), attemptCount: 1 })).resolves.toEqual(expect.objectContaining({ attemptCount: 1 }));
    await expect(dataSource.getRepository(BillDispute).save({ billId: randomUUID(), merchantId: randomUUID(), submittedBy: randomUUID(), content: '测试账单申诉迁移。', status: BillDisputeStatus.OPEN, resolutionNote: '', resolvedBy: null, resolvedAt: null })).resolves.toEqual(expect.objectContaining({ status: BillDisputeStatus.OPEN }));
    await expect(dataSource.getRepository(ExportJob).save({ requestedBy: randomUUID(), requestedRole: UserRole.PLATFORM_ADMIN, kind: ExportKind.ORDERS, merchantScope: [randomUUID()], requestedMerchantId: null, fromDay: '2026-07-01', toDay: '2026-07-19', status: ExportJobStatus.PENDING, recordCount: 0, encryptedArtifact: null, artifactSha256: '', downloadCount: 0, lastDownloadedAt: null, attemptCount: 0, lastAttemptAt: null, failureReason: '', revokedAt: null, expiresAt: new Date(Date.now() + 86_400_000) })).resolves.toEqual(expect.objectContaining({ kind: ExportKind.ORDERS, fromDay: '2026-07-01' }));
    const agency = await dataSource.getRepository(Agency).save({ name: '迁移商家创建幂等代理' });
    const merchants = dataSource.getRepository(Merchant);
    const sameLegalName = '同名但未核验的商家主体';
    await expect(merchants.save([
      { agencyId: agency.id, legalName: sameLegalName, brandName: '同名草稿品牌一', createdBy: randomUUID(), creationIdempotencyKey: 'migration-draft-key-a', creationRequestHash: 'a'.repeat(64) },
      { agencyId: agency.id, legalName: sameLegalName, brandName: '同名草稿品牌二', createdBy: randomUUID(), creationIdempotencyKey: 'migration-draft-key-b', creationRequestHash: 'b'.repeat(64) },
    ])).resolves.toHaveLength(2);
    const creatorId = randomUUID();
    const paymentProfileMerchant = await merchants.save({ agencyId: agency.id, legalName: '幂等创建测试主体', brandName: '幂等创建测试品牌', createdBy: creatorId, creationIdempotencyKey: 'migration-idempotency-key', creationRequestHash: 'c'.repeat(64) });
    await expect(dataSource.getRepository(MerchantPaymentProfile).save({ merchantId: paymentProfileMerchant.id, provider: 'HUIFU', externalMerchantNo: 'XYM_MIGRATION_PROFILE_001', providerMerchantId: '666600000001', applicationNo: 'APPLY_001', status: MerchantPaymentProfileStatus.ACTIVE, version: 1, verifiedBy: creatorId, verifiedAt: new Date(), updatedBy: creatorId })).resolves.toEqual(expect.objectContaining({ providerMerchantId: '666600000001', status: MerchantPaymentProfileStatus.ACTIVE }));
    await expect(merchants.save({ agencyId: agency.id, legalName: '不同请求不能复用幂等键', brandName: '幂等创建冲突品牌', createdBy: creatorId, creationIdempotencyKey: 'migration-idempotency-key', creationRequestHash: 'd'.repeat(64) })).rejects.toBeDefined();
    const statusCommands = dataSource.getRepository(MerchantStatusChangeCommand);
    const statusCommandMerchantId = randomUUID();
    await statusCommands.save({ merchantId: statusCommandMerchantId, requestedBy: creatorId, expectedStatus: MerchantStatus.ACTIVE, targetStatus: MerchantStatus.SALES_SUSPENDED, idempotencyKey: 'migration-status-command-key', requestHash: 'q'.repeat(64) });
    await expect(statusCommands.save({ merchantId: statusCommandMerchantId, requestedBy: creatorId, expectedStatus: MerchantStatus.ACTIVE, targetStatus: MerchantStatus.SALES_SUSPENDED, idempotencyKey: 'migration-status-command-key', requestHash: 'r'.repeat(64) })).rejects.toBeDefined();
    const staffActiveCommands = dataSource.getRepository(StaffActiveCommand);
    const staffCommandMerchantId = randomUUID();
    const staffCommandId = randomUUID();
    await staffActiveCommands.save({ merchantId: staffCommandMerchantId, staffId: staffCommandId, requestedBy: creatorId, active: false, idempotencyKey: 'migration-staff-active-key', requestHash: 'u'.repeat(64) });
    await expect(staffActiveCommands.save({ merchantId: staffCommandMerchantId, staffId: staffCommandId, requestedBy: creatorId, active: true, idempotencyKey: 'migration-staff-active-key', requestHash: 'v'.repeat(64) })).rejects.toBeDefined();
    const billGenerationCommands = dataSource.getRepository(MonthlyBillGenerationCommand);
    await billGenerationCommands.save({ period: '2030-06', requestedBy: creatorId, idempotencyKey: 'migration-bill-generation-key', requestHash: 'w'.repeat(64) });
    await expect(billGenerationCommands.save({ period: '2030-07', requestedBy: creatorId, idempotencyKey: 'migration-bill-generation-key', requestHash: 'x'.repeat(64) })).rejects.toBeDefined();
    const rateVersions = dataSource.getRepository(CommissionRateVersion);
    await rateVersions.save({ merchantId: randomUUID(), rate: '0.0800', effectiveFrom: new Date('2030-01-01T00:00:00+08:00'), note: '迁移费率幂等测试', createdBy: creatorId, idempotencyKey: 'migration-rate-key', requestHash: 'e'.repeat(64) });
    await expect(rateVersions.save({ merchantId: randomUUID(), rate: '0.0900', effectiveFrom: new Date('2030-02-01T00:00:00+08:00'), note: '不同商家可安全复用随机键', createdBy: creatorId, idempotencyKey: 'migration-rate-key', requestHash: 'f'.repeat(64) })).resolves.toBeDefined();
    const rateMerchantId = randomUUID();
    await rateVersions.save({ merchantId: rateMerchantId, rate: '0.0800', effectiveFrom: new Date('2030-03-01T00:00:00+08:00'), note: '相同商家幂等测试', createdBy: creatorId, idempotencyKey: 'migration-rate-key-2', requestHash: 'g'.repeat(64) });
    await expect(rateVersions.save({ merchantId: rateMerchantId, rate: '0.0900', effectiveFrom: new Date('2030-04-01T00:00:00+08:00'), note: '同一商家键冲突测试', createdBy: creatorId, idempotencyKey: 'migration-rate-key-2', requestHash: 'h'.repeat(64) })).rejects.toBeDefined();
    const rateChangeRequests = dataSource.getRepository(RateChangeRequest);
    const rateRequestMerchantId = randomUUID();
    const rateRequesterId = randomUUID();
    await rateChangeRequests.save({ merchantId: rateRequestMerchantId, requestedBy: rateRequesterId, rate: '0.0825', effectiveFrom: new Date('2030-05-01T00:00:00+08:00'), note: '迁移双人复核费率请求', status: RateChangeRequestStatus.PENDING_REVIEW, idempotencyKey: 'migration-rate-request-key', requestHash: 'i'.repeat(64), reviewedBy: null, reviewNote: '', reviewedAt: null, rateVersionId: null });
    await expect(rateChangeRequests.save({ merchantId: rateRequestMerchantId, requestedBy: rateRequesterId, rate: '0.0825', effectiveFrom: new Date('2030-06-01T00:00:00+08:00'), note: '同一请求键不能复用', status: RateChangeRequestStatus.PENDING_REVIEW, idempotencyKey: 'migration-rate-request-key', requestHash: 'j'.repeat(64), reviewedBy: null, reviewNote: '', reviewedAt: null, rateVersionId: null })).rejects.toBeDefined();
    await expect(rateChangeRequests.save({ merchantId: rateRequestMerchantId, requestedBy: randomUUID(), rate: '0.0900', effectiveFrom: new Date('2030-05-01T00:00:00+08:00'), note: '同一生效日只能保留一条待复核请求', status: RateChangeRequestStatus.PENDING_REVIEW, idempotencyKey: 'migration-rate-request-key-2', requestHash: 'k'.repeat(64), reviewedBy: null, reviewNote: '', reviewedAt: null, rateVersionId: null })).rejects.toBeDefined();
    await expect(rateChangeRequests.save({ merchantId: rateRequestMerchantId, requestedBy: randomUUID(), rate: '0.0900', effectiveFrom: new Date('2030-05-01T00:00:00+08:00'), note: '驳回后可再次提交同一生效日', status: RateChangeRequestStatus.REJECTED, idempotencyKey: 'migration-rate-request-key-3', requestHash: 'l'.repeat(64), reviewedBy: randomUUID(), reviewNote: '材料不完整', reviewedAt: new Date(), rateVersionId: null })).resolves.toBeDefined();
    const billPaymentConfirmationRequests = dataSource.getRepository(BillPaymentConfirmationRequest);
    const billId = randomUUID();
    await billPaymentConfirmationRequests.save({ billId, merchantId: randomUUID(), requestedBy: creatorId, paymentReference: 'BANK-STATEMENT-2026-001', note: '迁移收款双人复核测试', status: BillPaymentConfirmationRequestStatus.PENDING_REVIEW, idempotencyKey: 'migration-bill-payment-key', requestHash: 'm'.repeat(64), reviewedBy: null, reviewNote: '', reviewedAt: null });
    await expect(billPaymentConfirmationRequests.save({ billId, merchantId: randomUUID(), requestedBy: creatorId, paymentReference: 'BANK-STATEMENT-2026-002', note: '同一账单同一账号不能复用请求键', status: BillPaymentConfirmationRequestStatus.PENDING_REVIEW, idempotencyKey: 'migration-bill-payment-key', requestHash: 'n'.repeat(64), reviewedBy: null, reviewNote: '', reviewedAt: null })).rejects.toBeDefined();
    await expect(billPaymentConfirmationRequests.save({ billId: randomUUID(), merchantId: randomUUID(), requestedBy: randomUUID(), paymentReference: 'BANK-STATEMENT-2026-001', note: '同一流水不能用于另一笔待审收款', status: BillPaymentConfirmationRequestStatus.PENDING_REVIEW, idempotencyKey: 'migration-bill-payment-key-2', requestHash: 'o'.repeat(64), reviewedBy: null, reviewNote: '', reviewedAt: null })).rejects.toBeDefined();
    await expect(billPaymentConfirmationRequests.save({ billId: randomUUID(), merchantId: randomUUID(), requestedBy: randomUUID(), paymentReference: 'BANK-STATEMENT-2026-001', note: '驳回后允许修正后重用参考号', status: BillPaymentConfirmationRequestStatus.REJECTED, idempotencyKey: 'migration-bill-payment-key-3', requestHash: 'p'.repeat(64), reviewedBy: randomUUID(), reviewNote: '流水归属不清晰', reviewedAt: new Date() })).resolves.toBeDefined();
    const scopedPlatformUser = await dataSource.getRepository(User).save({
      email: 'migration-finance@example.local', name: '迁移财务职责账号', passwordHash: 'not-a-real-password-hash', role: UserRole.PLATFORM_ADMIN,
      platformAccessProfile: PlatformAccessProfile.FINANCE, agencyId: null, merchantId: null, storeIds: null, active: true,
    });
    expect(scopedPlatformUser.platformAccessProfile).toBe(PlatformAccessProfile.FINANCE);
    expect(await merchants.countBy({ legalName: sameLegalName })).toBe(2);
    expect(await dataSource.runMigrations({ transaction: 'each' })).toEqual([]);
    expect(String((await dataSource.getRepository(AuditChainState).findOneByOrFail({ id: 'global' })).lastSequence)).toBe('0');
  });
});
