import { ReloadOutlined } from '@ant-design/icons';
import { Alert, Button, Card, Descriptions, Empty, Space, Steps, Tag, Typography, message } from 'antd';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Role } from './workspace-model';

type Request = <T>(path: string, init?: RequestInit) => Promise<T>;
type ProgressStep = { key: string; label: string; state: 'complete' | 'current' | 'pending'; status?: string };
type OnboardingStatus = {
  merchantName: string;
  onboardingStatus?: string;
  syncStatus?: string;
  lastSyncError?: string;
  authorizerAppId: string;
  authorizationStatus: string | null;
  latestRelease?: { status: string; userVersion: string } | null;
  steps?: ProgressStep[];
};

const RELEASE_LABEL: Record<string, string> = {
  DRAFT: '待提交代码', COMMITTED: '体验版已生成', AUDIT_SUBMITTED: '微信审核中', AUDIT_APPROVED: '审核通过',
  AUDIT_REJECTED: '审核被驳回', RELEASED: '已发布上线', FAILED: '发布失败',
};
/** 状态轮询间隔（毫秒）：代理商开通流程中自动监听后端真实状态 */
const STATUS_POLL_INTERVAL_MS = 8_000;
/** 终态：事实状态完成后停止轮询；同步异常仍显示健康状态，不改写业务完成事实。 */
const TERMINAL_ONBOARDING_STATUSES = new Set(['COMPLETE', 'FAILED']);

export default function MerchantOnboardingProgressPage({ merchantId, request, role }: { merchantId: string; request: Request; role?: Role }) {
  const [status, setStatus] = useState<OnboardingStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try { setStatus(await request<OnboardingStatus>(`/wechat-platform/status?merchantId=${encodeURIComponent(merchantId)}`)); }
    catch (error) { if (!silent) message.error(error instanceof Error ? error.message : '开通进度加载失败'); }
    finally { if (!silent) setLoading(false); }
  }, [merchantId, request]);
  useEffect(() => { void load(); }, [load]);

  // 真实状态自动监听：非终态时每 8 秒静默轮询后端真实状态（含微信授权/认证/备案/发布），
  // 达到 PUBLISHABLE/FAILED 终态或组件卸载后停止，避免无效后台请求与轮询弹错打扰。
  useEffect(() => {
    if (status && TERMINAL_ONBOARDING_STATUSES.has(status.onboardingStatus || '')) return;
    const timer = window.setInterval(() => { void load(true); }, STATUS_POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [status, load]);

  const steps = useMemo(() => status?.steps || [], [status]);
  const currentStep = steps.find((step) => step.state === 'current') || steps[steps.length - 1];
  const onboardingStatus = status?.onboardingStatus || 'ACTION_REQUIRED';
  const onboardingLabel = onboardingStatus === 'COMPLETE' ? '可发布' : onboardingStatus === 'FAILED' ? '处理失败' : onboardingStatus === 'PROCESSING' ? '处理中' : '待处理';
  const statusMessage = status?.lastSyncError || '微信真实事实自动同步，暂无错误说明';
  const releaseLabel = status?.latestRelease ? (RELEASE_LABEL[status.latestRelease.status] || status.latestRelease.status) : '尚未发布';
  if (!status && !loading) return <Card className="data-panel"><Empty description="暂无开通进度" /></Card>;

  return <div className="workspace-stack">
    <Card className="data-panel" loading={loading} title={status?.merchantName || '小程序开通进度'} extra={<Button icon={<ReloadOutlined />} onClick={() => void load()}>刷新</Button>}>
      {status && <>
        <Space wrap size={[8, 8]}>
          <Tag color={onboardingStatus === 'FAILED' ? 'error' : onboardingStatus === 'COMPLETE' ? 'success' : 'processing'}>{onboardingLabel}</Tag>
          <Tag color={status.authorizationStatus === 'AUTHORIZED' ? 'success' : 'default'}>{status.authorizationStatus === 'AUTHORIZED' ? '微信已授权' : '等待微信授权'}</Tag>
          <Tag color={status.latestRelease?.status === 'RELEASED' ? 'success' : 'default'}>{releaseLabel}</Tag>
        </Space>
        <Descriptions size="small" column={{ xs: 1, sm: 2 }} style={{ marginTop: 20 }}>
          <Descriptions.Item label="当前环节">{currentStep?.label || onboardingLabel}</Descriptions.Item>
          <Descriptions.Item label="授权小程序">{role === 'PLATFORM_ADMIN' || role === 'AGENCY_ADMIN' ? (status.authorizerAppId || '尚未绑定') : '仅平台/代理商可见'}</Descriptions.Item>
          <Descriptions.Item label="同步状态">{status.syncStatus || 'UNKNOWN'}</Descriptions.Item>
          <Descriptions.Item label="处理备注">{statusMessage}</Descriptions.Item>
          <Descriptions.Item label="发布版本">{status.latestRelease?.userVersion || '尚未生成'}</Descriptions.Item>
        </Descriptions>
      </>}
    </Card>
    {status && <Card className="data-panel" title="开通进度">
      <Steps direction="vertical" current={Math.max(0, steps.findIndex((step) => step.state === 'current'))} items={steps.map((step) => ({ title: step.label, status: step.state === 'complete' ? 'finish' : step.state === 'current' ? 'process' : 'wait' }))} />
      {onboardingStatus === 'FAILED'
        ? <Alert type="error" showIcon message={status.lastSyncError || '当前环节需要代理重新处理'} style={{ marginTop: 24 }} />
        : <Typography.Text type="secondary" style={{ display: 'block', marginTop: 24 }}>代理正在处理开通流程，页面每 8 秒自动同步一次微信侧真实状态（授权 / 认证 / 备案 / 发布），无需手动刷新。</Typography.Text>}
    </Card>}
  </div>;
}
