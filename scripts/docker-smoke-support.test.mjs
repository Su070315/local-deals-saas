import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertProductionTopology,
  assertWorkspaceManifest,
  parseComposePs,
  parseLastJsonLine,
  validateSmokeProjectName,
} from './docker-smoke-support.mjs';

const healthyTopology = [
  { Service: 'postgres', State: 'running', Health: 'healthy' },
  { Service: 'migrate', State: 'exited', ExitCode: 0 },
  { Service: 'api-1', State: 'running', Health: 'healthy' },
  { Service: 'api-2', State: 'running', Health: 'healthy' },
  { Service: 'worker', State: 'running', Health: 'healthy' },
  { Service: 'api-gateway', State: 'running', Health: 'healthy' },
  { Service: 'platform', State: 'running' },
  { Service: 'agency', State: 'running' },
  { Service: 'merchant', State: 'running' },
  { Service: 'verify', State: 'running' },
];

test('accepts only isolated smoke project names', () => {
  assert.equal(validateSmokeProjectName('localdealssmoke-ci_123'), 'localdealssmoke-ci_123');
  assert.throws(() => validateSmokeProjectName('localdealsprod'), /localdealssmoke-/);
  assert.throws(() => validateSmokeProjectName('localdealssmoke-../../prod'), /只包含/);
});

test('parses array and newline-delimited compose status', () => {
  assert.deepEqual(parseComposePs(JSON.stringify(healthyTopology)), healthyTopology);
  assert.deepEqual(parseComposePs(healthyTopology.map((record) => JSON.stringify(record)).join('\n')), healthyTopology);
});

test('reads the final JSON result after harmless runtime banners', () => {
  assert.deepEqual(parseLastJsonLine('runtime banner\n{"sent":2,"failed":0}\n'), { sent: 2, failed: 0 });
  assert.throws(() => parseLastJsonLine('runtime banner only'), /缺少 JSON/);
});

test('requires the complete healthy production-shaped topology', () => {
  const summary = assertProductionTopology(healthyTopology);
  assert.equal(summary['api-1'].health, 'healthy');
  assert.throws(() => assertProductionTopology(healthyTopology.filter((record) => record.Service !== 'worker')), /缺少 worker/);
  assert.throws(() => assertProductionTopology(healthyTopology.map((record) => record.Service === 'api-2' ? { ...record, Health: 'unhealthy' } : record)), /api-2 健康状态/);
});

test('validates role, API path and release identity in workspace manifests', () => {
  assert.deepEqual(assertWorkspaceManifest({ workspaceRole: 'MERCHANT_ADMIN', apiPath: '/api/v1/', releaseId: 'release-123' }, 'MERCHANT_ADMIN'), {
    workspaceRole: 'MERCHANT_ADMIN', apiPath: '/api/v1/', releaseId: 'release-123',
  });
  assert.throws(() => assertWorkspaceManifest({ workspaceRole: 'PLATFORM_ADMIN', apiPath: '/api/v1/', releaseId: 'release-123' }, 'MERCHANT_ADMIN'), /工作台角色/);
  assert.throws(() => assertWorkspaceManifest({ workspaceRole: 'MERCHANT_ADMIN', apiPath: '/api/', releaseId: 'release-123' }, 'MERCHANT_ADMIN'), /API 路径/);
});
