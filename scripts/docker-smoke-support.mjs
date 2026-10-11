const REQUIRED_SERVICES = new Map([
  ['postgres', { state: 'running', health: 'healthy' }],
  ['migrate', { state: 'exited', exitCode: 0 }],
  ['api-1', { state: 'running', health: 'healthy' }],
  ['api-2', { state: 'running', health: 'healthy' }],
  ['worker', { state: 'running', health: 'healthy' }],
  ['api-gateway', { state: 'running', health: 'healthy' }],
  ['platform', { state: 'running' }],
  ['agency', { state: 'running' }],
  ['merchant', { state: 'running' }],
  ['verify', { state: 'running' }],
]);

export function validateSmokeProjectName(value) {
  const name = String(value || '').trim();
  if (!/^localdealssmoke-[a-z0-9][a-z0-9_-]{0,47}$/.test(name)) {
    throw new Error('Docker 烟测项目名必须以 localdealssmoke- 开头，且只包含小写字母、数字、下划线或连字符');
  }
  return name;
}

export function parseComposePs(source) {
  const text = String(source || '').trim();
  if (!text) return [];
  if (text.startsWith('[')) {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) throw new Error('Docker Compose 状态不是数组');
    return parsed;
  }
  return text.split(/\r?\n/).filter(Boolean).flatMap((line) => {
    const parsed = JSON.parse(line);
    return Array.isArray(parsed) ? parsed : [parsed];
  });
}

export function parseLastJsonLine(source) {
  const lines = String(source || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try { return JSON.parse(lines[index]); } catch { /* keep looking past runtime banners */ }
  }
  throw new Error('命令输出缺少 JSON 结果');
}

function normalized(value) {
  return String(value ?? '').trim().toLowerCase();
}

export function assertProductionTopology(records) {
  const byService = new Map(records.map((record) => [record.Service, record]));
  const summary = {};
  for (const [service, expected] of REQUIRED_SERVICES) {
    const record = byService.get(service);
    if (!record) throw new Error(`Docker 拓扑缺少 ${service} 服务`);
    const state = normalized(record.State);
    const health = normalized(record.Health);
    const exitCode = Number(record.ExitCode ?? 0);
    if (state !== expected.state) throw new Error(`${service} 状态应为 ${expected.state}，实际为 ${state || 'unknown'}`);
    if (expected.health && health !== expected.health) throw new Error(`${service} 健康状态应为 ${expected.health}，实际为 ${health || 'unknown'}`);
    if (expected.exitCode !== undefined && exitCode !== expected.exitCode) throw new Error(`${service} 退出码应为 ${expected.exitCode}，实际为 ${exitCode}`);
    summary[service] = { state, ...(health ? { health } : {}), ...(state === 'exited' ? { exitCode } : {}) };
  }
  return summary;
}

export function assertWorkspaceManifest(manifest, expectedRole) {
  if (!manifest || typeof manifest !== 'object') throw new Error('工作台身份清单不是对象');
  if (manifest.workspaceRole !== expectedRole) throw new Error(`工作台角色应为 ${expectedRole}，实际为 ${String(manifest.workspaceRole || 'missing')}`);
  if (manifest.apiPath !== '/api/v1/') throw new Error(`工作台 API 路径应为 /api/v1/，实际为 ${String(manifest.apiPath || 'missing')}`);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(String(manifest.releaseId || ''))) throw new Error('工作台发布版本无效');
  return { workspaceRole: manifest.workspaceRole, apiPath: manifest.apiPath, releaseId: manifest.releaseId };
}
