import { createHash } from 'crypto';

export type DatabaseRuntime = 'embedded-demo' | 'postgresql';
export type PostgresPoolOptions = {
  max: number;
  connectionTimeoutMillis: number;
  idleTimeoutMillis: number;
  statement_timeout: number;
  lock_timeout: number;
  options: string;
};

const REQUIRED_SHARED_RUNTIME_VALUES = ['DATABASE_URL', 'JWT_SECRET', 'VOUCHER_TOKEN_SECRET', 'THROTTLE_KEY_SECRET', 'DATA_ENCRYPTION_KEY', 'DATA_ENCRYPTION_KEY_ID', 'AUDIT_LOG_SIGNING_KEY', 'CORS_ORIGINS', 'WORKSPACE_ORIGIN_ROLES', 'RELEASE_ID', 'TZ'] as const;
const MINIMUM_SIGNING_SECRET_LENGTH = 32;
const RELEASE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const LOCAL_DEMO_DATA_ENCRYPTION_KEY = createHash('sha256').update('local-deals-demo-sensitive-data-key').digest();
const LOCAL_DEMO_AUDIT_LOG_SIGNING_KEY = createHash('sha256').update('local-deals-demo-audit-log-signing-key').digest();
const DATA_ENCRYPTION_KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export type DataEncryptionKey = { id: string; key: Buffer };
export type DataEncryptionKeyring = { active: DataEncryptionKey; previous: ReadonlyMap<string, Buffer> };
export type WorkspaceRole = 'PLATFORM_ADMIN' | 'AGENCY_ADMIN' | 'MERCHANT_ADMIN' | 'STORE_STAFF';
export type WorkspaceEntryRole = WorkspaceRole | 'ALL';
export type ChinaOperationalCalendar = { holidays: ReadonlySet<string>; workingDays: ReadonlySet<string>; validThrough: string | null };
const WORKSPACE_ROLES = new Set<WorkspaceRole>(['PLATFORM_ADMIN', 'AGENCY_ADMIN', 'MERCHANT_ADMIN', 'STORE_STAFF']);
const CALENDAR_DAY_PATTERN = /^\d{4}-(0[1-9]|1[0-2])-([0-2]\d|3[01])$/;

export function isLocalOrTestEnvironment(env: NodeJS.ProcessEnv = process.env): boolean {
  // A real database may be a shared staging resource even when a deployment
  // accidentally labels itself "development". Demo identities and mock
  // payment need an explicit local opt-in in that case.
  if (env.NODE_ENV === 'test') return true;
  if (env.NODE_ENV === 'development') return !env.DATABASE_URL || env.ALLOW_DEMO_MODE === 'true';
  return !env.NODE_ENV && !env.DATABASE_URL;
}

export function shouldSeedDemoData(env: NodeJS.ProcessEnv = process.env): boolean {
  return isLocalOrTestEnvironment(env);
}

/** A non-secret release identity ties health, API errors and static workspaces to one deployable version. */
export function releaseId(env: NodeJS.ProcessEnv = process.env): string {
  const value = String(env.RELEASE_ID || '').trim();
  if (!value) {
    if (!isLocalOrTestEnvironment(env)) throw new Error('非本地环境缺少 RELEASE_ID');
    return 'local-dev';
  }
  if (!RELEASE_ID_PATTERN.test(value)) throw new Error('RELEASE_ID 只能包含字母、数字、点、下划线或连字符，且长度为 1 至 128 位');
  return value;
}

function chinaCalendarDay(date: Date): string {
  const values = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(date).filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function parseChinaCalendarDay(value: string, name: string): string {
  if (!CALENDAR_DAY_PATTERN.test(value)) throw new Error(`${name} 必须是 YYYY-MM-DD 日期列表`);
  const parsed = new Date(`${value}T00:00:00+08:00`);
  if (Number.isNaN(parsed.getTime()) || chinaCalendarDay(parsed) !== value) throw new Error(`${name} 包含无效日期: ${value}`);
  return value;
}

function calendarDayList(value: string | undefined, name: string): Set<string> {
  const entries = String(value || '').split(',').map((entry) => entry.trim()).filter(Boolean);
  if (entries.length > 2_000) throw new Error(`${name} 最多包含 2000 个日期`);
  const days = new Set(entries.map((entry) => parseChinaCalendarDay(entry, name)));
  if (days.size !== entries.length) throw new Error(`${name} 不允许重复日期`);
  return days;
}

function nextChinaCalendarDay(day: string, offset: number): string {
  const date = new Date(`${parseChinaCalendarDay(day, '中国运营日历日期')}T12:00:00+08:00`);
  date.setUTCDate(date.getUTCDate() + offset);
  return chinaCalendarDay(date);
}

/**
 * China statutory holidays include compensatory working weekends. The calendar
 * is deployment configuration rather than source code so operations can update
 * it from the officially published annual schedule without an application release.
 */
export function chinaOperationalCalendar(env: NodeJS.ProcessEnv = process.env, now = new Date()): ChinaOperationalCalendar {
  const holidays = calendarDayList(env.CHINA_OPERATIONAL_HOLIDAYS, 'CHINA_OPERATIONAL_HOLIDAYS');
  const workingDays = calendarDayList(env.CHINA_OPERATIONAL_WORKDAYS, 'CHINA_OPERATIONAL_WORKDAYS');
  for (const day of workingDays) if (holidays.has(day)) throw new Error('CHINA_OPERATIONAL_HOLIDAYS 与 CHINA_OPERATIONAL_WORKDAYS 不允许包含同一日期');
  const rawValidThrough = String(env.CHINA_OPERATIONAL_CALENDAR_VALID_THROUGH || '').trim();
  const validThrough = rawValidThrough ? parseChinaCalendarDay(rawValidThrough, 'CHINA_OPERATIONAL_CALENDAR_VALID_THROUGH') : null;
  if (!isLocalOrTestEnvironment(env)) {
    if (!validThrough) throw new Error('非本地环境必须配置 CHINA_OPERATIONAL_CALENDAR_VALID_THROUGH');
    const minimumCoverage = nextChinaCalendarDay(chinaCalendarDay(now), 90);
    if (validThrough < minimumCoverage) throw new Error(`CHINA_OPERATIONAL_CALENDAR_VALID_THROUGH 至少需要覆盖至 ${minimumCoverage}`);
  }
  return { holidays, workingDays, validThrough };
}

export function isChinaOperationalWorkday(day: string, calendar: ChinaOperationalCalendar): boolean {
  parseChinaCalendarDay(day, '中国运营日历日期');
  if (calendar.validThrough && day > calendar.validThrough) throw new Error('中国运营日历有效期不足，请更新运营日历后重试');
  if (calendar.workingDays.has(day)) return true;
  if (calendar.holidays.has(day)) return false;
  const weekday = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Shanghai', weekday: 'short' }).format(new Date(`${day}T12:00:00+08:00`));
  return weekday !== 'Sat' && weekday !== 'Sun';
}

export function nextChinaOperationalWorkday(day: string, calendar: ChinaOperationalCalendar): string {
  for (let offset = 1; offset <= 370; offset += 1) {
    const candidate = nextChinaCalendarDay(day, offset);
    if (isChinaOperationalWorkday(candidate, calendar)) return candidate;
  }
  throw new Error('无法在运营日历中计算下一个工作日');
}

export function huifuDelayedSettlementEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.HUIFU_DELAYED_SETTLEMENT_ENABLED === 'true';
}
export function localDemoDataEncryptionKey(): Buffer {
  return Buffer.from(LOCAL_DEMO_DATA_ENCRYPTION_KEY);
}

export function throttleKeySecret(env: NodeJS.ProcessEnv = process.env): string {
  const configured = String(env.THROTTLE_KEY_SECRET || '').trim();
  if (!configured) {
    if (!isLocalOrTestEnvironment(env)) throw new Error('非本地环境缺少 THROTTLE_KEY_SECRET');
    return 'dev-throttle-key-secret';
  }
  return configured;
}

function decodeBase64Key(value: string, name: string): Buffer {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new Error(`${name} 必须是 32 字节 Base64 密钥`);
  const key = Buffer.from(value, 'base64');
  if (key.length !== 32) throw new Error(`${name} 必须是 32 字节 Base64 密钥`);
  return key;
}

function assertDataEncryptionKeyId(value: string, name: string): void {
  if (!DATA_ENCRYPTION_KEY_ID_PATTERN.test(value)) throw new Error(`${name} 只能包含字母、数字、_ 或 -，且长度为 1 至 64 位`);
}

/**
 * DATA_ENCRYPTION_PREVIOUS_KEYS uses comma-separated keyId:base64Key entries.
 * Keys are deliberately loaded at process start so every rotation is an
 * explicit deployment with a known, auditable key set.
 */
export function dataEncryptionKeyring(env: NodeJS.ProcessEnv = process.env): DataEncryptionKeyring {
  const activeKeyValue = String(env.DATA_ENCRYPTION_KEY || '').trim();
  const activeKeyId = String(env.DATA_ENCRYPTION_KEY_ID || '').trim();
  const previousKeyValue = String(env.DATA_ENCRYPTION_PREVIOUS_KEYS || '').trim();

  if (!activeKeyValue) {
    if (!isLocalOrTestEnvironment(env)) throw new Error('非本地环境缺少 DATA_ENCRYPTION_KEY');
    if (activeKeyId || previousKeyValue) throw new Error('配置 DATA_ENCRYPTION_KEY_ID 或 DATA_ENCRYPTION_PREVIOUS_KEYS 时必须同时配置 DATA_ENCRYPTION_KEY');
    return { active: { id: 'local-demo', key: localDemoDataEncryptionKey() }, previous: new Map() };
  }

  if (!activeKeyId) throw new Error('DATA_ENCRYPTION_KEY_ID 不能为空');
  assertDataEncryptionKeyId(activeKeyId, 'DATA_ENCRYPTION_KEY_ID');
  const previous = new Map<string, Buffer>();
  if (previousKeyValue) {
    for (const entry of previousKeyValue.split(',')) {
      const separator = entry.indexOf(':');
      const keyId = entry.slice(0, separator).trim();
      const keyValue = entry.slice(separator + 1).trim();
      if (separator <= 0 || !keyValue) throw new Error('DATA_ENCRYPTION_PREVIOUS_KEYS 格式应为 keyId:base64Key，多个密钥以逗号分隔');
      assertDataEncryptionKeyId(keyId, 'DATA_ENCRYPTION_PREVIOUS_KEYS 的密钥标识');
      if (keyId === activeKeyId || previous.has(keyId)) throw new Error('DATA_ENCRYPTION_PREVIOUS_KEYS 包含重复或活动密钥标识');
      previous.set(keyId, decodeBase64Key(keyValue, `DATA_ENCRYPTION_PREVIOUS_KEYS 中的 ${keyId}`));
    }
  }
  return { active: { id: activeKeyId, key: decodeBase64Key(activeKeyValue, 'DATA_ENCRYPTION_KEY') }, previous };
}

export function auditLogSigningKey(env: NodeJS.ProcessEnv = process.env): Buffer {
  const configured = String(env.AUDIT_LOG_SIGNING_KEY || '').trim();
  if (!configured) {
    if (!isLocalOrTestEnvironment(env)) throw new Error('非本地环境缺少 AUDIT_LOG_SIGNING_KEY');
    return Buffer.from(LOCAL_DEMO_AUDIT_LOG_SIGNING_KEY);
  }
  return decodeBase64Key(configured, 'AUDIT_LOG_SIGNING_KEY');
}

/** Browser origins are exact values, never suffix matches, so a sibling or
 * lookalike host cannot join the API CORS allow-list. */
export function allowedCorsOrigins(env: NodeJS.ProcessEnv = process.env): string[] {
  const configured = String(env.CORS_ORIGINS || env.CORS_ORIGIN || '').trim();
  if (!configured) {
    if (!isLocalOrTestEnvironment(env)) throw new Error('非本地环境缺少 CORS_ORIGINS');
    return ['http://localhost:5173'];
  }
  const origins = configured.split(',').map((origin) => origin.trim()).filter(Boolean);
  if (!origins.length || origins.length > 20) throw new Error('CORS_ORIGINS 必须包含 1 至 20 个来源');
  const normalized = origins.map((origin) => {
    let parsed: URL;
    try { parsed = new URL(origin); } catch { throw new Error(`CORS_ORIGINS 包含无效来源: ${origin}`); }
    if (parsed.origin !== origin || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
      throw new Error(`CORS_ORIGINS 必须是无路径、无凭据的来源: ${origin}`);
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error(`CORS_ORIGINS 仅允许 HTTP 或 HTTPS: ${origin}`);
    if (!isLocalOrTestEnvironment(env) && parsed.protocol !== 'https:') throw new Error(`非本地环境的 CORS_ORIGINS 必须使用 HTTPS: ${origin}`);
    return parsed.origin;
  });
  if (new Set(normalized).size !== normalized.length) throw new Error('CORS_ORIGINS 不允许重复来源');
  return normalized;
}

/** Maps exact browser origins to an optional entry-point role restriction.
 * ALL authorizes the shared portal origin while API resource authorization still checks JWT role and tenant scope. */
export function workspaceOriginRoles(env: NodeJS.ProcessEnv = process.env): ReadonlyMap<string, WorkspaceEntryRole> {
  const configured = String(env.WORKSPACE_ORIGIN_ROLES || '').trim();
  if (!configured) {
    if (!isLocalOrTestEnvironment(env)) throw new Error('非本地环境缺少 WORKSPACE_ORIGIN_ROLES');
    return new Map();
  }
  let parsed: unknown;
  try { parsed = JSON.parse(configured); } catch { throw new Error('WORKSPACE_ORIGIN_ROLES 必须是来源到角色的 JSON 对象'); }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw new Error('WORKSPACE_ORIGIN_ROLES 必须是来源到角色的 JSON 对象');
  const entries = Object.entries(parsed as Record<string, unknown>);
  if (!entries.length || entries.length > 20) throw new Error('WORKSPACE_ORIGIN_ROLES 必须包含 1 至 20 个来源');
  const result = new Map<string, WorkspaceEntryRole>();
  for (const [origin, role] of entries) {
    if (typeof role !== 'string' || (role !== 'ALL' && !WORKSPACE_ROLES.has(role as WorkspaceRole))) throw new Error(`WORKSPACE_ORIGIN_ROLES 的角色无效: ${origin}`);
    if (result.has(origin)) throw new Error(`WORKSPACE_ORIGIN_ROLES 包含重复来源: ${origin}`);
    result.set(origin, role as WorkspaceEntryRole);
  }
  return result;
}

/** Undefined means local/test mode has no origin-role restriction; null means a shared-origin login must be rejected. */
export function workspaceRoleForLoginOrigin(origin: string | undefined, env: NodeJS.ProcessEnv = process.env): WorkspaceRole | null | undefined {
  const roles = workspaceOriginRoles(env);
  if (!roles.size) return undefined;
  if (!origin) return null;
  const role = roles.get(origin);
  return role === 'ALL' ? undefined : role || null;
}

/**
 * Shared environments must fail before Nest starts when a demo secret would
 * make operator tokens, dynamic vouchers, or encrypted data predictable.
 */
export function assertSharedRuntimeConfiguration(env: NodeJS.ProcessEnv = process.env): void {
  if (isLocalOrTestEnvironment(env)) return;

  const missing = REQUIRED_SHARED_RUNTIME_VALUES.filter((key) => !String(env[key] || '').trim());
  if (missing.length) throw new Error(`非本地环境缺少必要配置: ${missing.join(', ')}`);
  // Schema changes must complete in a single, separately observed deployment
  // job before any new API instance starts receiving traffic. Letting every
  // replica migrate on boot creates lock contention and makes a rolling
  // rollback unsafe when old and new code run together.
  if (env.RUN_MIGRATIONS_ON_STARTUP === 'true') throw new Error('共享环境禁止在应用启动时执行迁移；请使用受控 migration-runner 任务');
  if (env.TZ !== 'UTC') throw new Error('共享环境 TZ 必须精确设置为 UTC，业务日期仅在展示和结算边界转换为 Asia/Shanghai');
  releaseId(env);

  const unsafeValues: Record<string, string[]> = {
    JWT_SECRET: ['dev-jwt-secret', 'replace-this-before-any-shared-deployment'],
    VOUCHER_TOKEN_SECRET: ['dev-voucher-secret', 'replace-this-before-any-shared-deployment'],
    THROTTLE_KEY_SECRET: ['dev-throttle-key-secret', 'replace-this-before-any-shared-deployment'],
  };
  const unsafe = Object.entries(unsafeValues)
    .filter(([key, values]) => values.includes(String(env[key]).trim()))
    .map(([key]) => key);
  if (unsafe.length) throw new Error(`非本地环境禁止使用演示或示例密钥: ${unsafe.join(', ')}`);

  const shortSecrets = ['JWT_SECRET', 'VOUCHER_TOKEN_SECRET', 'THROTTLE_KEY_SECRET'].filter((key) => String(env[key]).trim().length < MINIMUM_SIGNING_SECRET_LENGTH);
  if (shortSecrets.length) throw new Error(`非本地环境的签名密钥至少需要 ${MINIMUM_SIGNING_SECRET_LENGTH} 位: ${shortSecrets.join(', ')}`);
  const signingSecretValues = ['JWT_SECRET', 'VOUCHER_TOKEN_SECRET', 'THROTTLE_KEY_SECRET'].map((key) => String(env[key]).trim());
  if (new Set(signingSecretValues).size !== signingSecretValues.length) throw new Error('非本地环境的 JWT_SECRET、VOUCHER_TOKEN_SECRET 和 THROTTLE_KEY_SECRET 必须相互独立');

  const keyring = dataEncryptionKeyring(env);
  if (keyring.active.key.equals(LOCAL_DEMO_DATA_ENCRYPTION_KEY)) throw new Error('非本地环境禁止使用内置演示 DATA_ENCRYPTION_KEY');
  const auditKey = auditLogSigningKey(env);
  if (auditKey.equals(LOCAL_DEMO_AUDIT_LOG_SIGNING_KEY)) throw new Error('非本地环境禁止使用内置演示 AUDIT_LOG_SIGNING_KEY');
  const origins = allowedCorsOrigins(env);
  postgresPoolOptions(env);
  exportWorkerBatchSize(env);
  exportQueueMaxAgeMs(env);
  expiryQueueMaxAgeMs(env);
  expirySweepBatchSize(env);
  expirySweepPollIntervalMs(env);
  lifecycleSweepPollIntervalMs(env);
  paymentReconciliationPollIntervalMs(env);
  auditOutboxBatchSize(env);
  auditOutboxPollIntervalMs(env);
  auditOutboxMaxAgeMs(env);
  auditChainVerifyBatchSize(env);
  notificationFailureGraceMs(env);
  chinaOperationalCalendar(env);
  const workspaceOrigins = workspaceOriginRoles(env);
  if (![...workspaceOrigins.values()].includes('ALL')) {
    for (const requiredRole of ['PLATFORM_ADMIN', 'AGENCY_ADMIN', 'MERCHANT_ADMIN'] as const) {
      if (![...workspaceOrigins.values()].includes(requiredRole)) throw new Error(`WORKSPACE_ORIGIN_ROLES 缺少 ${requiredRole} 工作台`);
    }
  }
  for (const origin of workspaceOrigins.keys()) {
    if (!origins.includes(origin)) throw new Error(`WORKSPACE_ORIGIN_ROLES 来源未包含在 CORS_ORIGINS: ${origin}`);
  }
}

export function resolveDatabaseRuntime(env: NodeJS.ProcessEnv = process.env): DatabaseRuntime {
  const isLocalOrTest = isLocalOrTestEnvironment(env);
  if (env.USE_PG_MEM === 'true') {
    if (!isLocalOrTest) throw new Error('内嵌演示数据库仅允许本地开发或测试环境');
    return 'embedded-demo';
  }
  if (env.DATABASE_URL) return 'postgresql';
  if (isLocalOrTest) return 'embedded-demo';
  throw new Error('非本地环境必须配置 DATABASE_URL，禁止回退到内嵌演示数据库');
}

export function usesEmbeddedDatabase(env: NodeJS.ProcessEnv = process.env): boolean {
  return resolveDatabaseRuntime(env) === 'embedded-demo';
}

function databaseInteger(env: NodeJS.ProcessEnv, name: string, defaultValue: number, minimum: number, maximum: number): number {
  const raw = String(env[name] ?? defaultValue).trim();
  if (!/^[0-9]+$/.test(raw)) throw new Error(`${name} 必须是 ${minimum} 至 ${maximum} 的整数`);
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) throw new Error(`${name} 必须是 ${minimum} 至 ${maximum} 的整数`);
  return value;
}

export function postgresPoolOptions(env: NodeJS.ProcessEnv = process.env): PostgresPoolOptions {
  return {
    max: databaseInteger(env, 'DB_POOL_MAX', 10, 1, 50),
    connectionTimeoutMillis: databaseInteger(env, 'DB_CONNECTION_TIMEOUT_MS', 5_000, 1_000, 30_000),
    idleTimeoutMillis: databaseInteger(env, 'DB_IDLE_TIMEOUT_MS', 30_000, 10_000, 300_000),
    statement_timeout: databaseInteger(env, 'DB_STATEMENT_TIMEOUT_MS', 30_000, 1_000, 120_000),
    lock_timeout: databaseInteger(env, 'DB_LOCK_TIMEOUT_MS', 5_000, 100, 60_000),
    options: '-c timezone=UTC',
  };
}

export function trustedProxyHops(env: NodeJS.ProcessEnv = process.env): number | undefined {
  const value = env.TRUST_PROXY_HOPS;
  if (!value) return undefined;
  if (!/^[1-3]$/.test(value)) throw new Error('TRUST_PROXY_HOPS 必须是 1 至 3 的整数');
  return Number(value);
}

/** A lifecycle worker sweeps every 60 seconds. Three missed intervals is unhealthy by default. */
export function lifecycleWorkerMaxStalenessMs(env: NodeJS.ProcessEnv = process.env): number {
  const value = String(env.LIFECYCLE_WORKER_MAX_STALENESS_SECONDS || '180').trim();
  if (!/^[0-9]+$/.test(value)) throw new Error('LIFECYCLE_WORKER_MAX_STALENESS_SECONDS 必须是 120 至 900 的整数');
  const seconds = Number(value);
  if (!Number.isInteger(seconds) || seconds < 120 || seconds > 900) throw new Error('LIFECYCLE_WORKER_MAX_STALENESS_SECONDS 必须是 120 至 900 的整数');
  return seconds * 1000;
}

/** The full sweep handles imports, batch operations, billing, and recovery. */
export function lifecycleSweepPollIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  return databaseInteger(env, 'LIFECYCLE_SWEEP_POLL_INTERVAL_SECONDS', 60, 5, 300) * 1000;
}

/** Payment reconciliation runs far faster than the full lifecycle sweep so freshly paid orders confirm within seconds instead of minutes. */
export function paymentReconciliationPollIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  return databaseInteger(env, 'PAYMENT_RECONCILE_POLL_INTERVAL_SECONDS', 10, 5, 60) * 1000;
}

/** Terminal notification dead letters older than this window no longer block worker liveness; recent failures still flag an active provider problem. */
export function notificationFailureGraceMs(env: NodeJS.ProcessEnv = process.env): number {
  return databaseInteger(env, 'NOTIFICATION_FAILURE_GRACE_SECONDS', 900, 60, 3_600) * 1000;
}

/** Limits one lifecycle sweep so export generation cannot starve expiry, billing, or payment recovery work. */
export function exportWorkerBatchSize(env: NodeJS.ProcessEnv = process.env): number {
  return databaseInteger(env, 'EXPORT_WORKER_BATCH_SIZE', 3, 1, 10);
}

/** The worker health endpoint becomes unavailable when queued work exceeds this operational latency budget. */
export function exportQueueMaxAgeMs(env: NodeJS.ProcessEnv = process.env): number {
  return databaseInteger(env, 'EXPORT_QUEUE_MAX_AGE_SECONDS', 600, 120, 3_600) * 1000;
}

/** Expiry work protects inventory and voucher correctness, so sustained backlog is unhealthy even when the worker still runs. */
export function expiryQueueMaxAgeMs(env: NodeJS.ProcessEnv = process.env): number {
  return databaseInteger(env, 'EXPIRY_QUEUE_MAX_AGE_SECONDS', 600, 120, 3_600) * 1000;
}

/** Caps one expiry pass so inventory repair remains predictable under a backlog. */
export function expirySweepBatchSize(env: NodeJS.ProcessEnv = process.env): number {
  return databaseInteger(env, 'EXPIRY_SWEEP_BATCH_SIZE', 200, 1, 1_000);
}

/** Expiry runs independently from billing/export work to shorten inventory recovery time. */
export function expirySweepPollIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  return databaseInteger(env, 'EXPIRY_SWEEP_POLL_INTERVAL_SECONDS', 10, 5, 60) * 1000;
}

/** Auditing is lightweight but must never consume an unbounded lifecycle sweep. */
export function auditOutboxBatchSize(env: NodeJS.ProcessEnv = process.env): number {
  return databaseInteger(env, 'AUDIT_OUTBOX_BATCH_SIZE', 100, 1, 500);
}

/** Audit signing is isolated from slower lifecycle work so its durable queue has a bounded delivery cadence. */
export function auditOutboxPollIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  return databaseInteger(env, 'AUDIT_OUTBOX_POLL_INTERVAL_SECONDS', 5, 1, 60) * 1000;
}

/** Signing backlog is an integrity delivery risk, so the worker probe enforces a finite budget. */
export function auditOutboxMaxAgeMs(env: NodeJS.ProcessEnv = process.env): number {
  return databaseInteger(env, 'AUDIT_OUTBOX_MAX_AGE_SECONDS', 300, 120, 3_600) * 1000;
}

/** Full integrity verification scans immutable history in bounded pages. */
export function auditChainVerifyBatchSize(env: NodeJS.ProcessEnv = process.env): number {
  return databaseInteger(env, 'AUDIT_CHAIN_VERIFY_BATCH_SIZE', 500, 50, 10_000);
}
