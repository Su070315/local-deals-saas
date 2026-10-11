import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

const workspaceRole = process.env.VITE_WORKSPACE_ROLE || 'ALL';
const workspacePort = Number(process.env.VITE_PORT || 5173);
const suppliedReleaseId = String(process.env.VITE_RELEASE_ID || '').trim();
const workspaceReleaseId = suppliedReleaseId || 'local-dev';
if (!['ALL', 'PLATFORM_ADMIN', 'AGENCY_ADMIN', 'MERCHANT_ADMIN', 'STORE_STAFF'].includes(workspaceRole)) throw new Error('VITE_WORKSPACE_ROLE 必须为 ALL、PLATFORM_ADMIN、AGENCY_ADMIN、MERCHANT_ADMIN 或 STORE_STAFF');
if (!Number.isInteger(workspacePort) || workspacePort < 1 || workspacePort > 65535) throw new Error('VITE_PORT 必须是 1 至 65535 的整数');
if (process.env.VITE_REQUIRE_RELEASE_ID === 'true' && !suppliedReleaseId) throw new Error('发布构建必须提供 VITE_RELEASE_ID');
if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(workspaceReleaseId)) throw new Error('VITE_RELEASE_ID 只能包含字母、数字、点、下划线或连字符，且长度为 1 至 128 位');

function workspaceManifestPlugin(role: string, releaseId: string): Plugin {
  return {
    name: 'workspace-manifest',
    generateBundle() {
      // The deploy probe reads this static, non-sensitive identity instead of
      // inferring a workspace role from a host name or an image label.
      this.emitFile({
        type: 'asset',
        fileName: 'workspace-manifest.json',
        source: `${JSON.stringify({ workspaceRole: role, apiPath: '/api/v1/', releaseId }, null, 2)}\n`,
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), workspaceManifestPlugin(workspaceRole, workspaceReleaseId)],
  build: {
    // The UI framework is a stable authenticated-only cache group. Business
    // chunks remain small and can be rolled forward without redownloading it.
    chunkSizeWarningLimit: 950,
    rollupOptions: {
      output: {
        manualChunks(id) {
          const normalizedId = id.replaceAll('\\', '/');
          if (!normalizedId.includes('/node_modules/')) return undefined;
          if (normalizedId.includes('/react/') || normalizedId.includes('/react-dom/') || normalizedId.includes('/scheduler/')) return 'vendor-react';
          if (normalizedId.includes('/dayjs/')) return 'vendor-dayjs';
          if (normalizedId.includes('/node_modules/antd/') || normalizedId.includes('/node_modules/@ant-design/') || normalizedId.includes('/node_modules/rc-') || normalizedId.includes('/node_modules/@rc-component/')) return 'vendor-ui';
          return undefined;
        },
      },
    },
  },
  server: {
    host: '127.0.0.1',
    port: workspacePort,
    strictPort: true,
    proxy: {
      '/api': {
        target: process.env.VITE_API_PROXY_TARGET || 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
});
