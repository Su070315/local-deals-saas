import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const expectedPairs = new Set([
  'legacy-client-current-api', 'current-client-current-api',
  'current-client-previous-api', 'previous-app-expanded-database',
]);

async function text(root, path) {
  return readFile(resolve(root, path), 'utf8');
}

export async function verifyReleaseCompatibility(root = process.cwd()) {
  const failures = [];
  const [matrixRaw, baselineRaw, openapiRaw, integration, appModule, migrationRunner, migrationVerifier, releaseVerifier, versioningGuide, readinessGuide] = await Promise.all([
    text(root, 'packages/api-contract/compatibility-matrix.json'),
    text(root, 'packages/api-contract/v1-compatibility-baseline.json'),
    text(root, 'packages/api-contract/openapi.json'),
    text(root, 'apps/api/src/app.integration.spec.ts'),
    text(root, 'apps/api/src/app.module.ts'),
    text(root, 'apps/api/src/migration-runner.ts'),
    text(root, 'scripts/migration-compatibility-verify.mjs'),
    text(root, 'scripts/release-verify.mjs'),
    text(root, 'API_VERSIONING.md'),
    text(root, 'PRODUCTION_READINESS.md'),
  ]);
  const matrix = JSON.parse(matrixRaw);
  const baseline = JSON.parse(baselineRaw);
  const openapi = JSON.parse(openapiRaw);
  const pairs = new Map((matrix.clientPairs || []).map((pair) => [pair.id, pair]));
  if (matrix.schemaVersion !== 1 || matrix.currentApiContract !== 'v1' || matrix.previousApiBaseline !== 'v1-compatibility-baseline.json') failures.push('兼容矩阵缺少固定 schema、当前 API 或前一发布基线');
  for (const id of expectedPairs) if (!pairs.has(id)) failures.push(`兼容矩阵缺少组合：${id}`);
  for (const id of pairs.keys()) if (!expectedPairs.has(id)) failures.push(`兼容矩阵包含未评审组合：${id}`);

  const baselineOperations = new Set(baseline.operations || []);
  const currentOperations = new Set(Object.entries(openapi.paths || {}).flatMap(([path, pathItem]) => Object.entries(pathItem)
    .filter(([, operation]) => operation?.operationId)
    .map(([method, operation]) => `${method.toUpperCase()} ${path} ${operation.operationId}`)));
  const legacyPair = pairs.get('legacy-client-current-api');
  if (legacyPair?.evidence !== 'runtime-integration' || !integration.includes(`it('${legacyPair.testTitle}'`)) failures.push('旧客户端与当前 API 缺少命名运行时集成回归');
  for (const scenario of legacyPair?.scenarios || []) {
    const signature = `${scenario.method} ${scenario.currentPath} ${scenario.operationId}`;
    if (!baselineOperations.has(signature) || !currentOperations.has(signature)) failures.push(`旧路径场景缺少稳定 v1 操作：${signature}`);
    for (const path of [scenario.legacyPath, scenario.currentPath]) if (!integration.includes(path)) failures.push(`旧路径运行时回归未覆盖：${path}`);
  }

  const currentPair = pairs.get('current-client-current-api');
  if (currentPair?.evidence !== 'generated-contract-and-build' || !Array.isArray(currentPair.sources) || currentPair.sources.length !== 4) failures.push('当前客户端与当前 API 缺少四端源码证据');
  for (const path of currentPair?.sources || []) {
    const source = await text(root, path);
    if (!source.includes('/api/v1')) failures.push(`当前客户端仍未固化 v1：${path}`);
  }

  const previousPair = pairs.get('current-client-previous-api');
  if (previousPair?.evidence !== 'previous-contract-required-operations' || !Array.isArray(previousPair.requiredOperationIds) || previousPair.requiredOperationIds.length < 20) failures.push('新客户端与前一 API 的关键操作清单不完整');
  for (const operationId of previousPair?.requiredOperationIds || []) {
    if (![...baselineOperations].some((signature) => signature.endsWith(` ${operationId}`))) failures.push(`前一 API 基线不支持当前客户端操作：${operationId}`);
    if (![...currentOperations].some((signature) => signature.endsWith(` ${operationId}`))) failures.push(`当前 API 缺少客户端操作：${operationId}`);
  }

  const rollbackPair = pairs.get('previous-app-expanded-database');
  if (rollbackPair?.evidence !== 'expand-only-migration-policy' || rollbackPair.applicationAutoMigration !== false || rollbackPair.databaseRollbackOnApplicationRollback !== false || rollbackPair.requiresRealPostgresPreproductionEvidence !== true) failures.push('旧应用与扩展后数据库组合缺少禁止自动迁移、禁止数据库回退或预发证据要求');
  if (!appModule.includes('migrationsRun: false') || !migrationRunner.includes("transaction: 'each'")) failures.push('应用与独立迁移任务边界不满足滚动发布契约');
  for (const marker of ['DROP\\s+', 'RENAME\\s+', 'ALTER\\s+COLUMN', 'FORBIDDEN_QUERY_RUNNER_METHODS']) if (!migrationVerifier.includes(marker)) failures.push(`expand-only 迁移门禁缺少规则：${marker}`);
  if (/migration:(?:revert|undo)|revertMigration|undoLastMigration/i.test(releaseVerifier)) failures.push('发布门禁包含数据库回退命令');
  for (const statement of ['静态资源保留上一版本', '不执行破坏性 down migration']) if (!versioningGuide.includes(statement)) failures.push(`版本策略缺少回滚约束：${statement}`);
  if (!readinessGuide.includes('真实 PostgreSQL') || !readinessGuide.includes('两个 API 进程和一个 Worker')) failures.push('生产清单未保留真实 PostgreSQL 多版本演练要求');
  return failures;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const failures = await verifyReleaseCompatibility();
  if (failures.length) {
    for (const failure of failures) console.error(`FAIL ${failure}`);
    process.exitCode = 1;
  } else console.log('PASS 升级兼容矩阵覆盖旧客户端/当前 API、当前客户端/当前与前一 API、旧应用/扩展后数据库；真实 PostgreSQL 运行证据仍由预发闸门提供');
}
