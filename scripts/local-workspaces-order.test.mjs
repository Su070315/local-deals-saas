import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('local workspace harness exposes frontends only after the API is listening', async () => {
  const source = await readFile(new URL('./local-workspaces.mjs', import.meta.url), 'utf8');
  const apiWait = source.indexOf('const apiPending = await waitForPorts([3001])');
  const frontendStart = source.indexOf("start(workspace.name, ['run', 'dev', '-w', '@local-deals/admin']");
  assert.notEqual(apiWait, -1, 'API readiness wait is missing');
  assert.notEqual(frontendStart, -1, 'workspace frontend startup is missing');
  assert.ok(apiWait < frontendStart, 'workspace frontends can listen before the API is ready');
});
