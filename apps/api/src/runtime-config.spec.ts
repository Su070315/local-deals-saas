import { allowedCorsOrigins, assertSharedRuntimeConfiguration, auditChainVerifyBatchSize, auditOutboxBatchSize, auditOutboxMaxAgeMs, auditOutboxPollIntervalMs, chinaOperationalCalendar, expiryQueueMaxAgeMs, expirySweepBatchSize, expirySweepPollIntervalMs, exportQueueMaxAgeMs, exportWorkerBatchSize, isChinaOperationalWorkday, isLocalOrTestEnvironment, lifecycleSweepPollIntervalMs, lifecycleWorkerMaxStalenessMs, localDemoDataEncryptionKey, nextChinaOperationalWorkday, postgresPoolOptions, releaseId, resolveDatabaseRuntime, shouldSeedDemoData, throttleKeySecret, trustedProxyHops, usesEmbeddedDatabase, workspaceOriginRoles, workspaceRoleForLoginOrigin } from './runtime-config';

function sharedRuntime(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'staging',
    DATABASE_URL: 'postgres://shared-db',
    JWT_SECRET: 'operator-signing-secret-that-is-long-enough',
    VOUCHER_TOKEN_SECRET: 'voucher-signing-secret-that-is-long-enough',
    THROTTLE_KEY_SECRET: 'throttle-signing-secret-that-is-long-enough',
    DATA_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
    DATA_ENCRYPTION_KEY_ID: 'data-2026-07',
    AUDIT_LOG_SIGNING_KEY: Buffer.alloc(32, 11).toString('base64'),
    CHINA_OPERATIONAL_HOLIDAYS: '2026-10-01,2026-10-02',
    CHINA_OPERATIONAL_WORKDAYS: '2026-10-10',
    CHINA_OPERATIONAL_CALENDAR_VALID_THROUGH: '2099-12-31',
    CORS_ORIGINS: 'https://platform.example.com,https://agency.example.com,https://merchant.example.com',
    WORKSPACE_ORIGIN_ROLES: JSON.stringify({ 'https://platform.example.com': 'PLATFORM_ADMIN', 'https://agency.example.com': 'AGENCY_ADMIN', 'https://merchant.example.com': 'MERCHANT_ADMIN' }),
    RELEASE_ID: 'release-2026.07.19.1',
    TZ: 'UTC',
    ...overrides,
  };
}

describe('database runtime configuration', () => {
  it('permits the embedded demonstration database only for local development and tests', () => {
    expect(resolveDatabaseRuntime({ NODE_ENV: 'development' })).toBe('embedded-demo');
    expect(resolveDatabaseRuntime({ NODE_ENV: 'test', USE_PG_MEM: 'true' })).toBe('embedded-demo');
    expect(usesEmbeddedDatabase({ NODE_ENV: 'test', DATABASE_URL: 'postgres://ignored', USE_PG_MEM: 'true' })).toBe(true);
  });

  it('requires a real database for shared deployment environments', () => {
    expect(resolveDatabaseRuntime({ NODE_ENV: 'staging', DATABASE_URL: 'postgres://shared-db' })).toBe('postgresql');
    expect(() => resolveDatabaseRuntime({ NODE_ENV: 'staging' })).toThrow('非本地环境必须配置 DATABASE_URL');
    expect(() => resolveDatabaseRuntime({ NODE_ENV: 'staging', USE_PG_MEM: 'true' })).toThrow('内嵌演示数据库仅允许本地开发或测试环境');
  });

  it('fails closed when a real database is configured without an explicit runtime environment', () => {
    const ambiguous = { DATABASE_URL: 'postgres://could-be-shared' };
    expect(isLocalOrTestEnvironment(ambiguous)).toBe(false);
    expect(shouldSeedDemoData(ambiguous)).toBe(false);
    expect(() => assertSharedRuntimeConfiguration(ambiguous)).toThrow('非本地环境缺少必要配置');
    expect(resolveDatabaseRuntime({})).toBe('embedded-demo');
  });

  it('requires an explicit local-demo opt-in before a development process with a real database receives demo capabilities', () => {
    const localDatabase = { NODE_ENV: 'development', DATABASE_URL: 'postgres://local-db' };
    expect(isLocalOrTestEnvironment(localDatabase)).toBe(false);
    expect(shouldSeedDemoData(localDatabase)).toBe(false);
    expect(() => assertSharedRuntimeConfiguration(localDatabase)).toThrow('非本地环境缺少必要配置');
    expect(isLocalOrTestEnvironment({ ...localDatabase, ALLOW_DEMO_MODE: 'true' })).toBe(true);
    expect(shouldSeedDemoData({ ...localDatabase, ALLOW_DEMO_MODE: 'true' })).toBe(true);
  });

  it('requires independent, non-demo secrets before a shared environment starts', () => {
    expect(() => assertSharedRuntimeConfiguration(sharedRuntime())).not.toThrow();
    expect(() => assertSharedRuntimeConfiguration(sharedRuntime({ JWT_SECRET: 'dev-jwt-secret' }))).toThrow('禁止使用演示或示例密钥: JWT_SECRET');
    expect(() => assertSharedRuntimeConfiguration(sharedRuntime({ VOUCHER_TOKEN_SECRET: 'short' }))).toThrow('签名密钥至少需要 32 位: VOUCHER_TOKEN_SECRET');
    expect(() => assertSharedRuntimeConfiguration(sharedRuntime({ THROTTLE_KEY_SECRET: 'short' }))).toThrow('签名密钥至少需要 32 位: THROTTLE_KEY_SECRET');
    expect(() => assertSharedRuntimeConfiguration(sharedRuntime({ THROTTLE_KEY_SECRET: sharedRuntime().JWT_SECRET }))).toThrow('必须相互独立');
    expect(() => assertSharedRuntimeConfiguration(sharedRuntime({ DATA_ENCRYPTION_KEY: 'not-a-base64-key!' }))).toThrow('DATA_ENCRYPTION_KEY 必须是 32 字节 Base64 密钥');
    expect(() => assertSharedRuntimeConfiguration(sharedRuntime({ DATA_ENCRYPTION_KEY: localDemoDataEncryptionKey().toString('base64') }))).toThrow('禁止使用内置演示 DATA_ENCRYPTION_KEY');
    expect(() => assertSharedRuntimeConfiguration(sharedRuntime({ DATA_ENCRYPTION_KEY_ID: '' }))).toThrow('非本地环境缺少必要配置: DATA_ENCRYPTION_KEY_ID');
    expect(() => assertSharedRuntimeConfiguration(sharedRuntime({ DATA_ENCRYPTION_PREVIOUS_KEYS: 'data-old:not-a-base64-key!' }))).toThrow('DATA_ENCRYPTION_PREVIOUS_KEYS 中的 data-old 必须是 32 字节 Base64 密钥');
    expect(() => assertSharedRuntimeConfiguration(sharedRuntime({ AUDIT_LOG_SIGNING_KEY: 'not-a-base64-key!' }))).toThrow('AUDIT_LOG_SIGNING_KEY 必须是 32 字节 Base64 密钥');
    expect(() => assertSharedRuntimeConfiguration(sharedRuntime({ AUDIT_LOG_SIGNING_KEY: '' }))).toThrow('非本地环境缺少必要配置: AUDIT_LOG_SIGNING_KEY');
    expect(() => assertSharedRuntimeConfiguration(sharedRuntime({ CORS_ORIGINS: '' }))).toThrow('非本地环境缺少必要配置: CORS_ORIGINS');
    expect(() => assertSharedRuntimeConfiguration(sharedRuntime({ WORKSPACE_ORIGIN_ROLES: '' }))).toThrow('非本地环境缺少必要配置: WORKSPACE_ORIGIN_ROLES');
    expect(() => assertSharedRuntimeConfiguration(sharedRuntime({ RELEASE_ID: '' }))).toThrow('非本地环境缺少必要配置: RELEASE_ID');
    expect(() => assertSharedRuntimeConfiguration(sharedRuntime({ RELEASE_ID: 'invalid release id' }))).toThrow('RELEASE_ID 只能包含');
    expect(() => assertSharedRuntimeConfiguration(sharedRuntime({ RUN_MIGRATIONS_ON_STARTUP: 'true' }))).toThrow('共享环境禁止在应用启动时执行迁移');
    expect(() => assertSharedRuntimeConfiguration(sharedRuntime({ TZ: 'Asia/Shanghai' }))).toThrow('TZ 必须精确设置为 UTC');
    expect(() => assertSharedRuntimeConfiguration(sharedRuntime({ TZ: '' }))).toThrow('非本地环境缺少必要配置: TZ');
    expect(() => assertSharedRuntimeConfiguration({ NODE_ENV: 'development' })).not.toThrow();
    expect(throttleKeySecret({ NODE_ENV: 'development' })).toBe('dev-throttle-key-secret');
    expect(() => throttleKeySecret({ NODE_ENV: 'staging' })).toThrow('非本地环境缺少 THROTTLE_KEY_SECRET');
  });

  it('provides a safe local release label and validates shared release labels', () => {
    expect(releaseId({ NODE_ENV: 'development' })).toBe('local-dev');
    expect(releaseId(sharedRuntime())).toBe('release-2026.07.19.1');
    expect(() => releaseId({ NODE_ENV: 'staging' })).toThrow('非本地环境缺少 RELEASE_ID');
  });

  it('seeds demo accounts only on local development or test runtimes', () => {
    expect(shouldSeedDemoData({ NODE_ENV: 'development' })).toBe(true);
    expect(shouldSeedDemoData({ NODE_ENV: 'test' })).toBe(true);
    expect(shouldSeedDemoData({ NODE_ENV: 'staging' })).toBe(false);
    expect(shouldSeedDemoData({ NODE_ENV: 'production' })).toBe(false);
  });

  it('requires an explicit, bounded hop count before trusting forwarded client addresses', () => {
    expect(trustedProxyHops({})).toBeUndefined();
    expect(trustedProxyHops({ TRUST_PROXY_HOPS: '1' })).toBe(1);
    expect(() => trustedProxyHops({ TRUST_PROXY_HOPS: '0' })).toThrow('TRUST_PROXY_HOPS 必须是 1 至 3 的整数');
    expect(() => trustedProxyHops({ TRUST_PROXY_HOPS: '4' })).toThrow('TRUST_PROXY_HOPS 必须是 1 至 3 的整数');
  });

  it('bounds PostgreSQL pool and query settings before a shared instance starts', () => {
    expect(postgresPoolOptions({})).toEqual({ max: 10, connectionTimeoutMillis: 5_000, idleTimeoutMillis: 30_000, statement_timeout: 30_000, lock_timeout: 5_000, options: '-c timezone=UTC' });
    expect(postgresPoolOptions({ DB_POOL_MAX: '16', DB_CONNECTION_TIMEOUT_MS: '8000', DB_IDLE_TIMEOUT_MS: '45000', DB_STATEMENT_TIMEOUT_MS: '60000', DB_LOCK_TIMEOUT_MS: '10000' })).toEqual({ max: 16, connectionTimeoutMillis: 8_000, idleTimeoutMillis: 45_000, statement_timeout: 60_000, lock_timeout: 10_000, options: '-c timezone=UTC' });
    expect(() => postgresPoolOptions({ DB_POOL_MAX: '0' })).toThrow('DB_POOL_MAX 必须是 1 至 50 的整数');
    expect(() => postgresPoolOptions({ DB_STATEMENT_TIMEOUT_MS: '120001' })).toThrow('DB_STATEMENT_TIMEOUT_MS 必须是 1000 至 120000 的整数');
    expect(() => assertSharedRuntimeConfiguration(sharedRuntime({ DB_LOCK_TIMEOUT_MS: '99' }))).toThrow('DB_LOCK_TIMEOUT_MS 必须是 100 至 60000 的整数');
  });

  it('bounds lifecycle worker heartbeat freshness to a monitorable interval', () => {
    expect(lifecycleWorkerMaxStalenessMs({})).toBe(180_000);
    expect(lifecycleWorkerMaxStalenessMs({ LIFECYCLE_WORKER_MAX_STALENESS_SECONDS: '120' })).toBe(120_000);
    expect(() => lifecycleWorkerMaxStalenessMs({ LIFECYCLE_WORKER_MAX_STALENESS_SECONDS: '119' })).toThrow('必须是 120 至 900 的整数');
    expect(() => lifecycleWorkerMaxStalenessMs({ LIFECYCLE_WORKER_MAX_STALENESS_SECONDS: 'not-a-number' })).toThrow('必须是 120 至 900 的整数');
  });

  it('bounds the full lifecycle sweep cadence used by queued operations', () => {
    expect(lifecycleSweepPollIntervalMs({})).toBe(60_000);
    expect(lifecycleSweepPollIntervalMs({ LIFECYCLE_SWEEP_POLL_INTERVAL_SECONDS: '5' })).toBe(5_000);
    expect(lifecycleSweepPollIntervalMs({ LIFECYCLE_SWEEP_POLL_INTERVAL_SECONDS: '120' })).toBe(120_000);
    expect(() => lifecycleSweepPollIntervalMs({ LIFECYCLE_SWEEP_POLL_INTERVAL_SECONDS: '4' })).toThrow('LIFECYCLE_SWEEP_POLL_INTERVAL_SECONDS 必须是 5 至 300 的整数');
    expect(() => assertSharedRuntimeConfiguration(sharedRuntime({ LIFECYCLE_SWEEP_POLL_INTERVAL_SECONDS: '301' }))).toThrow('LIFECYCLE_SWEEP_POLL_INTERVAL_SECONDS 必须是 5 至 300 的整数');
  });

  it('bounds export worker throughput and its queue-latency alert budget', () => {
    expect(exportWorkerBatchSize({})).toBe(3);
    expect(exportWorkerBatchSize({ EXPORT_WORKER_BATCH_SIZE: '8' })).toBe(8);
    expect(() => exportWorkerBatchSize({ EXPORT_WORKER_BATCH_SIZE: '0' })).toThrow('EXPORT_WORKER_BATCH_SIZE 必须是 1 至 10 的整数');
    expect(exportQueueMaxAgeMs({})).toBe(600_000);
    expect(exportQueueMaxAgeMs({ EXPORT_QUEUE_MAX_AGE_SECONDS: '900' })).toBe(900_000);
    expect(() => exportQueueMaxAgeMs({ EXPORT_QUEUE_MAX_AGE_SECONDS: '119' })).toThrow('EXPORT_QUEUE_MAX_AGE_SECONDS 必须是 120 至 3600 的整数');
    expect(() => assertSharedRuntimeConfiguration(sharedRuntime({ EXPORT_WORKER_BATCH_SIZE: '11' }))).toThrow('EXPORT_WORKER_BATCH_SIZE 必须是 1 至 10 的整数');
  });

  it('bounds expiry backlog latency before a shared instance starts', () => {
    expect(expiryQueueMaxAgeMs({})).toBe(600_000);
    expect(expiryQueueMaxAgeMs({ EXPIRY_QUEUE_MAX_AGE_SECONDS: '900' })).toBe(900_000);
    expect(() => expiryQueueMaxAgeMs({ EXPIRY_QUEUE_MAX_AGE_SECONDS: '119' })).toThrow('EXPIRY_QUEUE_MAX_AGE_SECONDS 必须是 120 至 3600 的整数');
    expect(() => assertSharedRuntimeConfiguration(sharedRuntime({ EXPIRY_QUEUE_MAX_AGE_SECONDS: '3601' }))).toThrow('EXPIRY_QUEUE_MAX_AGE_SECONDS 必须是 120 至 3600 的整数');
  });

  it('bounds independent expiry queue throughput and polling cadence', () => {
    expect(expirySweepBatchSize({})).toBe(200);
    expect(expirySweepBatchSize({ EXPIRY_SWEEP_BATCH_SIZE: '600' })).toBe(600);
    expect(() => expirySweepBatchSize({ EXPIRY_SWEEP_BATCH_SIZE: '1001' })).toThrow('EXPIRY_SWEEP_BATCH_SIZE 必须是 1 至 1000 的整数');
    expect(expirySweepPollIntervalMs({})).toBe(10_000);
    expect(expirySweepPollIntervalMs({ EXPIRY_SWEEP_POLL_INTERVAL_SECONDS: '30' })).toBe(30_000);
    expect(() => expirySweepPollIntervalMs({ EXPIRY_SWEEP_POLL_INTERVAL_SECONDS: '4' })).toThrow('EXPIRY_SWEEP_POLL_INTERVAL_SECONDS 必须是 5 至 60 的整数');
    expect(() => assertSharedRuntimeConfiguration(sharedRuntime({ EXPIRY_SWEEP_POLL_INTERVAL_SECONDS: '61' }))).toThrow('EXPIRY_SWEEP_POLL_INTERVAL_SECONDS 必须是 5 至 60 的整数');
  });

  it('bounds audit outbox signing throughput and delivery latency', () => {
    expect(auditOutboxBatchSize({})).toBe(100);
    expect(auditOutboxBatchSize({ AUDIT_OUTBOX_BATCH_SIZE: '250' })).toBe(250);
    expect(() => auditOutboxBatchSize({ AUDIT_OUTBOX_BATCH_SIZE: '501' })).toThrow('AUDIT_OUTBOX_BATCH_SIZE 必须是 1 至 500 的整数');
    expect(auditOutboxPollIntervalMs({})).toBe(5_000);
    expect(auditOutboxPollIntervalMs({ AUDIT_OUTBOX_POLL_INTERVAL_SECONDS: '10' })).toBe(10_000);
    expect(() => auditOutboxPollIntervalMs({ AUDIT_OUTBOX_POLL_INTERVAL_SECONDS: '0' })).toThrow('AUDIT_OUTBOX_POLL_INTERVAL_SECONDS 必须是 1 至 60 的整数');
    expect(auditOutboxMaxAgeMs({})).toBe(300_000);
    expect(auditOutboxMaxAgeMs({ AUDIT_OUTBOX_MAX_AGE_SECONDS: '900' })).toBe(900_000);
    expect(() => auditOutboxMaxAgeMs({ AUDIT_OUTBOX_MAX_AGE_SECONDS: '119' })).toThrow('AUDIT_OUTBOX_MAX_AGE_SECONDS 必须是 120 至 3600 的整数');
    expect(() => assertSharedRuntimeConfiguration(sharedRuntime({ AUDIT_OUTBOX_BATCH_SIZE: '0' }))).toThrow('AUDIT_OUTBOX_BATCH_SIZE 必须是 1 至 500 的整数');
  });

  it('bounds audit chain verification pages before a shared instance starts', () => {
    expect(auditChainVerifyBatchSize({})).toBe(500);
    expect(auditChainVerifyBatchSize({ AUDIT_CHAIN_VERIFY_BATCH_SIZE: '1000' })).toBe(1_000);
    expect(() => auditChainVerifyBatchSize({ AUDIT_CHAIN_VERIFY_BATCH_SIZE: '49' })).toThrow('AUDIT_CHAIN_VERIFY_BATCH_SIZE 必须是 50 至 10000 的整数');
    expect(() => assertSharedRuntimeConfiguration(sharedRuntime({ AUDIT_CHAIN_VERIFY_BATCH_SIZE: '10001' }))).toThrow('AUDIT_CHAIN_VERIFY_BATCH_SIZE 必须是 50 至 10000 的整数');
  });

  it('calculates China operating days with statutory holidays and compensatory workdays', () => {
    const calendar = chinaOperationalCalendar({ NODE_ENV: 'development', CHINA_OPERATIONAL_HOLIDAYS: '2026-10-01,2026-10-02', CHINA_OPERATIONAL_WORKDAYS: '2026-10-10' });
    expect(nextChinaOperationalWorkday('2026-09-30', calendar)).toBe('2026-10-05');
    expect(isChinaOperationalWorkday('2026-10-10', calendar)).toBe(true);
    expect(isChinaOperationalWorkday('2026-10-11', calendar)).toBe(false);
    expect(() => chinaOperationalCalendar({ ...sharedRuntime(), CHINA_OPERATIONAL_CALENDAR_VALID_THROUGH: '' })).toThrow('必须配置 CHINA_OPERATIONAL_CALENDAR_VALID_THROUGH');
    expect(() => chinaOperationalCalendar({ ...sharedRuntime(), CHINA_OPERATIONAL_CALENDAR_VALID_THROUGH: '2026-01-01' }, new Date('2026-07-01T00:00:00+08:00'))).toThrow('至少需要覆盖');
  });

  it('accepts exact browser workspace origins and rejects unsafe shared-origin configuration', () => {
    expect(allowedCorsOrigins({ NODE_ENV: 'development' })).toEqual(['http://localhost:5173']);
    expect(allowedCorsOrigins(sharedRuntime())).toEqual(['https://platform.example.com', 'https://agency.example.com', 'https://merchant.example.com']);
    expect(() => allowedCorsOrigins(sharedRuntime({ CORS_ORIGINS: 'http://platform.example.com' }))).toThrow('必须使用 HTTPS');
    expect(() => allowedCorsOrigins(sharedRuntime({ CORS_ORIGINS: 'https://platform.example.com/admin' }))).toThrow('无路径');
    expect(() => allowedCorsOrigins(sharedRuntime({ CORS_ORIGINS: 'https://platform.example.com,https://platform.example.com' }))).toThrow('不允许重复来源');
    expect(workspaceOriginRoles(sharedRuntime())).toEqual(new Map([['https://platform.example.com', 'PLATFORM_ADMIN'], ['https://agency.example.com', 'AGENCY_ADMIN'], ['https://merchant.example.com', 'MERCHANT_ADMIN']]));
    expect(workspaceRoleForLoginOrigin('https://merchant.example.com', sharedRuntime())).toBe('MERCHANT_ADMIN');
    expect(workspaceRoleForLoginOrigin('https://unknown.example.com', sharedRuntime())).toBeNull();
    expect(workspaceRoleForLoginOrigin(undefined, sharedRuntime())).toBeNull();
    const unifiedPortal = sharedRuntime({
      CORS_ORIGINS: 'https://ops.example.com',
      WORKSPACE_ORIGIN_ROLES: JSON.stringify({ 'https://ops.example.com': 'ALL' }),
    });
    expect(workspaceOriginRoles(unifiedPortal)).toEqual(new Map([['https://ops.example.com', 'ALL']]));
    expect(workspaceRoleForLoginOrigin('https://ops.example.com', unifiedPortal)).toBeUndefined();
    expect(workspaceRoleForLoginOrigin('https://unknown.example.com', unifiedPortal)).toBeNull();
    expect(() => assertSharedRuntimeConfiguration(unifiedPortal)).not.toThrow();
    expect(() => assertSharedRuntimeConfiguration(sharedRuntime({ WORKSPACE_ORIGIN_ROLES: JSON.stringify({ 'https://platform.example.com': 'PLATFORM_ADMIN' }) }))).toThrow('缺少 AGENCY_ADMIN 工作台');
    expect(() => assertSharedRuntimeConfiguration(sharedRuntime({ WORKSPACE_ORIGIN_ROLES: JSON.stringify({ 'https://unknown.example.com': 'PLATFORM_ADMIN', 'https://agency.example.com': 'AGENCY_ADMIN', 'https://merchant.example.com': 'MERCHANT_ADMIN' }) }))).toThrow('未包含在 CORS_ORIGINS');
  });
});
