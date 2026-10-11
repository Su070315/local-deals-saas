import { access, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createConnection } from 'node:net';
import { resolve } from 'node:path';

const root = process.cwd();
const requiredPaths = [
  'package.json',
  'package-lock.json',
  'apps/api/package.json',
  'apps/admin/package.json',
  'apps/miniprogram-customer/project.config.json',
  'apps/miniprogram-verifier/project.config.json',
];
const dependencyPaths = [
  'node_modules/@nestjs/core/package.json',
  'node_modules/vite/package.json',
  'node_modules/typescript/package.json',
];
const failures = [];
const warnings = [];

function report(status, message) {
  console.log(`${status} ${message}`);
}

async function exists(path) {
  try {
    await access(resolve(root, path));
    return true;
  } catch {
    return false;
  }
}

async function canConnect(port) {
  return new Promise((resolveConnection) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    const settle = (connected) => {
      socket.destroy();
      resolveConnection(connected);
    };
    socket.setTimeout(300, () => settle(false));
    socket.once('connect', () => settle(true));
    socket.once('error', () => settle(false));
  });
}

const nodeMajor = Number.parseInt(process.versions.node.split('.')[0], 10);
if (nodeMajor >= 20) {
  report('PASS', `Node.js ${process.version}（要求 >= 20）`);
} else {
  failures.push(`Node.js ${process.version}，请安装 Node.js 20 或更高版本`);
}

for (const path of requiredPaths) {
  if (await exists(path)) {
    report('PASS', `已找到 ${path}`);
  } else {
    failures.push(`缺少源码文件 ${path}，请重新解压完整交接包`);
  }
}

const rootPackagePath = resolve(root, 'package.json');
if (await exists('package.json')) {
  const rootPackage = JSON.parse(await readFile(rootPackagePath, 'utf8'));
  if (rootPackage.name === 'local-deals-saas' && rootPackage.workspaces?.includes('apps/*')) {
    report('PASS', '已确认 npm workspace 配置');
  } else {
    failures.push('package.json 不是预期的本地团购 SaaS workspace 配置');
  }
}

let missingDependencies = false;
for (const path of dependencyPaths) {
  if (!(await exists(path))) missingDependencies = true;
}
if (missingDependencies) {
  failures.push('依赖尚未完整安装，请运行 npm install');
} else {
  report('PASS', 'npm 依赖已安装');
}

if (await exists('.env')) {
  report('INFO', '检测到 .env；不会读取或输出任何环境变量内容');
} else {
  report('INFO', '未检测到 .env；本地演示可直接使用内存数据库');
}

if (await exists('docker-compose.yml')) {
  report('PASS', '已找到 Docker Compose 演示配置');
} else {
  failures.push('缺少 docker-compose.yml，无法进行容器演示部署');
}

const apiRunning = await canConnect(3001);
const workspaces = [
  { name: '平台管理端', port: 5173 },
  { name: '代理运营端', port: 5174 },
  { name: '商户经营端', port: 5175 },
  { name: '门店核销端', port: 5176 },
];
const workspaceRunning = await Promise.all(workspaces.map(async (workspace) => ({ ...workspace, running: await canConnect(workspace.port) })));
report('INFO', apiRunning ? 'API 端口 3001 当前可连接' : 'API 端口 3001 当前未运行');
for (const workspace of workspaceRunning) report('INFO', workspace.running ? `${workspace.name}端口 ${workspace.port} 当前可连接` : `${workspace.name}端口 ${workspace.port} 当前未运行`);
if (apiRunning && workspaceRunning.every((workspace) => workspace.running)) report('PASS', '本地 API 与四个独立角色工作台均已就绪');
else if (workspaceRunning.some((workspace) => workspace.running)) report('WARN', '检测到部分角色工作台未运行；请停止旧开发进程后运行 npm run dev:workspaces 统一启动');

if (process.argv.includes('--docker')) {
  const dockerCheck = spawnSync('docker', ['--version'], { encoding: 'utf8', stdio: 'ignore' });
  if (dockerCheck.status === 0) {
    report('PASS', 'Docker 可执行文件可用');
  } else {
    warnings.push('未检测到 Docker 可执行文件；若要运行容器演示，请安装并启动 Docker Desktop');
  }
}

for (const warning of warnings) report('WARN', warning);
for (const failure of failures) report('FAIL', failure);

if (failures.length) {
  console.log(`\n预检未通过：${failures.length} 项需要处理。`);
  process.exitCode = 1;
} else {
  console.log('\n预检通过：可运行 npm run dev:api 与 npm run dev:admin；需要四角色入口时运行 npm run dev:workspaces。');
}
