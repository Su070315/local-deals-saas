import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createConnection } from 'node:net';

const root = fileURLToPath(new URL('..', import.meta.url));
const harnessPath = fileURLToPath(new URL('./local-workspaces.mjs', import.meta.url));
const playwrightCli = fileURLToPath(new URL('../node_modules/@playwright/test/cli.js', import.meta.url));
const ports = [3001, 5173, 5174, 5175, 5176];
const playwrightArgs = process.argv.slice(2);

function portInUse(port) {
  return new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    const settle = (value) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(300, () => settle(false));
    socket.once('connect', () => settle(true));
    socket.once('error', () => settle(false));
  });
}

async function portsMatching(inUse) {
  return (await Promise.all(ports.map(async (port) => (await portInUse(port)) === inUse ? null : port))).filter(Boolean);
}

async function waitForPortState(inUse, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let mismatched = ports;
  while (mismatched.length && Date.now() < deadline) {
    mismatched = await portsMatching(inUse);
    if (!mismatched.length) break;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return mismatched;
}

function prefixOutput(name, stream) {
  let buffered = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    buffered += chunk;
    const lines = buffered.split(/\r?\n/);
    buffered = lines.pop() || '';
    for (const line of lines) if (line) process.stdout.write(`[${name}] ${line}\n`);
  });
  stream.on('end', () => {
    if (buffered) process.stdout.write(`[${name}] ${buffered}\n`);
  });
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.off('exit', onExit);
      resolve(false);
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    child.once('exit', onExit);
  });
}

function windowsListenerPids() {
  const result = spawnSync('netstat.exe', ['-ano', '-p', 'tcp'], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) return [];
  const targets = new Set(ports);
  const pids = new Set();
  for (const line of result.stdout.split(/\r?\n/)) {
    const match = line.match(/^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i);
    if (match && targets.has(Number(match[1]))) pids.add(Number(match[2]));
  }
  return [...pids];
}

async function stopHarness(harness) {
  if (process.platform === 'win32') {
    if (harness.pid && harness.exitCode === null) {
      spawnSync('taskkill.exe', ['/pid', String(harness.pid), '/t', '/f'], {
        stdio: 'ignore', windowsHide: true, timeout: 10_000,
      });
    }
    // A force-killed npm/cmd parent can occasionally leave a Vite or
    // ts-node-dev listener orphaned. Stop only the five ports owned by this
    // test harness, then verify that all of them are released.
    for (const pid of windowsListenerPids()) {
      try { process.kill(pid, 'SIGKILL'); } catch { /* Already stopped. */ }
    }
    if (harness.exitCode === null) {
      try { harness.kill('SIGKILL'); } catch { /* Already stopped. */ }
    }
  } else if (harness.exitCode === null) {
    harness.kill('SIGTERM');
    if (!(await waitForExit(harness, 10_000))) harness.kill('SIGKILL');
  }
  harness.stdout?.destroy();
  harness.stderr?.destroy();
  harness.unref();
  const busyPorts = await waitForPortState(false, 10_000);
  if (busyPorts.length) {
    console.error(`E2E 清理失败，端口仍被占用：${busyPorts.join('、')}`);
    return false;
  }
  console.log('E2E 环境已清理，API 与四个工作台端口均已释放。');
  return true;
}

function runPlaywright() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [playwrightCli, 'test', ...playwrightArgs], {
      cwd: root,
      env: { ...process.env, PLAYWRIGHT_EXTERNAL_SERVER: '1' },
      stdio: 'inherit',
      windowsHide: true,
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
}

const preoccupied = await portsMatching(false);
if (preoccupied.length) {
  console.error(`E2E 要求冷启动，但以下端口已被占用：${preoccupied.join('、')}`);
  process.exitCode = 1;
} else {
  const harness = spawn(process.execPath, [harnessPath], {
    cwd: root,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  prefixOutput('workspaces', harness.stdout);
  prefixOutput('workspaces', harness.stderr);
  let exitCode = 1;
  try {
    const notReady = await waitForPortState(true, 120_000);
    if (notReady.length) throw new Error(`E2E 环境启动超时，未就绪端口：${notReady.join('、')}`);
    console.log('E2E 冷启动环境已就绪，开始执行浏览器流程。');
    exitCode = await runPlaywright();
  } catch (error) {
    console.error((error instanceof Error ? error : new Error(String(error))).message);
  } finally {
    const cleanupOk = await stopHarness(harness);
    if (!cleanupOk && exitCode === 0) exitCode = 1;
  }
  process.exitCode = exitCode;
}
