import { HealthService } from './health.service';

describe('HealthService readiness', () => {
  const utcQuery = () => jest.fn().mockImplementation(async (sql: string) => sql.includes("current_setting('TimeZone')") ? [{ timezone: 'UTC' }] : [{ ok: 1 }]);
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const originalUsePgMem = process.env.USE_PG_MEM;
  const originalReleaseId = process.env.RELEASE_ID;

  afterEach(() => {
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
    if (originalUsePgMem === undefined) delete process.env.USE_PG_MEM;
    else process.env.USE_PG_MEM = originalUsePgMem;
    if (originalReleaseId === undefined) delete process.env.RELEASE_ID;
    else process.env.RELEASE_ID = originalReleaseId;
  });

  it('rejects a real database that has pending migrations', async () => {
    process.env.DATABASE_URL = 'postgres://shared-db';
    process.env.RELEASE_ID = 'health-test-release';
    delete process.env.USE_PG_MEM;
    const service = new HealthService({ isInitialized: true, query: utcQuery(), showMigrations: jest.fn().mockResolvedValue(true) } as never);
    await expect(service.ready()).rejects.toMatchObject({ response: expect.objectContaining({ message: '数据库迁移尚未完成' }) });
  });

  it('reports migration status for a current real database and keeps demo mode ready', async () => {
    process.env.DATABASE_URL = 'postgres://shared-db';
    process.env.RELEASE_ID = 'health-test-release';
    delete process.env.USE_PG_MEM;
    const real = new HealthService({
      isInitialized: true, query: utcQuery(), showMigrations: jest.fn().mockResolvedValue(false),
      driver: { master: { totalCount: 10, idleCount: 2, waitingCount: 3, options: { max: 10 } } },
    } as never);
    await expect(real.ready()).resolves.toEqual(expect.objectContaining({
      mode: 'postgresql', migrations: 'current', releaseId: 'health-test-release',
      databasePool: { mode: 'postgresql', observability: 'available', pressure: 'saturated', maxConnections: 10, totalConnections: 10, idleConnections: 2, waitingRequests: 3 },
    }));
    delete process.env.DATABASE_URL;
    const demo = new HealthService({ isInitialized: true, query: jest.fn(), showMigrations: jest.fn() } as never);
    await expect(demo.ready()).resolves.toEqual(expect.objectContaining({ mode: 'embedded-demo', migrations: 'not-applicable' }));
    await expect(demo.publicReady()).resolves.toEqual({ status: 'ok' });
    expect(demo.publicLive()).toEqual({ status: 'ok' });
  });

  it('keeps public readiness failures generic while internal diagnostics retain the cause', async () => {
    process.env.DATABASE_URL = 'postgres://shared-db';
    process.env.RELEASE_ID = 'health-test-release';
    delete process.env.USE_PG_MEM;
    const service = new HealthService({ isInitialized: true, query: utcQuery(), showMigrations: jest.fn().mockResolvedValue(true) } as never);
    await expect(service.publicReady()).rejects.toMatchObject({ response: expect.objectContaining({ message: '服务暂不可用' }) });
    await expect(service.ready()).rejects.toMatchObject({ response: expect.objectContaining({ message: '数据库迁移尚未完成' }) });
  });

  it('keeps readiness available while exposing PostgreSQL pool pressure or unavailable driver metrics', async () => {
    process.env.DATABASE_URL = 'postgres://shared-db';
    process.env.RELEASE_ID = 'health-test-release';
    delete process.env.USE_PG_MEM;
    const waiting = new HealthService({
      isInitialized: true, query: utcQuery(), showMigrations: jest.fn().mockResolvedValue(false),
      driver: { master: { totalCount: 6, idleCount: 0, waitingCount: 2, options: { max: 10 } } },
    } as never);
    await expect(waiting.ready()).resolves.toEqual(expect.objectContaining({
      databasePool: expect.objectContaining({ observability: 'available', pressure: 'waiting', waitingRequests: 2 }),
    }));
    const unknown = new HealthService({ isInitialized: true, query: utcQuery(), showMigrations: jest.fn().mockResolvedValue(false) } as never);
    await expect(unknown.ready()).resolves.toEqual(expect.objectContaining({
      databasePool: expect.objectContaining({ observability: 'unavailable', pressure: 'unknown' }),
    }));
  });

  it('marks readiness unavailable while the instance is draining', async () => {
    delete process.env.DATABASE_URL;
    const service = new HealthService({ isInitialized: true, query: jest.fn(), showMigrations: jest.fn() } as never);
    service.markDraining();
    await expect(service.ready()).rejects.toMatchObject({ response: expect.objectContaining({ message: '实例正在停止接流' }) });
  });

  it('reports calendar coverage with readiness and fails closed for a stale shared calendar', async () => {
    const previousNodeEnv = process.env.NODE_ENV;
    const previousDatabaseUrl = process.env.DATABASE_URL;
    const previousCalendarDate = process.env.CHINA_OPERATIONAL_CALENDAR_VALID_THROUGH;
    process.env.NODE_ENV = 'staging';
    process.env.DATABASE_URL = 'postgres://shared-db';
    process.env.RELEASE_ID = 'health-test-release';
    process.env.CHINA_OPERATIONAL_CALENDAR_VALID_THROUGH = '2099-12-31';
    try {
      const service = new HealthService({ isInitialized: true, query: utcQuery(), showMigrations: jest.fn().mockResolvedValue(false) } as never);
      await expect(service.ready()).resolves.toEqual(expect.objectContaining({ operationalCalendar: expect.objectContaining({ validThrough: '2099-12-31' }) }));
      process.env.CHINA_OPERATIONAL_CALENDAR_VALID_THROUGH = '2020-01-01';
      await expect(service.ready()).rejects.toMatchObject({ response: expect.objectContaining({ message: expect.stringContaining('运营日历不可用') }) });
    } finally {
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
      if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previousDatabaseUrl;
      if (previousCalendarDate === undefined) delete process.env.CHINA_OPERATIONAL_CALENDAR_VALID_THROUGH;
      else process.env.CHINA_OPERATIONAL_CALENDAR_VALID_THROUGH = previousCalendarDate;
    }
  });

  it('rejects a real PostgreSQL connection whose session timezone is not UTC', async () => {
    process.env.DATABASE_URL = 'postgres://shared-db';
    process.env.RELEASE_ID = 'health-test-release';
    delete process.env.USE_PG_MEM;
    const query = jest.fn().mockImplementation(async (sql: string) => sql.includes("current_setting('TimeZone')") ? [{ timezone: 'Asia/Shanghai' }] : [{ ok: 1 }]);
    const service = new HealthService({ isInitialized: true, query, showMigrations: jest.fn().mockResolvedValue(false) } as never);
    await expect(service.ready()).rejects.toMatchObject({ response: expect.objectContaining({ message: '数据库会话时区不是 UTC' }) });
  });

  it('distinguishes a configured lifecycle worker from a stale or missing worker heartbeat', () => {
    delete process.env.DATABASE_URL;
    const service = new HealthService({ isInitialized: true, query: jest.fn(), showMigrations: jest.fn() } as never);
    expect(() => service.workerReady()).toThrow('本实例未配置生命周期工作器');
    service.markLifecycleWorkerConfigured();
    expect(() => service.workerReady()).toThrow('生命周期工作器尚未完成首轮任务');
    service.markLifecycleWorkerSweepSucceeded(new Date(0));
    const now = jest.spyOn(Date, 'now').mockReturnValue(181_000);
    try {
      expect(() => service.workerReady()).toThrow('生命周期工作器心跳已超时');
    } finally {
      now.mockRestore();
    }
    service.markLifecycleWorkerSweepSucceeded(new Date());
    expect(service.workerReady()).toEqual(expect.objectContaining({ worker: 'ok', configured: true, lastSuccessAt: expect.any(String) }));
  });

  it('reports queued export work and fails the worker probe when its latency budget is exceeded', () => {
    delete process.env.DATABASE_URL;
    const service = new HealthService({ isInitialized: true, query: jest.fn(), showMigrations: jest.fn() } as never);
    const now = jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
    try {
      service.markLifecycleWorkerConfigured();
      service.markLifecycleWorkerSweepSucceeded(new Date(1_000_000), {
        pending: 2, processing: 1, failed: 0, oldestPendingAt: new Date(700_000), oldestProcessingAt: new Date(800_000),
      });
      expect(service.workerReady()).toEqual(expect.objectContaining({
        worker: 'ok', exportQueue: expect.objectContaining({ pending: 2, processing: 1, oldestPendingAgeSeconds: 300, maxAgeSeconds: 600 }),
      }));
      service.markLifecycleWorkerSweepSucceeded(new Date(1_000_000), {
        pending: 1, processing: 0, failed: 0, oldestPendingAt: new Date(399_000), oldestProcessingAt: null,
      });
      expect(() => service.workerReady()).toThrow('导出任务队列等待超时');
    } finally {
      now.mockRestore();
    }
  });

  it('fails the worker probe when an audit outbox is delayed or quarantined', () => {
    delete process.env.DATABASE_URL;
    const service = new HealthService({ isInitialized: true, query: jest.fn(), showMigrations: jest.fn() } as never);
    const now = jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
    try {
      service.markLifecycleWorkerConfigured();
      service.markLifecycleWorkerSweepSucceeded(new Date(1_000_000), undefined, {
        pending: 1, processing: 0, quarantined: 0, oldestPendingAt: new Date(800_000), oldestProcessingAt: null,
      }, undefined, { pending: 2, processing: 1, failed: 0, newestFailedAt: null, oldestPendingAt: new Date(900_000), oldestProcessingAt: new Date(950_000) });
      service.markLifecycleWorkerAuditOutboxProcessed({ pending: 1, processing: 0, quarantined: 0, oldestPendingAt: new Date(800_000), oldestProcessingAt: null }, 12, 0, new Date(1_000_000));
      expect(service.workerReady()).toEqual(expect.objectContaining({ worker: 'ok', auditOutbox: expect.objectContaining({ pending: 1, oldestPendingAgeSeconds: 200, maxAgeSeconds: 300, pollIntervalSeconds: 5, lastBatchSigned: 12 }), notificationOutbox: expect.objectContaining({ pending: 2, processing: 1, oldestPendingAgeSeconds: 100 }) }));
      service.markLifecycleWorkerSweepSucceeded(new Date(1_000_000), undefined, {
        pending: 0, processing: 0, quarantined: 1, oldestPendingAt: null, oldestProcessingAt: null,
      });
      expect(() => service.workerReady()).toThrow('存在隔离的审计 outbox 事件');
      service.markLifecycleWorkerSweepSucceeded(new Date(1_000_000), undefined, {
        pending: 0, processing: 0, quarantined: 0, oldestPendingAt: null, oldestProcessingAt: null,
      }, undefined, {
        pending: 0, processing: 0, failed: 1, newestFailedAt: new Date(0), oldestPendingAt: null, oldestProcessingAt: null,
      });
      expect(service.workerReady()).toEqual(expect.objectContaining({ worker: 'ok', notificationOutbox: expect.objectContaining({ failed: 1, newestFailedAgeSeconds: 1_000 }) }));
      service.markLifecycleWorkerSweepSucceeded(new Date(1_000_000), undefined, {
        pending: 0, processing: 0, quarantined: 0, oldestPendingAt: null, oldestProcessingAt: null,
      }, undefined, {
        pending: 0, processing: 0, failed: 1, newestFailedAt: new Date(950_000), oldestPendingAt: null, oldestProcessingAt: null,
      });
      expect(() => service.workerReady()).toThrow('近期存在失败的通知 outbox 事件');
    } finally {
      now.mockRestore();
    }
  });

  it('reports expiry backlog and fails the worker probe when inventory or voucher cleanup falls behind', () => {
    delete process.env.DATABASE_URL;
    const service = new HealthService({ isInitialized: true, query: jest.fn(), showMigrations: jest.fn() } as never);
    const now = jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
    try {
      service.markLifecycleWorkerConfigured();
      service.markLifecycleWorkerSweepSucceeded(new Date(1_000_000), undefined, undefined, {
        overdueOrders: 2, overdueVouchers: 3, oldestOverdueOrderAt: new Date(700_000), oldestOverdueVoucherAt: new Date(800_000),
      });
      service.markLifecycleWorkerExpiryProcessed({ overdueOrders: 2, overdueVouchers: 3, oldestOverdueOrderAt: new Date(700_000), oldestOverdueVoucherAt: new Date(800_000) }, 4, 6, new Date(1_000_000));
      expect(service.workerReady()).toEqual(expect.objectContaining({
        worker: 'ok', expiryQueue: expect.objectContaining({ overdueOrders: 2, overdueVouchers: 3, oldestOverdueOrderAgeSeconds: 300, maxAgeSeconds: 600, pollIntervalSeconds: 10, lastBatchClosedOrders: 4, lastBatchExpiredVouchers: 6 }),
      }));
      service.markLifecycleWorkerSweepSucceeded(new Date(1_000_000), undefined, undefined, {
        overdueOrders: 1, overdueVouchers: 0, oldestOverdueOrderAt: new Date(399_000), oldestOverdueVoucherAt: null,
      });
      expect(() => service.workerReady()).toThrow('过期订单清扫超时');
      service.markLifecycleWorkerSweepSucceeded(new Date(1_000_000), undefined, undefined, {
        overdueOrders: 0, overdueVouchers: 1, oldestOverdueOrderAt: null, oldestOverdueVoucherAt: new Date(399_000),
      });
      expect(() => service.workerReady()).toThrow('过期券清扫超时');
    } finally {
      now.mockRestore();
    }
  });
});
