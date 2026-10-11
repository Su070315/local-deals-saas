import { CheckCircleOutlined, PauseCircleOutlined, ReloadOutlined, SafetyCertificateOutlined } from '@ant-design/icons';
import { Alert, Button, Card, Descriptions, Empty, Input, Modal, Space, Tag, Typography, message } from 'antd';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { PlatformAccessProfile, User } from './workspace-model';
import { platformCan } from './workspace-model';

type Request = <T>(path: string, init?: RequestInit) => Promise<T>;
type RuntimeControl = {
  key: string;
  status: 'ENABLED' | 'PAUSED' | 'RESUME_PENDING';
  enabled: boolean;
  reason: string;
  updatedBy: string | null;
  resumeRequestedBy: string | null;
  version: number;
  updatedAt: string | null;
};
type Action = 'pause' | 'resume-request' | 'resume-approve';

const statusLabel: Record<RuntimeControl['status'], string> = { ENABLED: '新订单开放', PAUSED: '全局止售', RESUME_PENDING: '等待恢复复核' };
const statusColor: Record<RuntimeControl['status'], string> = { ENABLED: 'green', PAUSED: 'red', RESUME_PENDING: 'gold' };
const actionText: Record<Action, string> = { pause: '暂停全局新订单', 'resume-request': '申请恢复新订单', 'resume-approve': '复核并恢复新订单' };

export default function RuntimeControlsPage({ user, request, onRequireStepUp }: { user: User; request: Request; onRequireStepUp: () => void }) {
  const [control, setControl] = useState<RuntimeControl | null>(null);
  const [loading, setLoading] = useState(false);
  const [action, setAction] = useState<Action | null>(null);
  const [note, setNote] = useState('');
  const idempotencyKeyRef = useRef<string | null>(null);
  const canOperate = platformCan(user, 'OPERATIONS');
  const profile = user.role === 'PLATFORM_ADMIN' ? (user.platformAccessProfile || 'SYSTEM_ADMIN') as PlatformAccessProfile : null;

  const load = useCallback(async () => {
    setLoading(true);
    try { setControl(await request<RuntimeControl>('/platform/runtime-controls/sales')); }
    catch (error) { message.error((error as Error).message); }
    finally { setLoading(false); }
  }, [request]);

  useEffect(() => { void load(); }, [load]);

  async function submit() {
    if (!control || !action || note.trim().length < 3) return;
    const requestKey = idempotencyKeyRef.current || crypto.randomUUID().replaceAll('-', '');
    idempotencyKeyRef.current = requestKey;
    try {
      const next = await request<RuntimeControl>(`/platform/runtime-controls/sales/${action}`, { method: 'POST', headers: { 'Idempotency-Key': requestKey }, body: JSON.stringify({ expectedVersion: control.version, note: note.trim() }) });
      setControl(next); setAction(null); setNote(''); idempotencyKeyRef.current = null;
      message.success(actionText[action] + '已完成');
    } catch (error) {
      const text = (error as Error).message;
      if (text.includes('身份') || text.includes('密码')) { message.warning('该操作需要先完成身份确认。'); onRequireStepUp(); }
      else if (text.includes('版本') || text.includes('复核')) { idempotencyKeyRef.current = null; message.warning('状态已变化，正在刷新控制面。'); await load(); }
      else message.error(text);
    }
  }

  if (!control) return <Card className="data-panel" variant="borderless" loading={loading}><Empty description={loading ? '正在加载全局销售控制' : '无法读取全局销售控制'} /></Card>;
  const canApprove = canOperate && control.status === 'RESUME_PENDING' && control.resumeRequestedBy !== user.id;
  const actionHint = control.status === 'ENABLED' ? '暂停只影响新订单；已支付券、退款、核销和支付补偿继续按原流程处理。' : control.status === 'PAUSED' ? '平台当前拒绝所有新订单。已有券仍可正常核销，恢复销售必须先提交申请。' : control.resumeRequestedBy === user.id ? '当前账号已提交恢复申请，必须等待另一名平台运营账号复核。' : '已有另一名平台运营账号提交恢复申请，请核对支付和订单链路后复核。';

  return <Card className="data-panel" variant="borderless" title={<Space><SafetyCertificateOutlined /><span>全局销售控制</span><Tag color={statusColor[control.status]}>{statusLabel[control.status]}</Tag></Space>} extra={<Button aria-label="刷新全局销售控制" icon={<ReloadOutlined />} loading={loading} onClick={() => void load()}>刷新</Button>}>
    <Alert type={control.status === 'ENABLED' ? 'success' : 'warning'} showIcon message={actionHint} style={{ marginBottom: 18 }} />
    <Descriptions column={{ xs: 1, sm: 2 }} size="small">
      <Descriptions.Item label="当前状态">{statusLabel[control.status]}</Descriptions.Item>
      <Descriptions.Item label="控制版本">v{control.version}</Descriptions.Item>
      <Descriptions.Item label="最近说明" span={2}>{control.reason || '暂无说明'}</Descriptions.Item>
      <Descriptions.Item label="最近更新时间">{control.updatedAt ? new Date(control.updatedAt).toLocaleString('zh-CN') : '尚未变更'}</Descriptions.Item>
      <Descriptions.Item label="恢复申请人">{control.resumeRequestedBy ? `${control.resumeRequestedBy.slice(0, 8)}…` : '无'}</Descriptions.Item>
    </Descriptions>
    <Space wrap style={{ marginTop: 20 }}>
      {canOperate && control.status === 'ENABLED' && <Button danger icon={<PauseCircleOutlined />} onClick={() => { setNote(''); idempotencyKeyRef.current = crypto.randomUUID().replaceAll('-', ''); setAction('pause'); }}>暂停全局新订单</Button>}
      {canOperate && control.status === 'PAUSED' && <Button type="primary" icon={<CheckCircleOutlined />} onClick={() => { setNote(''); idempotencyKeyRef.current = crypto.randomUUID().replaceAll('-', ''); setAction('resume-request'); }}>申请恢复新订单</Button>}
      {canApprove && <Button type="primary" icon={<CheckCircleOutlined />} onClick={() => { setNote(''); idempotencyKeyRef.current = crypto.randomUUID().replaceAll('-', ''); setAction('resume-approve'); }}>复核并恢复新订单</Button>}
      {!canOperate && <Typography.Text type="secondary">当前职责仅可查看状态，不能改变全局销售开关。</Typography.Text>}
    </Space>
    <Modal open={!!action} title={action ? actionText[action] : ''} okText="确认提交" cancelText="取消" onOk={() => void submit()} onCancel={() => { idempotencyKeyRef.current = null; setAction(null); }} okButtonProps={{ disabled: note.trim().length < 3 }}>
      <Typography.Paragraph type="secondary">请输入可审计的操作说明（3 至 500 字）。控制版本 v{control.version} 会用于防止覆盖其他人的最新操作。</Typography.Paragraph>
      <Input.TextArea aria-label="全局销售控制操作说明" value={note} onChange={(event) => setNote(event.target.value)} maxLength={500} showCount rows={4} placeholder="例如：支付服务商回调异常，暂停售卖新订单。" />
    </Modal>
    {profile === 'SECURITY' && <Typography.Paragraph type="secondary" style={{ marginTop: 18, marginBottom: 0 }}>安全职责可查看控制状态和审计记录；恢复与止售由平台运营职责执行。</Typography.Paragraph>}
  </Card>;
}
