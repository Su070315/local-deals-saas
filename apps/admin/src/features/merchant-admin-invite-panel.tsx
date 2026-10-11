import { CopyOutlined } from '@ant-design/icons';
import { Alert, Button, Input, Modal, Space, Typography, message } from 'antd';
import React, { useState } from 'react';
import type { Merchant } from './workspace-model';

type Request = <T>(path: string, init?: RequestInit) => Promise<T>;
type Invite = { id: string; merchantId: string; email: string; name: string; token: string; expiresAt: string };
type Props = { merchant: Merchant; request: Request; onRequireStepUp: () => void; onClose: () => void };

export default function MerchantAdminInvitePanel({ merchant, request, onRequireStepUp, onClose }: Props) {
  const [open, setOpen] = useState(true);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [invite, setInvite] = useState<Invite | null>(null);
  const [loading, setLoading] = useState(false);

  function close() {
    if (loading) return;
    setOpen(false); setInvite(null); setName(''); setEmail(''); onClose();
  }
  async function create() {
    const normalizedName = name.trim();
    const normalizedEmail = email.trim().toLowerCase();
    if (!normalizedName || normalizedName.length > 80) { message.warning('请输入 1 至 80 个字符的管理员姓名'); return; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) { message.warning('请输入有效的管理员账号'); return; }
    setLoading(true);
    try {
      const result = await request<Invite>(`/merchants/${merchant.id}/admin-invites`, {
        method: 'POST', headers: { 'Idempotency-Key': crypto.randomUUID().replaceAll('-', '') },
        body: JSON.stringify({ name: normalizedName, email: normalizedEmail }),
      });
      setInvite(result); message.success('一次性邀请已生成，请立即交付给商家管理员');
    } catch (error) {
      const text = (error as Error).message;
      if (text.includes('身份') || text.includes('密码')) onRequireStepUp();
      message.error(text);
    } finally { setLoading(false); }
  }
  async function copyToken() {
    if (!invite) return;
    try { await navigator.clipboard.writeText(invite.token); message.success('邀请令牌已复制'); }
    catch { message.warning('浏览器不允许自动复制，请手动选择令牌'); }
  }
  async function copyAcceptanceUrl() {
    if (!invite) return;
    const url = `${window.location.origin}/#merchant-admin-invite=${encodeURIComponent(invite.token)}`;
    try { await navigator.clipboard.writeText(url); message.success('邀请链接已复制'); }
    catch { message.warning('浏览器不允许自动复制，请手动选择邀请链接'); }
  }

  return <Modal title={`邀请 ${merchant.brandName} 管理员`} open={open} onCancel={close} destroyOnClose={false} footer={invite ? <Button onClick={close}>关闭</Button> : <Space><Button onClick={close}>取消</Button><Button type="primary" loading={loading} onClick={() => void create()}>生成一次性邀请</Button></Space>}>
      {invite ? <Space direction="vertical" size="middle" style={{ width: '100%' }}><Alert type="success" showIcon message="邀请已生成，仅显示本次令牌；关闭后无法从系统恢复，请立即复制并通过合规渠道交付。" /><Typography.Text>管理员：{invite.name}（{invite.email}）</Typography.Text><Input readOnly value={invite.token} addonAfter={<Button type="text" aria-label="复制邀请令牌" icon={<CopyOutlined />} onClick={() => void copyToken()} />} /><Input readOnly value={`${window.location.origin}/#merchant-admin-invite=${encodeURIComponent(invite.token)}`} addonAfter={<Button type="text" aria-label="复制邀请链接" icon={<CopyOutlined />} onClick={() => void copyAcceptanceUrl()} />} /><Typography.Text type="secondary">有效期至 {new Date(invite.expiresAt).toLocaleString('zh-CN', { hour12: false })}。管理员首次设置密码后才能登录。</Typography.Text></Space> : <Space direction="vertical" size="middle" style={{ width: '100%' }}><Typography.Text type="secondary">系统不会保存明文密码。邀请过期或误发时，请关闭当前窗口并重新生成。</Typography.Text><Input aria-label="管理员姓名" placeholder="管理员姓名" value={name} onChange={(event) => setName(event.target.value)} maxLength={80} /><Input aria-label="管理员登录账号" placeholder="管理员登录账号（邮箱）" value={email} onChange={(event) => setEmail(event.target.value)} maxLength={254} /></Space>}
    </Modal>;
}
