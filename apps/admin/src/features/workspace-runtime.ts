import type { Role, User } from './workspace-model';

export const API = import.meta.env.VITE_API_URL || '/api/v1';
export const MERCHANT_SCOPE_CACHE_MAX_AGE_MS = 30_000;
export const PAGES_REQUIRING_STORE_CONTEXT = new Set(['stores', 'packages', 'template', 'staff', 'orders', 'vouchers', 'verifications', 'inventoryRecords', 'inventoryPurchase', 'inventoryRequisition', 'inventoryInbound', 'inventoryOutbound', 'inventoryLoss', 'inventoryCount', 'inventoryTransfer']);

const configuredWorkspaceRole = String(import.meta.env.VITE_WORKSPACE_ROLE || 'ALL');
if (!['ALL', 'PLATFORM_ADMIN', 'AGENCY_ADMIN', 'MERCHANT_ADMIN', 'STORE_STAFF'].includes(configuredWorkspaceRole)) throw new Error('VITE_WORKSPACE_ROLE 配置无效');

export const workspaceRole = configuredWorkspaceRole as Role | 'ALL';
export const workspaceReleaseId = String(import.meta.env.VITE_RELEASE_ID || 'local-dev');
export const workspaceName: Record<Role | 'ALL', string> = { ALL: '综合运营台', PLATFORM_ADMIN: '平台运营', AGENCY_ADMIN: '商家运营', MERCHANT_ADMIN: '商家经营', STORE_STAFF: '门店核销' };

export function workspaceAllows(role: Role): boolean {
  return workspaceRole === 'ALL' || workspaceRole === role;
}

export function retryAfterHint(body: unknown, retryAfterHeader: string | null = null): string {
  const bodySeconds = body && typeof body === 'object' ? Number((body as { retryAfterSeconds?: unknown }).retryAfterSeconds) : 0;
  const headerSeconds = retryAfterHeader && /^\d+$/.test(retryAfterHeader) ? Number(retryAfterHeader) : 0;
  const seconds = Math.max(bodySeconds, headerSeconds);
  return Number.isFinite(seconds) && seconds > 0 ? `，请在约 ${Math.max(1, Math.ceil(seconds / 60))} 分钟后再试` : '';
}

export function localWorkspaceOriginHint(message: string): string {
  const isLoopback = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
  if (!import.meta.env.DEV || isLoopback || message !== '当前来源不可登录运营工作台') return '';
  return '。本地开发请打开统一运营入口 http://localhost:5173';
}

const OPERATOR_TOKEN_KEY = 'deals_token';
const OPERATOR_USER_KEY = 'deals_user';

/** Operator credentials must not remain on a shared workstation after its browser closes. */
export function readOperatorToken(): string | null {
  return readOperatorSessionValue(OPERATOR_TOKEN_KEY);
}

export function persistOperatorSession(token: string, user: User): void {
  sessionStorage.setItem(OPERATOR_TOKEN_KEY, token);
  sessionStorage.setItem(OPERATOR_USER_KEY, JSON.stringify(user));
  localStorage.removeItem(OPERATOR_TOKEN_KEY);
  localStorage.removeItem(OPERATOR_USER_KEY);
}

export function clearStoredOperatorSession(): void {
  sessionStorage.removeItem(OPERATOR_TOKEN_KEY);
  sessionStorage.removeItem(OPERATOR_USER_KEY);
  localStorage.removeItem(OPERATOR_TOKEN_KEY);
  localStorage.removeItem(OPERATOR_USER_KEY);
}

export function loadStoredUser(): User | null {
  try {
    const stored = readOperatorSessionValue(OPERATOR_USER_KEY);
    if (!stored) return null;
    const user = JSON.parse(stored) as User;
    return user?.id && user?.role ? user : null;
  } catch {
    clearStoredOperatorSession();
    return null;
  }
}

function readOperatorSessionValue(key: typeof OPERATOR_TOKEN_KEY | typeof OPERATOR_USER_KEY): string | null {
  const current = sessionStorage.getItem(key);
  if (current) return current;
  const legacy = localStorage.getItem(key);
  if (!legacy) return null;
  sessionStorage.setItem(key, legacy);
  localStorage.removeItem(key);
  return legacy;
}
