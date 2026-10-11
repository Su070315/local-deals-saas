import { parseLastJsonLine } from './docker-smoke-support.mjs';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function diagnostic(label, value) {
  return `${label}：${JSON.stringify(value)}`;
}

function markerPath(prefix) {
  return `/tmp/local-deals-outbox-smoke-${prefix}.ready`;
}

function runnerArgs(service, command, prefix, count, { delay = false, startAt = null, detached = false, lockTimeoutMs = null } = {}) {
  return [
    'exec', '-T', ...(detached ? ['-d'] : []), '-e', 'ALLOW_OUTBOX_SMOKE=true',
    ...(delay ? ['-e', 'MOCK_OUTBOX_SEND_DELAY_MS=20', '-e', 'MOCK_OUTBOX_SIGN_DELAY_MS=20'] : []),
    ...(startAt ? ['-e', `OUTBOX_SMOKE_START_AT=${startAt}`] : []),
    ...(lockTimeoutMs ? ['-e', `DB_LOCK_TIMEOUT_MS=${lockTimeoutMs}`] : []),
    service, 'node', 'apps/api/dist/outbox-smoke-runner.js', command, prefix, String(count),
  ];
}

async function runRunner(compose, service, command, prefix, count, options = {}) {
  const result = await compose(runnerArgs(service, command, prefix, count, options), { capture: true, timeoutMs: 120_000 });
  return parseLastJsonLine(result.stdout);
}

async function startDetachedRunner(compose, service, command, prefix, count) {
  await compose(runnerArgs(service, command, prefix, count, { detached: true }), { capture: true, timeoutMs: 30_000 });
}

async function waitForBackendPid(compose, service, prefix) {
  const deadline = Date.now() + 30_000;
  do {
    const result = await compose(['exec', '-T', service, 'cat', markerPath(prefix)], { capture: true, allowFailure: true, timeoutMs: 5_000 });
    if (result.code === 0) {
      const match = result.stdout.match(/(\d+)\s*$/);
      if (match && Number.isSafeInteger(Number(match[1])) && Number(match[1]) > 0) return Number(match[1]);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  throw new Error('持锁支付事务未在 30 秒内写入 PostgreSQL 后端进程标识');
}

async function terminateBackend(compose, backendPid) {
  const result = await compose([
    'exec', '-T', 'postgres', 'psql', '-U', 'localdeals', '-d', 'local_deals', '-Atc',
    `SELECT pg_terminate_backend(${backendPid});`,
  ], { capture: true, timeoutMs: 10_000 });
  return result.stdout.trim().split(/\r?\n/).at(-1) === 't';
}

/** Run the durable outboxes from two independently booted Nest contexts. */
export async function runDockerOutboxSmoke({ compose, suffix }) {
  const notificationPrefix = `notify-${suffix}`;
  const auditPrefix = `audit-${suffix}`;
  const tamperPrefix = `audit-tamper-${suffix}`;
  const paymentPrefix = `payment-${suffix}`;
  const interruptionPrefix = `payment-interrupt-${suffix}`;
  const notificationCount = 80;
  const auditCount = 40;
  const paymentCount = 40;
  const notificationWorkerLimit = Math.ceil(notificationCount / 2);
  const auditWorkerLimit = Math.ceil(auditCount / 2);
  const paymentWorkerLimit = Math.ceil(paymentCount / 2);

  await runRunner(compose, 'api-1', 'seed-notification', notificationPrefix, notificationCount);
  await runRunner(compose, 'api-1', 'mark-notification-stale', notificationPrefix, notificationCount);
  const notificationStartAt = Date.now() + 8_000;
  const [notificationFirst, notificationSecond] = await Promise.all([
    runRunner(compose, 'api-1', 'process-notification', notificationPrefix, notificationWorkerLimit, { delay: true, startAt: notificationStartAt }),
    runRunner(compose, 'api-2', 'process-notification', notificationPrefix, notificationWorkerLimit, { delay: true, startAt: notificationStartAt }),
  ]);
  // A SKIP LOCKED poll may transiently see no row while its peer commits the
  // last claim. A normal Worker would pick that PENDING row up on the next
  // poll, so emulate that next poll without making fresh PROCESSING failures
  // eligible for recovery.
  const notificationCompletion = await runRunner(compose, 'api-1', 'process-notification', notificationPrefix, notificationCount);
  const notificationStats = await runRunner(compose, 'api-1', 'notification-stats', notificationPrefix, notificationCount);
  assert(notificationStats.total === notificationCount, `通知 outbox 总数应为 ${notificationCount}，实际 ${notificationStats.total}`);
  assert(notificationStats.sent === notificationCount && notificationStats.pending === 0 && notificationStats.processing === 0 && notificationStats.failed === 0, diagnostic('通知 outbox 并发领取后存在未发送或失败任务', { notificationStats, workerResults: [notificationFirst, notificationSecond] }));
  assert(notificationStats.attemptSum === notificationCount + 1 && notificationStats.recoveredStale === 1 && notificationStats.maximumAttempts === 2, diagnostic('通知 outbox 处理中任务恢复或领取次数不符合预期', notificationStats));
  assert(notificationStats.uniqueProviderMessages === notificationCount, '通知 outbox 出现重复供应商消息标识');
  assert(notificationFirst.sent > 0 && notificationSecond.sent > 0, diagnostic('通知 outbox 未由两个独立 Worker 进程共同领取', { workerResults: [notificationFirst, notificationSecond], completionResult: notificationCompletion }));

  await runRunner(compose, 'api-1', 'seed-audit', auditPrefix, auditCount);
  await runRunner(compose, 'api-1', 'mark-audit-stale', auditPrefix, auditCount);
  const auditStartAt = Date.now() + 8_000;
  const [auditFirst, auditSecond] = await Promise.all([
    runRunner(compose, 'api-1', 'process-audit', auditPrefix, auditWorkerLimit, { delay: true, startAt: auditStartAt }),
    runRunner(compose, 'api-2', 'process-audit', auditPrefix, auditWorkerLimit, { delay: true, startAt: auditStartAt }),
  ]);
  const auditCompletion = await runRunner(compose, 'api-1', 'process-audit', auditPrefix, auditCount);
  const auditStats = await runRunner(compose, 'api-1', 'audit-stats', auditPrefix, auditCount);
  assert(auditStats.total === auditCount, `审计 outbox 总数应为 ${auditCount}，实际 ${auditStats.total}`);
  assert(auditStats.signed === auditCount && auditStats.pending === 0 && auditStats.processing === 0 && auditStats.quarantined === 0, diagnostic('审计 outbox 并发领取后存在未签名或隔离任务', { auditStats, workerResults: [auditFirst, auditSecond] }));
  assert(auditStats.attemptSum === auditCount + 1 && auditStats.recoveredStale === 1 && auditStats.maximumAttempts === 2, diagnostic('审计 outbox 处理中任务恢复或领取次数不符合预期', auditStats));
  assert(auditStats.uniqueSignedAuditLogs === auditCount, '审计 outbox 出现重复签名审计记录');
  assert(auditStats.chain?.valid === true, `审计链完整性检查失败：${auditStats.chain?.reason || 'unknown'}`);
  assert(auditFirst.signed > 0 && auditSecond.signed > 0, diagnostic('审计 outbox 未由两个独立 Worker 进程共同领取', { workerResults: [auditFirst, auditSecond], completionResult: auditCompletion }));

  // Deliberately alter an immutable payload after enqueue. The signer must
  // quarantine it before touching the global HMAC chain; the smoke-only
  // cleanup removes this isolated fixture from the ephemeral database after
  // the assertion, never from a shared or production database.
  await runRunner(compose, 'api-1', 'seed-audit', tamperPrefix, 1);
  await runRunner(compose, 'api-1', 'tamper-audit', tamperPrefix, 1);
  const tamperWorker = await runRunner(compose, 'api-2', 'process-audit', tamperPrefix, 1);
  const tamperStats = await runRunner(compose, 'api-1', 'audit-stats', tamperPrefix, 1);
  assert(tamperStats.total === 1 && tamperStats.signed === 0 && tamperStats.pending === 0 && tamperStats.processing === 0 && tamperStats.quarantined === 1, diagnostic('审计载荷篡改未被隔离', { tamperStats, workerResult: tamperWorker }));
  assert(tamperStats.chain?.valid === true, diagnostic('审计载荷篡改污染了签名链', tamperStats.chain));
  const tamperCleanup = await runRunner(compose, 'api-1', 'cleanup-audit', tamperPrefix, 1);
  assert(tamperCleanup.deleted === 1, diagnostic('烟测篡改审计夹具未清理', tamperCleanup));

  await runRunner(compose, 'api-1', 'seed-payment', interruptionPrefix, 1);
  await startDetachedRunner(compose, 'api-1', 'hold-payment-transaction', interruptionPrefix, 1);
  const backendPid = await waitForBackendPid(compose, 'api-1', interruptionPrefix);
  const lockProbe = await runRunner(compose, 'api-2', 'probe-payment-lock', interruptionPrefix, 1, { lockTimeoutMs: 250 });
  assert(lockProbe.timedOut === true && lockProbe.sqlState === '55P03', diagnostic('支付 outbox 行锁等待未按配置超时', lockProbe));
  assert(lockProbe.elapsedMs >= 100 && lockProbe.elapsedMs < 3_000, diagnostic('支付 outbox 行锁等待耗时超出烟测预算', lockProbe));
  const backendTerminated = await terminateBackend(compose, backendPid);
  assert(backendTerminated, '无法终止持锁 PostgreSQL 后端连接');
  const rollbackStats = await runRunner(compose, 'api-2', 'payment-stats', interruptionPrefix, 1);
  assert(rollbackStats.total === 1 && rollbackStats.pending === 1 && rollbackStats.processing === 0 && rollbackStats.attemptSum === 0, diagnostic('支付 outbox 提交前连接中断未完整回滚', rollbackStats));
  const interruptionCleanup = await runRunner(compose, 'api-2', 'cleanup-payment', interruptionPrefix, 1);
  assert(interruptionCleanup.deletedOutbox === 1 && interruptionCleanup.deletedOrders === 1, diagnostic('支付事务中断烟测夹具未清理', interruptionCleanup));

  await runRunner(compose, 'api-1', 'seed-payment', paymentPrefix, paymentCount);
  await runRunner(compose, 'api-1', 'mark-payment-stale', paymentPrefix, paymentCount);
  const paymentStartAt = Date.now() + 8_000;
  const [paymentFirst, paymentSecond] = await Promise.all([
    runRunner(compose, 'api-1', 'process-payment', paymentPrefix, paymentWorkerLimit, { delay: true, startAt: paymentStartAt }),
    runRunner(compose, 'api-2', 'process-payment', paymentPrefix, paymentWorkerLimit, { delay: true, startAt: paymentStartAt }),
  ]);
  const paymentStats = await runRunner(compose, 'api-1', 'payment-stats', paymentPrefix, paymentCount);
  assert(paymentStats.total === paymentCount, `支付 outbox 总数应为 ${paymentCount}，实际 ${paymentStats.total}`);
  assert(paymentStats.dispatched === paymentCount && paymentStats.retry === 0 && paymentStats.processing === 0 && paymentStats.cancelled === 0, diagnostic('支付 outbox 并发领取后存在未派发、重试、处理中或取消任务', { paymentStats, workerResults: [paymentFirst, paymentSecond] }));
  assert(paymentStats.attemptSum === paymentCount + 1 && paymentStats.recoveredStale === 1 && paymentStats.maximumAttempts === 2, diagnostic('支付 outbox 处理中任务恢复或领取次数不符合预期', paymentStats));
  assert(paymentStats.uniqueProviderReferences === paymentCount, '支付 outbox 出现重复支付意图引用');
  assert(paymentStats.orderReferenceMismatches === 0, '支付 outbox 与订单支付引用不一致');
  assert(paymentFirst.dispatched > 0 && paymentSecond.dispatched > 0, '支付 outbox 未由两个独立 API 进程共同领取');

  return {
    notifications: {
      total: notificationStats.total,
      sent: notificationStats.sent,
      recoveredStale: notificationStats.recoveredStale,
      maximumAttempts: notificationStats.maximumAttempts,
      uniqueProviderMessages: notificationStats.uniqueProviderMessages,
      workerResults: [notificationFirst, notificationSecond],
      completionResult: notificationCompletion,
    },
    audit: {
      total: auditStats.total,
      signed: auditStats.signed,
      recoveredStale: auditStats.recoveredStale,
      maximumAttempts: auditStats.maximumAttempts,
      uniqueSignedAuditLogs: auditStats.uniqueSignedAuditLogs,
      chainValid: auditStats.chain.valid,
      workerResults: [auditFirst, auditSecond],
      completionResult: auditCompletion,
    },
    auditTamperIsolation: {
      quarantined: tamperStats.quarantined,
      chainValid: tamperStats.chain.valid,
      workerResult: tamperWorker,
    },
    paymentTransactionInterruption: {
      configuredLockTimeoutMs: 250,
      observedLockWaitMs: lockProbe.elapsedMs,
      lockTimeoutSqlState: lockProbe.sqlState,
      backendTerminated,
      rolledBackToPending: rollbackStats.pending === 1 && rollbackStats.attemptSum === 0,
    },
    payments: {
      total: paymentStats.total,
      dispatched: paymentStats.dispatched,
      recoveredStale: paymentStats.recoveredStale,
      maximumAttempts: paymentStats.maximumAttempts,
      uniqueProviderReferences: paymentStats.uniqueProviderReferences,
      orderReferenceMismatches: paymentStats.orderReferenceMismatches,
      workerResults: [paymentFirst, paymentSecond],
    },
  };
}
