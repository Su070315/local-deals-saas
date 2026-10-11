import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { verifyReleaseCompatibility } from './release-compatibility-verify.mjs';

const files = [
  'packages/api-contract/compatibility-matrix.json',
  'packages/api-contract/v1-compatibility-baseline.json',
  'packages/api-contract/openapi.json',
  'apps/api/src/app.integration.spec.ts',
  'apps/api/src/app.module.ts',
  'apps/api/src/migration-runner.ts',
  'scripts/migration-compatibility-verify.mjs',
  'scripts/release-verify.mjs',
  'API_VERSIONING.md',
  'PRODUCTION_READINESS.md',
  'apps/admin/src/main.tsx',
  'apps/admin/src/features/workspace-runtime.ts',
  'apps/miniprogram-customer/utils/api-base.ts',
  'apps/miniprogram-verifier/utils/api-base.ts',
];

async function fixture() {
  const sourceRoot = process.cwd();
  const root = await mkdtemp(join(tmpdir(), 'local-deals-release-compatibility-'));
  await Promise.all(files.map(async (path) => {
    const destination = join(root, path);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(resolve(sourceRoot, path), destination);
  }));
  return root;
}

test('accepts the repository compatibility matrix', async () => {
  assert.deepEqual(await verifyReleaseCompatibility(), []);
});

test('rejects a missing supported client pair', async () => {
  const root = await fixture();
  const path = join(root, 'packages/api-contract/compatibility-matrix.json');
  const matrix = JSON.parse(await readFile(path, 'utf8'));
  matrix.clientPairs = matrix.clientPairs.filter((pair) => pair.id !== 'current-client-previous-api');
  await writeFile(path, JSON.stringify(matrix));
  assert.ok((await verifyReleaseCompatibility(root)).some((failure) => failure.includes('current-client-previous-api')));
});

test('rejects release automation that rolls the database backward', async () => {
  const root = await fixture();
  const path = join(root, 'scripts/release-verify.mjs');
  await writeFile(path, `${await readFile(path, 'utf8')}\n// migration:revert\n`);
  assert.ok((await verifyReleaseCompatibility(root)).some((failure) => failure.includes('数据库回退命令')));
});
