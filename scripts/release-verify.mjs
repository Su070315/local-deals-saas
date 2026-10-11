import { access, readFile, readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import {
  extractRelativeStaticJavaScriptDependencies,
  verifyWorkspaceLazyChunkGraph,
} from './workspace-build-invariants.mjs';

const root = process.cwd();
const buildWorkspaces = process.argv.includes('--build-workspaces');
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const npmExecPath = String(process.env.npm_execpath || '').trim();
const releaseId = String(process.env.RELEASE_ID || 'release-verify').trim();
const workspaces = [
  { service: 'platform', role: 'PLATFORM_ADMIN' },
  { service: 'agency', role: 'AGENCY_ADMIN' },
  { service: 'merchant', role: 'MERCHANT_ADMIN' },
  { service: 'verify', role: 'STORE_STAFF' },
];
const failures = [];
const INITIAL_WORKSPACE_SHELL_GZIP_LIMIT_BYTES = 80 * 1024;
// Keep headroom below the current authenticated workspace baseline while
// incremental feature extraction turns this into smaller domain chunks.
const AUTHENTICATED_WORKSPACE_GZIP_LIMIT_BYTES = 344 * 1024;
const WORKSPACE_APP_CHUNK_PATTERN = /^workspace-app-[A-Za-z0-9_-]+\.js$/;
const WORKSPACE_PAGE_CONTENT_CHUNK_PATTERN = /^workspace-page-content-[A-Za-z0-9_-]+\.js$/;
const OVERVIEW_FEATURE_CHUNK_PATTERN = /^overview-page-[A-Za-z0-9_-]+\.js$/;
const ACCOUNT_SECURITY_FEATURE_CHUNK_PATTERN = /^account-security-page-[A-Za-z0-9_-]+\.js$/;
const BILLING_PAGE_CHUNK_PATTERN = /^billing-page-[A-Za-z0-9_-]+\.js$/;
const WORKSPACE_DATA_PAGE_CHUNK_PATTERN = /^workspace-data-page-[A-Za-z0-9_-]+\.js$/;
const RUNTIME_CONTROLS_PAGE_CHUNK_PATTERN = /^runtime-controls-page-[A-Za-z0-9_-]+\.js$/;
const OPERATOR_ISSUE_PANEL_CHUNK_PATTERN = /^operator-issue-panel-[A-Za-z0-9_-]+\.js$/;
const DATA_DOMAIN_CHUNK_PATTERNS = [
  /^agency-merchant-data-page-[A-Za-z0-9_-]+\.js$/,
  /^catalog-data-page-[A-Za-z0-9_-]+\.js$/,
  /^staff-data-page-[A-Za-z0-9_-]+\.js$/,
  /^transaction-data-page-[A-Za-z0-9_-]+\.js$/,
  /^support-data-page-[A-Za-z0-9_-]+\.js$/,
  /^audit-data-page-[A-Za-z0-9_-]+\.js$/,
  /^reporting-page-[A-Za-z0-9_-]+\.js$/,
];
const UI_VENDOR_CHUNK_PATTERN = /^vendor-ui-[A-Za-z0-9_-]+\.js$/;

if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(releaseId)) {
  throw new Error('RELEASE_ID 只能包含字母、数字、点、下划线或连字符，且长度为 1 至 128 位');
}

function pass(message) {
  console.log(`PASS ${message}`);
}

function fail(message) {
  failures.push(message);
  console.error(`FAIL ${message}`);
}

async function readWorkspaceFile(path) {
  try {
    return await readFile(resolve(root, path), 'utf8');
  } catch {
    fail(`缺少 ${path}`);
    return '';
  }
}

async function exists(path) {
  try {
    await access(resolve(root, path));
    return true;
  } catch {
    return false;
  }
}

function requireText(source, expected, description) {
  if (source.includes(expected)) pass(description);
  else fail(`${description}缺失：${expected}`);
}

function forbidText(source, forbidden, description) {
  if (!source.includes(forbidden)) pass(description);
  else fail(`${description}仍包含：${forbidden}`);
}

function runNpm(args, environment = process.env) {
  console.log(`RUN npm ${args.join(' ')}`);
  const command = npmExecPath ? process.execPath : npmCommand;
  const commandArgs = npmExecPath ? [npmExecPath, ...args] : args;
  const result = spawnSync(command, commandArgs, {
    cwd: root,
    env: environment,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`npm ${args.join(' ')} 失败，退出码 ${result.status ?? '未知'}`);
}

function runNode(args) {
  console.log(`RUN node ${args.join(' ')}`);
  const result = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`node ${args.join(' ')} 失败，退出码 ${result.status ?? '未知'}`);
}

function verifyComposeSyntaxWhenAvailable() {
  // `docker compose config --quiet` is the authoritative parser for the
  // deployed compose implementation. Local contributors without Docker can
  // still run source-level checks, while CI or a Docker-capable release host
  // turns syntax, anchor and service-reference mistakes into a release stop.
  let command = 'docker';
  let prefix = [];
  let docker = spawnSync(command, ['compose', 'version'], { cwd: root, encoding: 'utf8', stdio: 'pipe' });
  if ((docker.error || docker.status !== 0) && process.platform === 'win32') {
    command = 'wsl.exe';
    prefix = ['--cd', root, 'docker'];
    docker = spawnSync(command, [...prefix, 'compose', 'version'], { cwd: root, encoding: 'utf8', stdio: 'pipe' });
  }
  if (docker.error || docker.status !== 0) {
    console.log('INFO Docker Compose 不可用；跳过容器编排解析。请在 Docker-capable CI 或预发环境执行同一发布门禁。');
    return;
  }
  const compose = spawnSync(command, [...prefix, 'compose', 'config', '--quiet'], { cwd: root, encoding: 'utf8', stdio: 'pipe' });
  if (compose.error || compose.status !== 0) {
    const detail = (compose.stderr || compose.stdout || '').trim();
    fail(`Docker Compose 编排解析失败${detail ? `：${detail}` : ''}`);
    return;
  }
  pass('Docker Compose 编排已通过官方解析');
}

async function verifyManifest(role) {
  const manifestPath = 'apps/admin/dist/workspace-manifest.json';
  if (!(await exists(manifestPath))) {
    fail(`${role} 构建后缺少 ${manifestPath}`);
    return;
  }
  try {
    const manifest = JSON.parse(await readWorkspaceFile(manifestPath));
    if (manifest.workspaceRole !== role || manifest.apiPath !== '/api/v1/' || manifest.releaseId !== releaseId) {
      fail(`${role} 的工作台清单不匹配`);
      return;
    }
    pass(`${role} 工作台清单与同源 API 路径一致`);
  } catch {
    fail(`${role} 的工作台清单不是有效 JSON`);
  }
}

async function verifyInitialWorkspaceShell(role) {
  const indexPath = 'apps/admin/dist/index.html';
  const assetsPath = resolve(root, 'apps/admin/dist/assets');
  if (!(await exists(indexPath))) {
    fail(`${role} 构建后缺少登录入口`);
    return;
  }
  const [index, assets] = await Promise.all([readWorkspaceFile(indexPath), readdir(assetsPath)]);
  const workspaceAppAsset = assets.find((asset) => WORKSPACE_APP_CHUNK_PATTERN.test(asset));
  if (!workspaceAppAsset) {
    fail(`${role} 缺少按需加载的运营工作台模块`);
    return;
  }
  const workspacePageContentAsset = assets.find((asset) => WORKSPACE_PAGE_CONTENT_CHUNK_PATTERN.test(asset));
  if (!workspacePageContentAsset) {
    fail(`${role} 缺少独立加载的页面渲染模块`);
    return;
  }
  const overviewFeatureAsset = assets.find((asset) => OVERVIEW_FEATURE_CHUNK_PATTERN.test(asset));
  if (!overviewFeatureAsset) {
    fail(`${role} 缺少独立加载的概览模块`);
    return;
  }
  const accountSecurityFeatureAsset = assets.find((asset) => ACCOUNT_SECURITY_FEATURE_CHUNK_PATTERN.test(asset));
  if (!accountSecurityFeatureAsset) {
    fail(`${role} 缺少独立加载的账户安全模块`);
    return;
  }
  const billingPageAsset = assets.find((asset) => BILLING_PAGE_CHUNK_PATTERN.test(asset));
  if (!billingPageAsset) {
    fail(`${role} 缺少独立加载的月结账单模块`);
    return;
  }
  const workspaceDataPageAsset = assets.find((asset) => WORKSPACE_DATA_PAGE_CHUNK_PATTERN.test(asset));
  const runtimeControlsPageAsset = assets.find((asset) => RUNTIME_CONTROLS_PAGE_CHUNK_PATTERN.test(asset));
  const operatorIssuePanelAsset = assets.find((asset) => OPERATOR_ISSUE_PANEL_CHUNK_PATTERN.test(asset));
  const dataDomainAssets = DATA_DOMAIN_CHUNK_PATTERNS.map((pattern) => assets.find((asset) => pattern.test(asset)));
  if (!workspaceDataPageAsset || !runtimeControlsPageAsset || dataDomainAssets.some((asset) => !asset)) {
    fail(`${role} 缺少按领域拆分的运营列表模块`);
    return;
  }
  if (!operatorIssuePanelAsset) {
    fail(`${role} 缺少按需加载的问题诊断模块`);
    return;
  }
  const uiVendorAsset = assets.find((asset) => UI_VENDOR_CHUNK_PATTERN.test(asset));
  if (!uiVendorAsset) {
    fail(`${role} 缺少认证后独立缓存的 UI 框架模块`);
    return;
  }
  if (index.includes('workspace-app-') || index.includes('overview-page-') || index.includes('account-security-page-') || index.includes('billing-page-') || index.includes('runtime-controls-page-') || index.includes('operator-issue-panel-') || index.includes('vendor-ui')) {
    fail(`${role} 登录入口预加载了完整运营模块`);
    return;
  }
  const workspaceAppSource = await readFile(resolve(assetsPath, workspaceAppAsset), 'utf8');
  const workspacePageContentSource = await readFile(resolve(assetsPath, workspacePageContentAsset), 'utf8');
  const lazyChunkFailures = verifyWorkspaceLazyChunkGraph({
    role,
    workspaceAppSource,
    workspacePageContentSource,
    workspacePageContentAsset,
    featureAssets: [
      ['概览模块', overviewFeatureAsset],
      ['账户安全模块', accountSecurityFeatureAsset],
      ['月结账单模块', billingPageAsset],
      ['运营列表入口', workspaceDataPageAsset],
      ['全局销售控制页面', runtimeControlsPageAsset],
    ],
    operatorIssuePanelAsset,
  });
  if (lazyChunkFailures.length > 0) {
    for (const failure of lazyChunkFailures) fail(failure);
    return;
  }
  const workspaceDataPageSource = await readFile(resolve(assetsPath, workspaceDataPageAsset), 'utf8');
  if (dataDomainAssets.some((asset) => !workspaceDataPageSource.includes(asset))) {
    fail(`${role} 运营列表未保持代理、商品、员工、交易、售后、审计和报表的独立加载`);
    return;
  }
  async function staticDependencyClosure(entryAsset) {
    const visited = new Set();
    async function visit(asset) {
      if (visited.has(asset)) return;
      visited.add(asset);
      const source = await readFile(resolve(assetsPath, asset), 'utf8');
      const dependencies = extractRelativeStaticJavaScriptDependencies(source);
      await Promise.all(dependencies.map(visit));
    }
    await visit(entryAsset);
    return [...visited];
  }
  const initialEntryFiles = [...index.matchAll(/(?:src|href)="\/assets\/([^"?#]+\.js)"/g)].map((match) => match[1]);
  const initialJavaScriptFiles = [...new Set((await Promise.all(initialEntryFiles.map(staticDependencyClosure))).flat())];
  const initialJavaScriptAssets = new Set(initialJavaScriptFiles);
  const authenticatedAssets = (await staticDependencyClosure(workspaceAppAsset)).filter((asset) => !initialJavaScriptAssets.has(asset));
  const authenticatedWorkspaceGzipBytes = (await Promise.all(authenticatedAssets.map((asset) => readFile(resolve(assetsPath, asset))))).reduce((total, source) => total + gzipSync(source).byteLength, 0);
  if (authenticatedWorkspaceGzipBytes > AUTHENTICATED_WORKSPACE_GZIP_LIMIT_BYTES) {
    fail(`${role} 认证后工作台静态依赖 gzip 体积超出 ${AUTHENTICATED_WORKSPACE_GZIP_LIMIT_BYTES} 字节预算：${authenticatedWorkspaceGzipBytes}`);
    return;
  }
  const initialJavaScriptGzipBytes = (await Promise.all(initialJavaScriptFiles.map((file) => readFile(resolve(assetsPath, file))))).reduce((total, source) => total + gzipSync(source).byteLength, 0);
  if (initialJavaScriptGzipBytes > INITIAL_WORKSPACE_SHELL_GZIP_LIMIT_BYTES) {
    fail(`${role} 登录入口 JavaScript gzip 体积超出 ${INITIAL_WORKSPACE_SHELL_GZIP_LIMIT_BYTES} 字节预算：${initialJavaScriptGzipBytes}`);
    return;
  }
  pass(`${role} 登录入口不会预加载运营或概览模块，gzip ${initialJavaScriptGzipBytes} 字节；认证后静态依赖 gzip ${authenticatedWorkspaceGzipBytes} 字节`);
}

async function verifyStructure() {
  const [compose, nginx, gatewayNginx, vite, runtimeConfig, appModule, migrationRunner, apiDockerfile, adminDockerfile, deploymentGuide, overviewPage, packageJson, dockerSmoke, dockerConcurrencySmoke, dockerOutboxSmoke, outboxRunner, notificationOutbox, auditOutbox, ciWorkflow] = await Promise.all([
    readWorkspaceFile('docker-compose.yml'),
    readWorkspaceFile('apps/admin/nginx.conf'),
    readWorkspaceFile('deploy/nginx/api-gateway.conf'),
    readWorkspaceFile('apps/admin/vite.config.ts'),
    readWorkspaceFile('apps/api/src/runtime-config.ts'),
    readWorkspaceFile('apps/api/src/app.module.ts'),
    readWorkspaceFile('apps/api/src/migration-runner.ts'),
    readWorkspaceFile('apps/api/Dockerfile'),
    readWorkspaceFile('apps/admin/Dockerfile'),
    readWorkspaceFile('SUBDOMAIN_DEPLOYMENT.md'),
    readWorkspaceFile('apps/admin/src/features/overview-page.tsx'),
    readWorkspaceFile('package.json'),
    readWorkspaceFile('scripts/docker-smoke.mjs'),
    readWorkspaceFile('scripts/docker-concurrency-smoke.mjs'),
    readWorkspaceFile('scripts/docker-outbox-smoke.mjs'),
    readWorkspaceFile('apps/api/src/outbox-smoke-runner.ts'),
    readWorkspaceFile('apps/api/src/notifications/notification-outbox.service.ts'),
    readWorkspaceFile('apps/api/src/audit-outbox.service.ts'),
    readWorkspaceFile('.github/workflows/ci.yml'),
  ]);

  requireText(vite, 'workspaceManifestPlugin', 'Vite 会输出工作台身份清单');
  requireText(nginx, 'proxy_pass http://api-gateway:8080;', '工作台只通过内部 API 网关代理');
  requireText(gatewayNginx, 'server api-1:3001', '内部网关包含第一 API 副本');
  requireText(gatewayNginx, 'server api-2:3001', '内部网关包含第二 API 副本');
  requireText(gatewayNginx, 'proxy_next_upstream error timeout http_502 http_503 http_504;', '内部网关只对连接级失败切换副本');
  requireText(gatewayNginx, 'proxy_set_header X-Request-Id $http_x_request_id;', '内部网关保留请求关联编号');
  requireText(nginx, 'Content-Security-Policy', '工作台配置 CSP');
  requireText(nginx, 'X-Frame-Options', '工作台禁止嵌入');
  requireText(runtimeConfig, 'WORKSPACE_ORIGIN_ROLES', '共享环境要求来源到角色映射');
  requireText(runtimeConfig, 'CORS_ORIGINS', '共享环境要求精确来源白名单');
  requireText(runtimeConfig, 'RELEASE_ID', '共享环境要求可追踪发布标识');
  requireText(runtimeConfig, '共享环境禁止在应用启动时执行迁移', '共享环境禁止应用实例自动迁移');
  requireText(appModule, 'migrationsRun: false', '应用实例不会自动执行数据库迁移');
  requireText(migrationRunner, "transaction: 'each'", '迁移任务支持未来在线索引迁移');
  requireText(apiDockerfile, 'ENV NODE_ENV=staging', 'API 镜像默认使用共享环境安全模式');
  forbidText(apiDockerfile, 'ENV NODE_ENV=development', 'API 镜像不再默认使用开发模式');
  requireText(apiDockerfile, 'COPY packages/api-contract/package.json packages/api-contract/package.json', 'API 镜像安装完整 monorepo workspace 清单');
  requireText(vite, 'VITE_REQUIRE_RELEASE_ID', '静态工作台发布构建要求版本标识');
  requireText(adminDockerfile, 'VITE_REQUIRE_RELEASE_ID=true', '工作台镜像构建要求版本标识');
  requireText(adminDockerfile, 'COPY packages/api-contract/package.json packages/api-contract/package.json', '工作台镜像安装共享契约 workspace 清单');
  requireText(adminDockerfile, 'COPY packages/api-contract packages/api-contract', '工作台镜像编译共享 API 契约源码');
  requireText(overviewPage, 'const readinessActionLabels', '运营检查为每类待办定义明确操作名称');
  requireText(overviewPage, 'aria-label={`${check.title}：${actionLabel}`}', '运营检查操作具有可区分无障碍标签');
  if (overviewPage.includes('>去处理</Button>')) fail('运营检查仍包含不可区分的“去处理”操作按钮');
  else pass('运营检查不再使用不可区分的通用操作按钮');
  requireText(await readWorkspaceFile('apps/admin/src/main.tsx'), '本地四工作台开发请打开', '本地来源限制提示可恢复到正确入口');
  requireText(await readWorkspaceFile('apps/admin/src/features/workspace-runtime.ts'), '本地四工作台开发请打开', '会话失效后的登录入口同样提示正确本地地址');
  const [adminMain, workspaceRuntime, customerApiBase, verifierApiBase, apiVersioning, versioningGuide] = await Promise.all([
    readWorkspaceFile('apps/admin/src/main.tsx'),
    readWorkspaceFile('apps/admin/src/features/workspace-runtime.ts'),
    readWorkspaceFile('apps/miniprogram-customer/utils/api-base.ts'),
    readWorkspaceFile('apps/miniprogram-verifier/utils/api-base.ts'),
    readWorkspaceFile('apps/api/src/api-versioning.ts'),
    readWorkspaceFile('API_VERSIONING.md'),
  ]);
  requireText(adminMain, "VITE_API_URL || '/api/v1'", '管理端登录壳使用稳定 v1 API');
  requireText(workspaceRuntime, "VITE_API_URL || '/api/v1'", '管理端运营工作台使用稳定 v1 API');
  requireText(customerApiBase, '/api/v1', '顾客小程序使用稳定 v1 API');
  requireText(verifierApiBase, '/api/v1', '核销助手使用稳定 v1 API');
  requireText(apiVersioning, 'API_LEGACY_SUNSET', '旧 API 路径声明 Sunset');
  requireText(versioningGuide, '2027-07-21', 'API 版本规范声明旧路径最低支持期限');
  requireText(compose, '  api-1:', 'Docker 演示包含第一无状态 API 副本');
  requireText(compose, '  api-2:', 'Docker 演示包含第二无状态 API 副本');
  requireText(compose, '  worker:', 'Docker 演示包含独立生命周期工作器');
  requireText(compose, '  api-gateway:', 'Docker 演示包含内部 API 网关');
  requireText(compose, 'TRUST_PROXY_HOPS: "2"', '两层受控代理已声明客户端地址信任边界');
  requireText(compose, 'RUN_LIFECYCLE_WORKER: "false"', '浏览器 API 副本不承载生命周期任务');
  requireText(compose, 'RUN_LIFECYCLE_WORKER: "true"', '独立工作器承载生命周期任务');
  requireText(compose, 'wget -Y off -q -O /dev/null http://127.0.0.1:3001/api/v1/public/health/ready', 'API 就绪探针不受代理或 IPv6 回环解析影响');
  requireText(compose, 'wget -Y off -q -O /dev/null http://127.0.0.1:3001/api/v1/public/health/worker', 'Worker 探针不受代理或 IPv6 回环解析影响');
  requireText(compose, 'wget -Y off -q -O /dev/null http://127.0.0.1:8080/healthz', '内部网关探针不受代理或 IPv6 回环解析影响');
  requireText(compose, 'start_period: 60s', 'API 与 Worker 冷启动具有受控健康宽限期');
  requireText(packageJson, '"smoke:docker": "node scripts/docker-smoke.mjs"', '仓库提供真实 PostgreSQL Docker 烟测命令');
  requireText(dockerSmoke, "['stop', 'api-1']", 'Docker 烟测包含单 API 副本故障切换');
  requireText(dockerSmoke, "['stop', 'worker']", 'Docker 烟测包含独立 Worker 故障隔离');
  requireText(dockerSmoke, "['up', '-d', '--no-deps', 'api-1']", 'API 副本恢复不会重新触发迁移依赖');
  requireText(dockerSmoke, "['up', '-d', '--no-deps', 'worker']", 'Worker 恢复不会重新触发迁移依赖');
  requireText(dockerSmoke, "['up', '-d', 'api-gateway']", 'Docker 烟测在核心服务健康后单独开放内部网关');
  requireText(dockerSmoke, "['up', '-d', 'platform', 'agency', 'merchant', 'verify']", 'Docker 烟测在网关健康后开放四工作台');
  requireText(dockerSmoke, "['down', '--volumes', '--remove-orphans', '--rmi', 'local']", 'Docker 烟测清理隔离项目的临时卷和镜像');
  requireText(dockerSmoke, 'runDockerConcurrencySmoke', 'Docker 烟测包含双 API 并发交易演练');
  requireText(dockerConcurrencySmoke, 'limitedStock', '并发烟测验证限量库存串行化');
  requireText(dockerConcurrencySmoke, 'paymentConfirmation', '并发烟测验证支付确认幂等');
  requireText(dockerConcurrencySmoke, 'concurrentVerification', '并发烟测验证券核销原子性');
  requireText(dockerConcurrencySmoke, 'pausedSales', '并发烟测验证全局止售');
  requireText(dockerConcurrencySmoke, 'resumedSales', '并发烟测验证双人恢复复核');
  requireText(dockerSmoke, 'runDockerOutboxSmoke', 'Docker 烟测包含 outbox 双进程竞争演练');
  requireText(dockerSmoke, 'timeout: 15_000', 'Docker 探测命令具有有限超时，不会在 Docker 不可用时永久阻塞');
  requireText(dockerOutboxSmoke, 'recoveredStale', 'outbox 演练验证处理中任务恢复');
  requireText(dockerOutboxSmoke, 'process-payment', 'Docker 烟测包含支付 outbox 双进程竞争派发');
  requireText(dockerOutboxSmoke, 'tamper-audit', 'Docker 烟测包含审计载荷篡改隔离注入');
  requireText(dockerOutboxSmoke, 'auditTamperIsolation', 'Docker 烟测检查篡改不会污染审计链');
  requireText(outboxRunner, 'hold-payment-transaction', '支付 outbox 烟测可在提交前持有真实数据库事务');
  requireText(outboxRunner, 'probe-payment-lock', '支付 outbox 烟测可从第二进程探测有限锁等待');
  requireText(dockerOutboxSmoke, 'pg_terminate_backend', '支付 outbox 烟测精确终止持锁数据库连接');
  requireText(dockerOutboxSmoke, 'paymentTransactionInterruption', 'Docker 证据包含支付事务中断结果');
  requireText(dockerOutboxSmoke, 'lockTimeoutSqlState', 'Docker 证据保存 PostgreSQL 锁超时 SQLSTATE');
  requireText(dockerOutboxSmoke, 'rolledBackToPending', 'Docker 证据确认未提交支付任务回滚为待处理');
  requireText(outboxRunner, 'uniqueProviderReferences', '支付 outbox 演练检查支付引用不重复');
  requireText(outboxRunner, 'orderReferenceMismatches', '支付 outbox 演练检查订单与 outbox 引用一致');
  requireText(notificationOutbox, "setOnLocked('skip_locked')", '通知 outbox 在 PostgreSQL 使用 SKIP LOCKED');
  requireText(auditOutbox, "setOnLocked('skip_locked')", '审计 outbox 在 PostgreSQL 使用 SKIP LOCKED');
  requireText(outboxRunner, 'ALLOW_OUTBOX_SMOKE', 'outbox 运行器默认拒绝未授权执行');
  requireText(outboxRunner, 'uniqueProviderMessages', '通知 outbox 演练检查供应商消息幂等');
  requireText(outboxRunner, 'uniqueSignedAuditLogs', '审计 outbox 演练检查签名记录不重复');
  requireText(ciWorkflow, 'npm run smoke:docker', 'CI 在真实 PostgreSQL 容器拓扑上运行烟测');
  requireText(ciWorkflow, 'actions/upload-artifact@v4', 'CI 保存 Docker 烟测证据报告');
  verifyComposeSyntaxWhenAvailable();

  for (const workspace of workspaces) {
    requireText(compose, `  ${workspace.service}:`, `${workspace.service} 工作台服务已定义`);
    requireText(compose, `VITE_WORKSPACE_ROLE: ${workspace.role}`, `${workspace.service} 工作台角色已固化`);
    requireText(deploymentGuide, `| \`${workspace.service}.<根域名>\``, `${workspace.service} 子域名已纳入部署规范`);
  }

  try {
    runNode(['scripts/architecture-verify.mjs']);
    pass('架构维护预算通过');
    runNode(['--test', 'scripts/migration-compatibility-verify.test.mjs']);
    pass('数据库迁移兼容性检查具备独立回归测试');
    runNode(['scripts/migration-compatibility-verify.mjs']);
    pass('数据库迁移兼容性契约通过');
  } catch (error) {
    fail(error instanceof Error ? error.message : '数据库迁移兼容性契约失败');
  }
}

async function buildAndVerifyWorkspaces() {
  runNpm(['run', 'openapi:types']);
  runNpm(['run', 'openapi:verify']);
  runNpm(['run', 'compatibility:test']);
  runNpm(['run', 'compatibility:verify']);
  runNpm(['run', 'lint']);
  runNpm(['test']);
  runNpm(['run', 'build', '-w', '@local-deals/api']);
  for (const workspace of workspaces) {
    runNpm(['run', 'build', '-w', '@local-deals/admin'], { ...process.env, VITE_WORKSPACE_ROLE: workspace.role, VITE_RELEASE_ID: releaseId, VITE_REQUIRE_RELEASE_ID: 'true' });
    await verifyManifest(workspace.role);
    await verifyInitialWorkspaceShell(workspace.role);
  }
}

await verifyStructure();
if (buildWorkspaces && failures.length === 0) {
  try {
    await buildAndVerifyWorkspaces();
  } catch (error) {
    fail(error instanceof Error ? error.message : '工作台构建失败');
  }
} else if (!buildWorkspaces) {
  console.log('INFO 仅完成部署结构检查；使用 --build-workspaces 执行完整发布构建验证。');
}

if (failures.length) {
  console.error(`发布验证失败：${failures.length} 项。`);
  process.exitCode = 1;
} else {
  console.log(buildWorkspaces ? '发布验证通过：四个角色工作台均已分别构建并核验。' : '部署结构检查通过。');
}
