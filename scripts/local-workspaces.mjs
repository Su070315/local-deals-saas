import { spawn, spawnSync } from 'node:child_process';
import { createConnection } from 'node:net';

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const workspaces = [
  { name: '平台管理端', role: 'PLATFORM_ADMIN', port: 5173 },
  { name: '代理运营端', role: 'AGENCY_ADMIN', port: 5174 },
  { name: '商户经营端', role: 'MERCHANT_ADMIN', port: 5175 },
  { name: '门店核销端', role: 'STORE_STAFF', port: 5176 },
];
// Windows machines can resolve localhost through IPv6 or route it through a
// browser proxy. Keep the loopback spelling explicit for local demos, while
// preserving the same exact port-to-role binding used in deployment.
const workspaceOrigins = Object.fromEntries(workspaces.flatMap(({ role, port }) => [
  [`http://localhost:${port}`, role],
  [`http://127.0.0.1:${port}`, role],
]));
const childProcesses = [];
let shuttingDown = false;

function portInUse(port) {
  return new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    const settle = (inUse) => {
      socket.destroy();
      resolve(inUse);
    };
    socket.setTimeout(300, () => settle(false));
    socket.once('connect', () => settle(true));
    socket.once('error', () => settle(false));
  });
}

async function waitForPorts(targetPorts, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let pending = targetPorts;
  while (pending.length && Date.now() < deadline && !shuttingDown) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    pending = (await Promise.all(targetPorts.map(async (port) => (await portInUse(port)) ? null : port))).filter(Boolean);
  }
  return pending;
}

function prefixOutput(name, stream) {
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    for (const line of chunk.split(/\r?\n/)) if (line) process.stdout.write(`[${name}] ${line}\n`);
  });
}

function stopChildTree(child) {
  if (!child?.pid) return;
  if (process.platform === 'win32') {
    // npm.cmd starts an additional cmd/npm/Vite process tree. Killing only the
    // direct child leaves ports occupied and makes the next four-workspace
    // launch appear partially healthy, so terminate the tree as one unit.
    spawnSync('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true });
    return;
  }
  if (!child.killed) child.kill('SIGTERM');
}

function start(name, args, env) {
  const options = { cwd: process.cwd(), env: { ...process.env, ...env }, stdio: ['inherit', 'pipe', 'pipe'] };
  const child = process.platform === 'win32'
    ? spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', [npm, ...args].join(' ')], options)
    : spawn(npm, args, options);
  childProcesses.push(child);
  prefixOutput(name, child.stdout);
  prefixOutput(name, child.stderr);
  child.on('error', (error) => {
    console.error(`[${name}] 无法启动：${error.message}`);
    shutdown(1);
  });
  child.on('exit', (code, signal) => {
    if (!shuttingDown) {
      console.error(`[${name}] 已退出（${signal || code || 0}），正在停止本地演示。`);
      shutdown(code || 1);
    }
  });
}

function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of childProcesses) stopChildTree(child);
  setTimeout(() => process.exit(exitCode), 800).unref();
}

for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => shutdown(0));

const ports = [3001, ...workspaces.map((workspace) => workspace.port)];
const busyPorts = (await Promise.all(ports.map(async (port) => (await portInUse(port)) ? port : null))).filter(Boolean);
if (busyPorts.length) {
  console.error(`以下端口已被占用：${busyPorts.join('、')}。请先关闭已有的 API 或 Vite 开发服务。`);
  process.exitCode = 1;
} else {
  const origins = Object.keys(workspaceOrigins).join(',');
  console.log('正在启动本地四工作台；按 Ctrl+C 会同时停止所有子进程：');
  start('API', ['run', 'start:dev', '-w', '@local-deals/api'], {
    CORS_ORIGINS: origins,
    WORKSPACE_ORIGIN_ROLES: JSON.stringify(workspaceOrigins),
    // The local four-workspace harness uses one API process as the sole
    // lifecycle worker so queued imports, exports, and expiry jobs actually
    // progress during demos and browser tests. Production keeps this false on
    // API replicas and runs a separate worker process.
    RUN_LIFECYCLE_WORKER: process.env.RUN_LIFECYCLE_WORKER || 'true',
    // Keep interactive demo tasks responsive while preserving the production
    // default cadence when this harness is pointed at a shared environment.
    LIFECYCLE_SWEEP_POLL_INTERVAL_SECONDS: process.env.LIFECYCLE_SWEEP_POLL_INTERVAL_SECONDS || '5',
    RELEASE_ID: 'local-workspaces',
  });
  const apiPending = await waitForPorts([3001]);
  if (apiPending.length || shuttingDown) {
    if (!shuttingDown) console.error('本地 API 启动超时，未就绪端口：3001');
    shutdown(1);
  } else {
    for (const workspace of workspaces) {
      start(workspace.name, ['run', 'dev', '-w', '@local-deals/admin'], {
        VITE_WORKSPACE_ROLE: workspace.role,
        VITE_PORT: String(workspace.port),
        VITE_RELEASE_ID: 'local-workspaces',
      });
    }
    const workspacePending = await waitForPorts(workspaces.map((workspace) => workspace.port));
    if (workspacePending.length || shuttingDown) {
      if (!shuttingDown) console.error(`本地工作台启动超时，未就绪端口：${workspacePending.join('、')}`);
      shutdown(1);
    } else {
      console.log('本地四工作台已就绪：');
      for (const workspace of workspaces) console.log(`- ${workspace.name}：http://localhost:${workspace.port}（回环备用：http://127.0.0.1:${workspace.port}）`);
    }
  }
}
