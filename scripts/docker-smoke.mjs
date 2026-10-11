import { mkdir, rename, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import {
  assertProductionTopology,
  assertWorkspaceManifest,
  parseComposePs,
  validateSmokeProjectName,
} from './docker-smoke-support.mjs';
import { runDockerConcurrencySmoke } from './docker-concurrency-smoke.mjs';
import { runDockerOutboxSmoke } from './docker-outbox-smoke.mjs';

const root = process.cwd();
const startedAt = new Date();
const stamp = startedAt.toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
const projectName = validateSmokeProjectName(process.env.DOCKER_SMOKE_PROJECT || `localdealssmoke-${stamp}-${process.pid}`);
const reportPath = resolve(root, process.env.DOCKER_SMOKE_REPORT || `artifacts/docker-smoke-${stamp}.json`);
const commandTimeoutMs = Number(process.env.DOCKER_SMOKE_COMMAND_TIMEOUT_MS || 15 * 60_000);
const healthTimeoutMs = Number(process.env.DOCKER_SMOKE_HEALTH_TIMEOUT_MS || 120_000);
const workspaceChecks = [
  { service: 'platform', port: 5173, role: 'PLATFORM_ADMIN' },
  { service: 'agency', port: 5174, role: 'AGENCY_ADMIN' },
  { service: 'merchant', port: 5175, role: 'MERCHANT_ADMIN' },
  { service: 'verify', port: 5176, role: 'STORE_STAFF' },
];
const report = {
  schemaVersion: 1,
  projectName,
  startedAt: startedAt.toISOString(),
  status: 'running',
  checks: [],
  cleanup: { completed: false },
};

let activeChild;
let interruptedSignal = '';

function commandAvailable(command, args) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', stdio: 'pipe', timeout: 15_000, windowsHide: true });
  return !result.error && result.status === 0;
}

function locateDocker() {
  if (commandAvailable('docker', ['compose', 'version'])) return { command: 'docker', prefix: [], label: 'docker' };
  if (process.platform === 'win32' && commandAvailable('wsl.exe', ['--cd', root, 'docker', 'compose', 'version'])) {
    return { command: 'wsl.exe', prefix: ['--cd', root, 'docker'], label: 'wsl docker' };
  }
  throw new Error('未找到可用的 Docker Engine 与 Docker Compose v2；Windows 可使用 Docker Desktop 或已配置 Docker 的 WSL2');
}

function runCommand(runtime, args, { capture = false, timeoutMs = commandTimeoutMs, allowFailure = false } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const stdout = [];
    const stderr = [];
    const child = spawn(runtime.command, [...runtime.prefix, ...args], {
      cwd: root,
      env: process.env,
      stdio: ['ignore', capture ? 'pipe' : 'inherit', capture ? 'pipe' : 'inherit'],
      windowsHide: true,
    });
    activeChild = child;
    if (capture) {
      child.stdout.on('data', (chunk) => stdout.push(chunk));
      child.stderr.on('data', (chunk) => stderr.push(chunk));
    }
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.once('error', (error) => {
      clearTimeout(timer);
      if (activeChild === child) activeChild = undefined;
      rejectPromise(error);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (activeChild === child) activeChild = undefined;
      const result = { code: code ?? -1, stdout: Buffer.concat(stdout).toString('utf8').trim(), stderr: Buffer.concat(stderr).toString('utf8').trim() };
      if (!allowFailure && result.code !== 0) {
        const detail = result.stderr || result.stdout;
        rejectPromise(new Error(`${runtime.label} ${args.join(' ')} 失败，退出码 ${result.code}${detail ? `：${detail.slice(-1500)}` : ''}`));
      } else resolvePromise(result);
    });
  });
}

function compose(runtime, args, options) {
  return runCommand(runtime, ['compose', '--project-name', projectName, ...args], options);
}

function record(name, details = {}) {
  report.checks.push({ name, completedAt: new Date().toISOString(), ...details });
  console.log(`PASS ${name}`);
}

function delay(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function assertPortAvailable(port) {
  await new Promise((resolvePromise, rejectPromise) => {
    const server = createServer();
    server.unref();
    server.once('error', () => rejectPromise(new Error(`宿主机端口 ${port} 已被占用，请先停止现有开发或演示服务`)));
    server.listen({ host: '127.0.0.1', port, exclusive: true }, () => server.close(resolvePromise));
  });
}

async function fetchJson(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(8_000), headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`${url} 返回 HTTP ${response.status}`);
  return response.json();
}

async function composeStatus(runtime) {
  const result = await compose(runtime, ['ps', '--all', '--format', 'json'], { capture: true, timeoutMs: 30_000 });
  return parseComposePs(result.stdout);
}

async function waitForServiceHealth(runtime, service) {
  const deadline = Date.now() + healthTimeoutMs;
  do {
    const records = await composeStatus(runtime);
    const recordForService = records.find((record) => record.Service === service);
    if (String(recordForService?.State || '').toLowerCase() === 'running' && String(recordForService?.Health || '').toLowerCase() === 'healthy') return;
    await delay(2_000);
  } while (Date.now() < deadline);
  throw new Error(`${service} 未在 ${healthTimeoutMs}ms 内恢复健康`);
}

async function waitForMigration(runtime) {
  const deadline = Date.now() + healthTimeoutMs;
  do {
    const records = await composeStatus(runtime);
    const migration = records.find((record) => record.Service === 'migrate');
    if (String(migration?.State || '').toLowerCase() === 'exited') {
      const exitCode = Number(migration.ExitCode ?? -1);
      if (exitCode !== 0) throw new Error(`迁移任务退出码为 ${exitCode}`);
      return;
    }
    await delay(2_000);
  } while (Date.now() < deadline);
  throw new Error(`迁移任务未在 ${healthTimeoutMs}ms 内完成`);
}

async function fetchJsonWithRetry(url) {
  const deadline = Date.now() + healthTimeoutMs;
  let lastError;
  do {
    try {
      return await fetchJson(url);
    } catch (error) {
      lastError = error;
      await delay(1_000);
    }
  } while (Date.now() < deadline);
  throw lastError instanceof Error ? lastError : new Error(`${url} 未在限定时间内就绪`);
}

async function repeatedHealthRequests(url, count) {
  for (let index = 0; index < count; index += 1) {
    const body = await fetchJson(url);
    if (body.status !== 'ok') throw new Error(`${url} 未返回健康状态`);
  }
}

async function writeReport() {
  report.completedAt = new Date().toISOString();
  await mkdir(dirname(reportPath), { recursive: true });
  const temporaryPath = `${reportPath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(temporaryPath, reportPath);
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    interruptedSignal = signal;
    activeChild?.kill();
  });
}

let runtime;
let failure;
let cleanupFailure;
try {
  runtime = locateDocker();
  report.runtime = runtime.label;
  await Promise.all(workspaceChecks.map(({ port }) => assertPortAvailable(port)));
  record('宿主机四工作台端口可用');
  await compose(runtime, ['config', '--quiet'], { capture: true, timeoutMs: 30_000 });
  record('Docker Compose 官方配置解析');
  await compose(runtime, ['down', '--volumes', '--remove-orphans'], { capture: true, timeoutMs: 60_000, allowFailure: true });
  await compose(runtime, ['build']);
  await compose(runtime, ['up', '-d', 'postgres', 'migrate', 'api-1', 'api-2', 'worker']);
  await waitForMigration(runtime);
  await Promise.all(['postgres', 'api-1', 'api-2', 'worker'].map((service) => waitForServiceHealth(runtime, service)));
  await compose(runtime, ['up', '-d', 'api-gateway']);
  await waitForServiceHealth(runtime, 'api-gateway');
  await compose(runtime, ['up', '-d', 'platform', 'agency', 'merchant', 'verify']);
  const topology = assertProductionTopology(await composeStatus(runtime));
  report.topology = topology;
  record('PostgreSQL、迁移、双 API、独立 Worker、网关与四工作台冷启动');

  const migrationQuery = ['exec', '-T', 'postgres', 'psql', '-U', 'localdeals', '-d', 'local_deals', '-Atc', 'SELECT COUNT(*) FROM migrations;'];
  const migrationResult = await compose(runtime, migrationQuery, { capture: true, timeoutMs: 30_000 });
  const migrationCount = Number(migrationResult.stdout.trim());
  if (!Number.isInteger(migrationCount) || migrationCount < 1) throw new Error('未能从真实 PostgreSQL 读取已应用迁移数量');
  report.migrationCount = migrationCount;
  await compose(runtime, ['run', '--rm', 'migrate']);
  const repeatedMigrationResult = await compose(runtime, migrationQuery, { capture: true, timeoutMs: 30_000 });
  if (Number(repeatedMigrationResult.stdout.trim()) !== migrationCount) throw new Error('重复迁移改变了迁移记录数量');
  record('真实 PostgreSQL 迁移已应用且可安全重复执行', { migrationCount });

  report.workspaces = {};
  for (const workspace of workspaceChecks) {
    const manifest = assertWorkspaceManifest(await fetchJsonWithRetry(`http://127.0.0.1:${workspace.port}/workspace-manifest.json`), workspace.role);
    report.workspaces[workspace.service] = manifest;
  }
  await repeatedHealthRequests('http://127.0.0.1:5173/api/v1/public/health/ready', 1);
  record('四工作台角色清单与同源 API 健康');

  report.concurrency = await runDockerConcurrencySmoke({
    workspaceBaseUrls: {
      platform: 'http://127.0.0.1:5173',
      merchant: 'http://127.0.0.1:5175',
      verify: 'http://127.0.0.1:5176',
    },
    suffix: `${stamp.slice(-8)}${process.pid.toString(36)}`,
  });
  record('双 API 真实 PostgreSQL 并发库存、支付、核销及全局止售恢复', report.concurrency);

  await compose(runtime, ['stop', 'worker']);
  report.outboxConcurrency = await runDockerOutboxSmoke({
    compose: (args, options) => compose(runtime, args, options),
    suffix: `${stamp.slice(-8)}${process.pid.toString(36)}`,
  });
  await compose(runtime, ['up', '-d', '--no-deps', 'worker']);
  await waitForServiceHealth(runtime, 'worker');
  record('双进程通知、审计与支付 outbox 竞争领取、有限锁等待、提交前中断回滚及审计链完整性', report.outboxConcurrency);

  await compose(runtime, ['stop', 'api-1']);
  await repeatedHealthRequests('http://127.0.0.1:5173/api/v1/public/health/ready', 5);
  await compose(runtime, ['up', '-d', '--no-deps', 'api-1']);
  await waitForServiceHealth(runtime, 'api-1');
  record('第一 API 副本停机时网关连续切换至第二副本', { successfulRequests: 5 });

  await compose(runtime, ['stop', 'worker']);
  await repeatedHealthRequests('http://127.0.0.1:5175/api/v1/public/health/ready', 3);
  await compose(runtime, ['up', '-d', '--no-deps', 'worker']);
  await waitForServiceHealth(runtime, 'worker');
  record('独立 Worker 停机不影响浏览器 API 并可恢复', { successfulRequests: 3 });

  report.topologyAfterRecovery = assertProductionTopology(await composeStatus(runtime));
  report.status = 'passed';
} catch (error) {
  failure = error instanceof Error ? error : new Error(String(error));
  report.status = 'failed';
  report.error = interruptedSignal ? `收到 ${interruptedSignal}` : failure.message;
  if (runtime) await compose(runtime, ['logs', '--no-color', '--tail', '200'], { allowFailure: true, timeoutMs: 30_000 });
} finally {
  if (runtime) {
    try {
      await compose(runtime, ['down', '--volumes', '--remove-orphans', '--rmi', 'local'], { timeoutMs: 120_000 });
      report.cleanup = { completed: true, removedVolumes: true, removedLocalImages: true };
    } catch (error) {
      cleanupFailure = error instanceof Error ? error : new Error(String(error));
      report.cleanup = { completed: false, error: cleanupFailure.message };
      report.status = 'failed';
    }
  }
  await writeReport();
  console.log(`Docker 烟测证据：${reportPath}`);
}

if (failure) {
  console.error(`Docker 烟测失败：${failure.message}`);
  process.exitCode = interruptedSignal ? 130 : 1;
} else if (cleanupFailure) {
  console.error(`Docker 烟测清理失败：${cleanupFailure.message}`);
  process.exitCode = 1;
} else {
  console.log('Docker 生产拓扑烟测通过。');
}
