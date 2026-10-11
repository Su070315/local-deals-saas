import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const BASELINE_MANIFEST_PATH = 'scripts/migration-baseline.json';
const DESTRUCTIVE_SQL_PATTERNS = [
  /\bDROP\s+TABLE\b/i,
  /\bDROP\s+(?:INDEX|CONSTRAINT)\b/i,
  /\bDROP\s+COLUMN\b/i,
  /\bRENAME\s+(?:COLUMN|TABLE)\b/i,
  /\bALTER\s+COLUMN\b[\s\S]{0,160}\bTYPE\b/i,
  /\bALTER\s+COLUMN\b[\s\S]{0,160}\bSET\s+NOT\s+NULL\b/i,
  /\bTRUNCATE\b/i,
];
const CREATE_INDEX_PATTERN = /\bCREATE\s+(?:UNIQUE\s+)?INDEX\b/i;
const CONCURRENT_INDEX_PATTERN = /\bCREATE\s+(?:UNIQUE\s+)?INDEX\s+CONCURRENTLY\b/i;
const FORBIDDEN_QUERY_RUNNER_METHODS = new Map([
  ['clearTable', '清空表'],
  ['dropColumn', '删除列'],
  ['dropColumns', '删除列'],
  ['dropDatabase', '删除数据库'],
  ['dropSchema', '删除模式'],
  ['dropTable', '删除表'],
  ['renameColumn', '重命名列'],
  ['renameTable', '重命名表'],
  ['changeColumn', '直接修改列'],
  ['changeColumns', '直接修改列'],
  ['createIndex', '创建阻塞索引'],
  ['createIndices', '创建阻塞索引'],
  ['createUniqueConstraint', '创建阻塞唯一约束'],
  ['createUniqueConstraints', '创建阻塞唯一约束'],
]);

function migrationTimestamp(name) {
  const match = /^(\d+)-.+\.ts$/.exec(name);
  return match ? Number(match[1]) : null;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function nodeName(node) {
  if (!node) return '';
  if (ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNumericLiteral(node)) return node.text;
  return '';
}

function staticStringVariants(node, bindings) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return [node.text];
  if (ts.isIdentifier(node)) return bindings.get(node.text) || null;
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) return staticStringVariants(node.expression, bindings);
  if (ts.isConditionalExpression(node)) {
    const left = staticStringVariants(node.whenTrue, bindings);
    const right = staticStringVariants(node.whenFalse, bindings);
    return left && right ? [...new Set([...left, ...right])] : null;
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = staticStringVariants(node.left, bindings);
    const right = staticStringVariants(node.right, bindings);
    if (!left || !right || left.length * right.length > 32) return null;
    return [...new Set(left.flatMap((prefix) => right.map((suffix) => `${prefix}${suffix}`)))];
  }
  if (ts.isTemplateExpression(node)) {
    let variants = [node.head.text];
    for (const span of node.templateSpans) {
      const values = staticStringVariants(span.expression, bindings);
      if (!values || variants.length * values.length > 32) return null;
      variants = variants.flatMap((prefix) => values.map((value) => `${prefix}${value}${span.literal.text}`));
    }
    return [...new Set(variants)];
  }
  return null;
}

function declaresNonTransactionalMigration(sourceFile) {
  let found = false;
  const visit = (node) => {
    if (ts.isPropertyDeclaration(node) && nodeName(node.name) === 'transaction' && node.initializer?.kind === ts.SyntaxKind.FalseKeyword) found = true;
    if (!found) ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

function inspectNewMigration(file, source) {
  const failures = [];
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  if (sourceFile.parseDiagnostics.length) {
    const detail = sourceFile.parseDiagnostics.map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')).join('；');
    return [`${file} 无法通过 TypeScript AST 解析：${detail}`];
  }

  let upMethod;
  const findUp = (node) => {
    if (!upMethod && ts.isMethodDeclaration(node) && nodeName(node.name) === 'up') upMethod = node;
    if (!upMethod) ts.forEachChild(node, findUp);
  };
  findUp(sourceFile);
  if (!upMethod?.body) return [`${file} 缺少可检查的 up 方法`];
  const queryRunnerName = ts.isIdentifier(upMethod.parameters[0]?.name) ? upMethod.parameters[0].name.text : null;
  if (!queryRunnerName) return [`${file} 的 up 方法必须使用明确的 QueryRunner 参数`];

  const bindings = new Map();
  const transactionDisabled = declaresNonTransactionalMigration(sourceFile);
  const visit = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const variants = staticStringVariants(node.initializer, bindings);
      if (variants) bindings.set(node.name.text, variants);
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.expression) && node.expression.expression.text === queryRunnerName) {
      const method = node.expression.name.text;
      const forbidden = FORBIDDEN_QUERY_RUNNER_METHODS.get(method);
      if (forbidden) failures.push(`${file} 的 up 迁移通过 QueryRunner 执行${forbidden}；请采用 expand → backfill → contract 的多版本发布流程`);
      if (method === 'query') {
        const sqlVariants = node.arguments[0] ? staticStringVariants(node.arguments[0], bindings) : null;
        if (!sqlVariants?.length) {
          failures.push(`${file} 的 up 迁移包含无法静态解析的动态 SQL；请使用可审查的固定 SQL 字符串`);
        } else {
          for (const sql of sqlVariants) {
            if (DESTRUCTIVE_SQL_PATTERNS.some((pattern) => pattern.test(sql))) failures.push(`${file} 的 up 迁移包含破坏性 DDL；请采用 expand → backfill → contract 的多版本发布流程`);
            if (CREATE_INDEX_PATTERN.test(sql)) {
              // pg-mem cannot parse CONCURRENTLY. A migration may include a
              // test-only fallback only when it is visibly marked; the runtime
              // branch must still use CONCURRENTLY for real PostgreSQL.
              const testOnlyFallback = /pg-mem-test-only/.test(sql) || /pg-mem-test-only/.test(source);
              if (!CONCURRENT_INDEX_PATTERN.test(sql) && !testOnlyFallback) failures.push(`${file} 新建索引必须使用 CREATE INDEX CONCURRENTLY，避免阻塞线上写入`);
              if (!transactionDisabled) failures.push(`${file} 使用并发索引时必须声明 transaction = false`);
            }
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(upMethod.body);
  return [...new Set(failures)];
}

async function readBaselineManifest(root) {
  const path = resolve(root, BASELINE_MANIFEST_PATH);
  let manifest;
  try {
    manifest = JSON.parse(await readFile(path, 'utf8'));
  } catch {
    throw new Error(`迁移基线清单缺失或不是有效 JSON：${BASELINE_MANIFEST_PATH}`);
  }
  if (![1, 2].includes(manifest?.version) || !Number.isSafeInteger(manifest.baselineTimestamp) || manifest.baselineTimestamp <= 0 || !manifest.files || typeof manifest.files !== 'object' || Array.isArray(manifest.files)) {
    throw new Error(`迁移基线清单字段无效：${BASELINE_MANIFEST_PATH}`);
  }
  for (const [file, digest] of Object.entries(manifest.files)) {
    if (!/^\d+-.+\.ts$/.test(file) || !/^[a-f0-9]{64}$/.test(String(digest))) throw new Error(`迁移基线清单包含无效记录：${file}`);
    if (migrationTimestamp(file) > manifest.baselineTimestamp) throw new Error(`迁移基线清单时间戳范围无效：${file}`);
  }
  return manifest;
}

export async function verifyMigrationCompatibility(root = process.cwd()) {
  const migrationsDir = resolve(root, 'apps/api/src/migrations');
  const files = (await readdir(migrationsDir)).filter((name) => /^\d+-.+\.ts$/.test(name)).sort();
  const baseline = await readBaselineManifest(root);
  const failures = [];
  let previousTimestamp = 0;

  for (const file of files) {
    const timestamp = migrationTimestamp(file);
    if (!timestamp || timestamp <= previousTimestamp) failures.push(`${file} 的迁移时间戳必须严格递增且唯一`);
    previousTimestamp = timestamp || previousTimestamp;
  }

  const currentFiles = new Set(files);
  for (const [file, expectedDigest] of Object.entries(baseline.files)) {
    if (!currentFiles.has(file)) {
      failures.push(`已发布迁移 ${file} 不得删除`);
      continue;
    }
    const source = await readFile(resolve(migrationsDir, file), 'utf8');
    if (sha256(source) !== expectedDigest) failures.push(`已发布迁移 ${file} 的内容摘要已变化，禁止改写历史迁移`);
  }

  for (const file of files) {
    const timestamp = migrationTimestamp(file);
    if (timestamp <= baseline.baselineTimestamp) {
      if (!Object.hasOwn(baseline.files, file)) failures.push(`${file} 使用了已冻结的历史时间戳；新增迁移必须晚于 ${baseline.baselineTimestamp}`);
      continue;
    }
    const source = await readFile(resolve(migrationsDir, file), 'utf8');
    failures.push(...inspectNewMigration(file, source));
  }
  return [...new Set(failures)];
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const failures = await verifyMigrationCompatibility();
  if (failures.length) {
    for (const failure of failures) console.error(`FAIL ${failure}`);
    process.exitCode = 1;
  } else {
    console.log('PASS 历史迁移摘要未变化，新增迁移符合在线兼容发布契约');
  }
}
