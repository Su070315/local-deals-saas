import { message } from 'antd';

type WorkspaceRequest = <T = unknown>(path: string, init?: RequestInit) => Promise<T>;

export function useSessionOperations({ request, refresh, clearLocalSession }: {
  request: WorkspaceRequest;
  refresh: () => Promise<void>;
  clearLocalSession: () => void;
}) {
  async function logout() {
    try { await request('/auth/logout', { method: 'POST' }); }
    catch { /* The server may already have invalidated this session. */ }
    finally { clearLocalSession(); }
  }

  async function revokeSession(sessionId: string) {
    try {
      await request(`/auth/sessions/${sessionId}`, { method: 'DELETE' });
      message.success('该设备已退出');
      await refresh();
    } catch (error) { message.error((error as Error).message); }
  }

  async function logoutOthers() {
    try {
      await request('/auth/logout-others', { method: 'POST' });
      message.success('其他设备已退出');
      await refresh();
    } catch (error) { message.error((error as Error).message); }
  }

  return { logout, revokeSession, logoutOthers };
}
