import { LifecycleService } from './lifecycle.service';

const emptySweep = { closedOrders: 0, expiredVouchers: 0, suspendedContracts: 0, confirmedBills: 0, overdueBills: 0, suspendedForOverdueBills: 0, clearedRequestThrottles: 0, clearedLoginThrottles: 0, recoveredRefunds: 0, failedRefundRecoveries: 0, dispatchedPaymentIntents: 0, retriedPaymentIntents: 0, reconciledPaymentIntents: 0, failedPaymentReconciliations: 0, expiredExportJobs: 0, completedExportJobs: 0, failedExportJobs: 0, exportQueue: { pending: 0, processing: 0, failed: 0, oldestPendingAt: null, oldestProcessingAt: null }, expiryQueue: { overdueOrders: 0, overdueVouchers: 0, oldestOverdueOrderAt: null, oldestOverdueVoucherAt: null }, signedAuditEvents: 0, quarantinedAuditEvents: 0, auditOutbox: { pending: 0, processing: 0, quarantined: 0, oldestPendingAt: null, oldestProcessingAt: null } };

describe('LifecycleService distributed worker lock', () => {
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const originalUsePgMem = process.env.USE_PG_MEM;
  const originalWorker = process.env.RUN_LIFECYCLE_WORKER;

  afterEach(() => {
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
    if (originalUsePgMem === undefined) delete process.env.USE_PG_MEM;
    else process.env.USE_PG_MEM = originalUsePgMem;
    if (originalWorker === undefined) delete process.env.RUN_LIFECYCLE_WORKER;
    else process.env.RUN_LIFECYCLE_WORKER = originalWorker;
  });

  it('defaults to the embedded worker but requires an explicit real-database worker', () => {
    delete process.env.DATABASE_URL;
    delete process.env.USE_PG_MEM;
    delete process.env.RUN_LIFECYCLE_WORKER;
    const service = new LifecycleService({ runSweep: jest.fn() } as never, {} as never, {} as never, {} as never);
    expect((service as any).shouldRunWorker()).toBe(true);
    process.env.DATABASE_URL = 'postgres://shared-db';
    expect((service as any).shouldRunWorker()).toBe(false);
    process.env.RUN_LIFECYCLE_WORKER = 'true';
    expect((service as any).shouldRunWorker()).toBe(true);
  });

  it('skips the sweep when another PostgreSQL worker holds the advisory lock', async () => {
    process.env.DATABASE_URL = 'postgres://shared-db';
    delete process.env.USE_PG_MEM;
    const lifecycle = { runSweep: jest.fn().mockResolvedValue(emptySweep) };
    const queryRunner = { connect: jest.fn(), query: jest.fn().mockResolvedValue([{ locked: false }]), release: jest.fn() };
    const health = { markLifecycleWorkerConfigured: jest.fn(), markLifecycleWorkerSweepSucceeded: jest.fn(), markLifecycleWorkerSweepFailed: jest.fn() };
    const service = new LifecycleService(lifecycle as never, {} as never, { createQueryRunner: jest.fn().mockReturnValue(queryRunner) } as never, health as never);

    await (service as any).sweep();

    expect(lifecycle.runSweep).not.toHaveBeenCalled();
    expect(queryRunner.query).toHaveBeenCalledTimes(1);
    expect(queryRunner.release).toHaveBeenCalledTimes(1);
  });

  it('runs once and releases the advisory lock after a successful sweep', async () => {
    process.env.DATABASE_URL = 'postgres://shared-db';
    delete process.env.USE_PG_MEM;
    const lifecycle = { runSweep: jest.fn().mockResolvedValue(emptySweep) };
    const queryRunner = {
      connect: jest.fn(),
      query: jest.fn().mockResolvedValueOnce([{ locked: true }]).mockResolvedValueOnce([]),
      release: jest.fn(),
    };
    const health = { markLifecycleWorkerConfigured: jest.fn(), markLifecycleWorkerSweepSucceeded: jest.fn(), markLifecycleWorkerSweepFailed: jest.fn() };
    const service = new LifecycleService(lifecycle as never, {} as never, { createQueryRunner: jest.fn().mockReturnValue(queryRunner) } as never, health as never);

    await (service as any).sweep();

    expect(lifecycle.runSweep).toHaveBeenCalledTimes(1);
    expect(queryRunner.query.mock.calls[0][0]).toContain('pg_try_advisory_lock');
    expect(queryRunner.query.mock.calls[1][0]).toContain('pg_advisory_unlock');
    expect(queryRunner.release).toHaveBeenCalledTimes(1);
    expect(health.markLifecycleWorkerSweepSucceeded).toHaveBeenCalledTimes(1);
    expect(health.markLifecycleWorkerSweepFailed).not.toHaveBeenCalled();
  });

  it('uses the same distributed lease for fast audit outbox delivery', async () => {
    process.env.DATABASE_URL = 'postgres://shared-db';
    delete process.env.USE_PG_MEM;
    const auditOutbox = { pending: 3, processing: 0, quarantined: 0, oldestPendingAt: new Date(), oldestProcessingAt: null };
    const lifecycle = {};
    const auditOutboxService = {
      process: jest.fn().mockResolvedValue({ signed: 4, quarantined: 0 }),
      queueStatus: jest.fn().mockResolvedValue(auditOutbox),
    };
    const queryRunner = {
      connect: jest.fn(),
      query: jest.fn().mockResolvedValueOnce([{ locked: true }]).mockResolvedValueOnce([]),
      release: jest.fn(),
    };
    const health = { markLifecycleWorkerAuditOutboxProcessed: jest.fn(), markLifecycleWorkerAuditOutboxFailed: jest.fn() };
    const service = new LifecycleService(lifecycle as never, auditOutboxService as never, { createQueryRunner: jest.fn().mockReturnValue(queryRunner) } as never, health as never);

    await (service as any).auditOutboxSweep();

    expect(auditOutboxService.process).toHaveBeenCalledTimes(1);
    expect(auditOutboxService.queueStatus).toHaveBeenCalledTimes(1);
    expect(queryRunner.query.mock.calls[0][0]).toContain('pg_try_advisory_lock');
    expect(queryRunner.query.mock.calls[1][0]).toContain('pg_advisory_unlock');
    expect(queryRunner.release).toHaveBeenCalledTimes(1);
    expect(health.markLifecycleWorkerAuditOutboxProcessed).toHaveBeenCalledWith(auditOutbox, 4, 0);
    expect(health.markLifecycleWorkerAuditOutboxFailed).not.toHaveBeenCalled();
  });

  it('uses the same distributed lease for independent expiry processing', async () => {
    process.env.DATABASE_URL = 'postgres://shared-db';
    delete process.env.USE_PG_MEM;
    const expiryQueue = { overdueOrders: 4, overdueVouchers: 2, oldestOverdueOrderAt: new Date(), oldestOverdueVoucherAt: new Date() };
    const lifecycle = { processExpiryQueues: jest.fn().mockResolvedValue({ closedOrders: 3, expiredVouchers: 5, expiryQueue }) };
    const queryRunner = {
      connect: jest.fn(),
      query: jest.fn().mockResolvedValueOnce([{ locked: true }]).mockResolvedValueOnce([]),
      release: jest.fn(),
    };
    const health = { markLifecycleWorkerExpiryProcessed: jest.fn(), markLifecycleWorkerExpiryFailed: jest.fn() };
    const service = new LifecycleService(lifecycle as never, {} as never, { createQueryRunner: jest.fn().mockReturnValue(queryRunner) } as never, health as never);

    await (service as any).expirySweep();

    expect(lifecycle.processExpiryQueues).toHaveBeenCalledTimes(1);
    expect(queryRunner.query.mock.calls[0][0]).toContain('pg_try_advisory_lock');
    expect(queryRunner.query.mock.calls[1][0]).toContain('pg_advisory_unlock');
    expect(queryRunner.release).toHaveBeenCalledTimes(1);
    expect(health.markLifecycleWorkerExpiryProcessed).toHaveBeenCalledWith(expiryQueue, 3, 5);
    expect(health.markLifecycleWorkerExpiryFailed).not.toHaveBeenCalled();
  });

  it('uses the same distributed lease for fast payment reconciliation', async () => {
    process.env.DATABASE_URL = 'postgres://shared-db';
    delete process.env.USE_PG_MEM;
    const lifecycle = { runPaymentReconciliation: jest.fn().mockResolvedValue({ queried: 2, recovered: 1, failed: 0 }) };
    const queryRunner = {
      connect: jest.fn(),
      query: jest.fn().mockResolvedValueOnce([{ locked: true }]).mockResolvedValueOnce([]),
      release: jest.fn(),
    };
    const health = {};
    const service = new LifecycleService(lifecycle as never, {} as never, { createQueryRunner: jest.fn().mockReturnValue(queryRunner) } as never, health as never);

    await (service as any).paymentReconciliationSweep();

    expect(lifecycle.runPaymentReconciliation).toHaveBeenCalledTimes(1);
    expect(queryRunner.query.mock.calls[0][0]).toContain('pg_try_advisory_lock');
    expect(queryRunner.query.mock.calls[1][0]).toContain('pg_advisory_unlock');
    expect(queryRunner.release).toHaveBeenCalledTimes(1);
  });

  it('skips fast payment reconciliation while the shared lease is held elsewhere', async () => {
    process.env.DATABASE_URL = 'postgres://shared-db';
    delete process.env.USE_PG_MEM;
    const lifecycle = { runPaymentReconciliation: jest.fn().mockResolvedValue({ queried: 0, recovered: 0, failed: 0 }) };
    const queryRunner = { connect: jest.fn(), query: jest.fn().mockResolvedValue([{ locked: false }]), release: jest.fn() };
    const health = {};
    const service = new LifecycleService(lifecycle as never, {} as never, { createQueryRunner: jest.fn().mockReturnValue(queryRunner) } as never, health as never);

    await (service as any).paymentReconciliationSweep();

    expect(lifecycle.runPaymentReconciliation).not.toHaveBeenCalled();
    expect(queryRunner.release).toHaveBeenCalledTimes(1);
  });
});
