import React, { Suspense, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';

const API = import.meta.env.VITE_API_URL || '/api/v1';
const configuredWorkspaceRole = String(import.meta.env.VITE_WORKSPACE_ROLE || 'ALL');
const workspaceReleaseId = String(import.meta.env.VITE_RELEASE_ID || 'local-dev');
const workspaceName: Record<string, string> = { ALL: '综合运营台', PLATFORM_ADMIN: '平台运营', AGENCY_ADMIN: '商家运营', MERCHANT_ADMIN: '商家经营', STORE_STAFF: '门店核销' };
const WorkspaceApp = React.lazy(() => import('./workspace-app'));
const MerchantInviteAcceptance = React.lazy(() => import('./features/merchant-invite-acceptance'));

function messageFromResponse(body: unknown): string {
  if (!body || typeof body !== 'object') return '登录失败，请稍后重试';
  const message = (body as { message?: unknown }).message;
  return Array.isArray(message) ? message.join('；') : typeof message === 'string' ? message : '登录失败，请稍后重试';
}

function retryAfterHint(body: unknown, retryAfterHeader: string | null = null): string {
  const bodyRetryAfter = body && typeof body === 'object' ? Number((body as { retryAfterSeconds?: unknown }).retryAfterSeconds) : 0;
  const headerRetryAfter = retryAfterHeader && /^\d+$/.test(retryAfterHeader) ? Number(retryAfterHeader) : 0;
  const seconds = Math.max(bodyRetryAfter, headerRetryAfter);
  return Number.isFinite(seconds) && seconds > 0 ? `，请在约 ${Math.max(1, Math.ceil(seconds / 60))} 分钟后再试` : '';
}

function localWorkspaceOriginHint(message: string): string {
  const isLoopback = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
  if (!import.meta.env.DEV || isLoopback || message !== '当前来源不可登录运营工作台') return '';
    return '。本地开发请打开统一运营入口 http://localhost:5173';
}

function canUseWorkspace(role: unknown): boolean {
  return configuredWorkspaceRole === 'ALL' || role === configuredWorkspaceRole;
}

function hasStoredOperatorSession(): boolean {
  return Boolean(sessionStorage.getItem('deals_token') || localStorage.getItem('deals_token'));
}

function inviteTokenFromHash(): string | null {
  const prefix = '#merchant-admin-invite=';
  if (!window.location.hash.startsWith(prefix)) return null;
  try {
    const token = decodeURIComponent(window.location.hash.slice(prefix.length));
    return /^[A-Za-z0-9_-]{32,256}$/.test(token) ? token : null;
  } catch { return null; }
}

class WorkspaceErrorBoundary extends React.Component<React.PropsWithChildren, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo): void {
    console.error('Workspace startup failure', { workspace: workspaceName[configuredWorkspaceRole] || '运营工作台', releaseId: workspaceReleaseId, path: window.location.pathname, error, componentStack: errorInfo.componentStack });
  }

  render(): React.ReactNode {
    if (!this.state.error) return this.props.children;
    return <FailureScreen updateRequired={/ChunkLoadError|Failed to fetch dynamically imported module|Importing a module script failed/i.test(this.state.error.message)} />;
  }
}

function FailureScreen({ updateRequired }: { updateRequired: boolean }) {
  return <main className="workspace-failure" role="alert" aria-labelledby="workspace-failure-title">
    <section className="workspace-failure-card">
      <span className="brand-mark workspace-failure-mark" aria-hidden="true">示</span>
      <h1 id="workspace-failure-title">{updateRequired ? '系统已更新，请重新加载' : '页面暂时无法打开'}</h1>
      <p>{updateRequired ? '当前页面仍在使用发布前的资源。重新加载会获取与本次发布匹配的工作台；未提交的表单不会自动保存或重放。' : `${workspaceName[configuredWorkspaceRole] || '运营工作台'}遇到了意外异常。系统不会因这次异常自动重试或新增操作；若刚刚提交过内容，请重新打开页面后核对操作记录。`}</p>
      <dl className="workspace-failure-details">
        <div><dt>当前工作台</dt><dd>{workspaceName[configuredWorkspaceRole] || '运营工作台'}</dd></div>
        <div><dt>服务版本</dt><dd>{workspaceReleaseId}</dd></div>
      </dl>
      <button className="workspace-primary-button" type="button" onClick={() => window.location.reload()}>重新加载</button>
      <p className="workspace-failure-help">如多次出现，请将“当前工作台”和“服务版本”提供给技术支持，便于快速定位并安全回滚。</p>
    </section>
  </main>;
}

function StartupLoading() {
  return <main className="workspace-loading" role="status" aria-live="polite">
    <span className="brand-mark" aria-hidden="true">示</span>
    <strong>正在安全加载工作台</strong>
  </main>;
}

function SignIn({ onSuccess }: { onSuccess: () => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;
    setError('');
    setSubmitting(true);
    try {
      const response = await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        const loginMessage = messageFromResponse(result);
        throw new Error(`${loginMessage}${localWorkspaceOriginHint(loginMessage)}${retryAfterHint(result, response.headers.get('retry-after'))}`);
      }
      const profile = result as { token?: unknown; user?: { role?: unknown } };
      if (typeof profile.token !== 'string' || !profile.user || !canUseWorkspace(profile.user.role)) {
        if (typeof profile.token === 'string') void fetch(`${API}/auth/logout`, { method: 'POST', headers: { Authorization: `Bearer ${profile.token}` } });
        throw new Error(`该账号不适用于${workspaceName[configuredWorkspaceRole] || '当前工作台'}`);
      }
      sessionStorage.setItem('deals_token', profile.token);
      sessionStorage.setItem('deals_user', JSON.stringify(profile.user));
      localStorage.removeItem('deals_token');
      localStorage.removeItem('deals_user');
      onSuccess();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '登录失败，请稍后重试');
    } finally {
      setSubmitting(false);
    }
  }

  return <main className="login">
    <section className="login-shell">
      <div className="login-showcase" aria-label="示例商城 SaaS">
        <div className="login-showcase-brand"><span className="brand-mark" aria-hidden="true">示</span><span>示例商城</span></div>
        <div className="login-showcase-copy">
          <p className="login-eyebrow">本地生活数字化经营平台</p>
          <h1>让商家经营更简单，<br />让代理协作更清晰</h1>
          <p>覆盖商家开通、门店经营、商品交易、券码核销、财务报表和小程序授权的一体化 SaaS 工作台。</p>
        </div>
        <div className="login-capabilities" aria-label="平台能力">
          <span>多角色权限隔离</span><span>经营数据实时汇总</span><span>微信小程序协同</span>
        </div>
      </div>
      <section className="login-card login-native-card" aria-labelledby="login-title">
        <div className="login-workspace-tag">{workspaceName[configuredWorkspaceRole] || '运营工作台'}</div>
        <div className="login-brand"><span className="brand-mark" aria-hidden="true">示</span><div><h2 id="login-title">欢迎登录</h2><p>使用管理员分配的工作台账号</p></div></div>
        <form onSubmit={submit} noValidate>
          <label htmlFor="operator-email">账号</label>
          <input id="operator-email" type="text" inputMode="email" autoComplete="username" placeholder="手机号、邮箱或管理员账号" value={email} onChange={(event) => setEmail(event.target.value)} required disabled={submitting} />
          <label htmlFor="operator-password">密码</label>
          <input id="operator-password" type="password" autoComplete="current-password" placeholder="请输入登录密码" value={password} onChange={(event) => setPassword(event.target.value)} required disabled={submitting} />
          {error && <p className="login-error" role="alert">{error}</p>}
          <button className="workspace-primary-button login-submit" type="submit" disabled={submitting}>{submitting ? '正在安全登录…' : '登 录'}</button>
        </form>
        <p className="login-note">登录即表示你已阅读并同意平台服务协议与隐私政策。版本：{workspaceReleaseId}</p>
      </section>
    </section>
  </main>;
}

function Bootstrap() {
  const [authenticated, setAuthenticated] = useState(hasStoredOperatorSession);
  const [inviteToken, setInviteToken] = useState<string | null>(inviteTokenFromHash);
  if (inviteToken) return <Suspense fallback={<StartupLoading />}><MerchantInviteAcceptance token={inviteToken} onComplete={() => { window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`); setInviteToken(null); }} /></Suspense>;
  if (!authenticated) return <SignIn onSuccess={() => setAuthenticated(true)} />;
  return <Suspense fallback={<StartupLoading />}><WorkspaceApp /></Suspense>;
}

createRoot(document.getElementById('root')!).render(<WorkspaceErrorBoundary><Bootstrap /></WorkspaceErrorBoundary>);
