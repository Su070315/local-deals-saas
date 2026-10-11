import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { verifyMigrationCompatibility } from './migration-compatibility-verify.mjs';

const BASELINE_TIMESTAMP = 1784335140000;

function digest(source) {
  return createHash('sha256').update(source).digest('hex');
}

async function fixture(files, baselineFiles = {}) {
  const root = await mkdtemp(join(tmpdir(), 'local-deals-migration-policy-'));
  const directory = join(root, 'apps', 'api', 'src', 'migrations');
  const scriptsDirectory = join(root, 'scripts');
  await Promise.all([mkdir(directory, { recursive: true }), mkdir(scriptsDirectory, { recursive: true })]);
  await Promise.all(Object.entries(files).map(([name, source]) => writeFile(join(directory, name), source)));
  await writeFile(join(scriptsDirectory, 'migration-baseline.json'), JSON.stringify({
    version: 1,
    baselineTimestamp: BASELINE_TIMESTAMP,
    files: Object.fromEntries(Object.entries(baselineFiles).map(([name, source]) => [name, digest(source)])),
  }));
  return root;
}

function migration(up, prefix = '') {
  return `export class ExampleMigration {\n  ${prefix}async up(queryRunner) {\n    ${up}\n  }\n}\n`;
}

test('accepts additive online-compatible migrations after the enforcement baseline', async () => {
  const root = await fixture({
    '1784335140001-AddOptionalNote.ts': migration(`await queryRunner.query('ALTER TABLE "merchants" ADD COLUMN IF NOT EXISTS "note" text');`),
  });
  try {
    assert.deepEqual(await verifyMigrationCompatibility(root), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects destructive or blocking operations in a rolling-release migration', async () => {
  const root = await fixture({
    '1784335140001-UnsafeSchemaChange.ts': migration(`
      await queryRunner.query('ALTER TABLE "merchants" DROP COLUMN "legacyCode"');
      await queryRunner.query('CREATE INDEX "IDX_merchants_note" ON "merchants" ("note")');
    `),
  });
  try {
    const failures = await verifyMigrationCompatibility(root);
    assert.equal(failures.some((message) => message.includes('破坏性 DDL')), true);
    assert.equal(failures.some((message) => message.includes('CREATE INDEX CONCURRENTLY')), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('accepts an explicitly non-transactional concurrent index migration', async () => {
  const root = await fixture({
    '1784335140001-AddOnlineIndex.ts': migration(
      `await queryRunner.query('CREATE INDEX CONCURRENTLY "IDX_merchants_note" ON "merchants" ("note")');`,
      'transaction = false;\n  ',
    ),
  });
  try {
    assert.deepEqual(await verifyMigrationCompatibility(root), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects destructive QueryRunner schema APIs', async () => {
  const root = await fixture({
    '1784335140001-DropWithApi.ts': migration(`await queryRunner.dropTable('merchants');`),
  });
  try {
    assert.equal((await verifyMigrationCompatibility(root)).some((message) => message.includes('删除表')), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('does not let braces inside SQL strings hide a later destructive statement', async () => {
  const root = await fixture({
    '1784335140001-BraceInSql.ts': migration(`
      await queryRunner.query("SELECT '}'");
      await queryRunner.query('DROP TABLE merchants');
    `),
  });
  try {
    assert.equal((await verifyMigrationCompatibility(root)).some((message) => message.includes('破坏性 DDL')), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects a new migration inserted into the frozen timestamp range', async () => {
  const root = await fixture({
    '1784335139999-NewButHistorical.ts': migration(`await queryRunner.query('DROP TABLE merchants');`),
  });
  try {
    assert.equal((await verifyMigrationCompatibility(root)).some((message) => message.includes('已冻结的历史时间戳')), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects any content change to a frozen migration', async () => {
  const file = '1784335140000-Frozen.ts';
  const released = migration(`await queryRunner.query('CREATE TABLE safe_table (id integer)');`);
  const modified = migration(`await queryRunner.query('DROP TABLE merchants');`);
  const root = await fixture({ [file]: modified }, { [file]: released });
  try {
    assert.equal((await verifyMigrationCompatibility(root)).some((message) => message.includes('内容摘要已变化')), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
