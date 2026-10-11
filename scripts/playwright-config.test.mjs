import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('browser workflows serialize access to the shared demo tenant', async () => {
  const source = await readFile(new URL('../playwright.config.ts', import.meta.url), 'utf8');
  assert.match(source, /fullyParallel:\s*false/);
  assert.match(source, /workers:\s*1/);
  assert.match(source, /PLAYWRIGHT_EXTERNAL_SERVER/);
});

test('the package E2E command owns cold-start and Windows process cleanup', async () => {
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const runner = await readFile(new URL('./run-e2e.mjs', import.meta.url), 'utf8');
  assert.equal(packageJson.scripts['test:e2e'], 'node scripts/run-e2e.mjs');
  assert.match(runner, /local-workspaces\.mjs/);
  assert.match(runner, /taskkill\.exe/);
  assert.match(runner, /waitForPortState\(false/);
});
