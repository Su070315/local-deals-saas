import { CheckCircleFilled, CloudServerOutlined, ReloadOutlined, SafetyCertificateOutlined, WarningFilled } from '@ant-design/icons';
import { Alert, Button, Descriptions, Space, Tag, message } from 'antd';
import { useCallback, useEffect, useState } from 'react';

type Request = <T>(path: string, init?: RequestInit) => Promise<T>;
type SmsStatus = {
  smsReady: boolean;
  smsRegion: string;
  smsSdkAppId: string;
  smsSignName: string;
  smsChecks: Array<{ key: string; label: string; configured: boolean }>;
};

export default function SmsPlatformPage({ merchantId, request, onNavigate }: { merchantId: string; request: Request; onNavigate: (page: string) => void }) {
  const [status, setStatus] = useState<SmsStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const load = useCallback(async () => {
    setLoading(true);
    try { setStatus(await request<SmsStatus>(`/wechat-platform/status?merchantId=${merchantId}`)); }
    catch (error) { message.error((error as Error).message); }
    finally { setLoading(false); }
  }, [merchantId, request]);
  useEffect(() => { void load(); }, [load]);

  if (!status) return <section className="wechat-platform-page"><Button loading={loading} icon={<ReloadOutlined />} onClick={() => void load()}>加载短信平台状态</Button></section>;
  return <div className="wechat-platform-page">
    <section className="wechat-hero"><div><span>腾讯云能力</span><h2>短信服务配置</h2><p>密钥只由服务器环境变量托管，商户端不读取、不回显、不保存 SecretKey</p></div><div className="wechat-hero-actions"><Tag color={status.smsReady ? 'green' : 'gold'}>{status.smsReady ? '短信服务已就绪' : '配置待补齐'}</Tag><Button ghost icon={<ReloadOutlined />} loading={loading} onClick={() => void load()}>刷新状态</Button></div></section>
    {!status.smsReady && <Alert showIcon type="warning" message="腾讯云短信尚未完整配置" description="请由服务器运维补齐短信访问凭据、SDK AppID、已审核签名和默认模板 ID。商户端页面只维护模板用途和发送规则。" />}
    <section className="wechat-config-grid">
      <div className="wechat-config-panel"><div className="wechat-section-title"><div><strong>服务器配置检查</strong><span>所有检查均通过后才能接入真实发送任务</span></div><SafetyCertificateOutlined /></div><div className="wechat-check-list">{status.smsChecks.map((check) => <div key={check.key}>{check.configured ? <CheckCircleFilled className="ok" /> : <WarningFilled className="warn" />}<span>{check.label}</span><Tag color={check.configured ? 'green' : 'gold'}>{check.configured ? '已配置' : '待配置'}</Tag></div>)}</div></div>
      <div className="wechat-config-panel"><div className="wechat-section-title"><div><strong>当前短信应用</strong><span>仅展示非敏感标识</span></div><CloudServerOutlined /></div><Descriptions column={1} size="small"><Descriptions.Item label="地域">{status.smsRegion || 'ap-guangzhou'}</Descriptions.Item><Descriptions.Item label="SDK AppID">{status.smsSdkAppId || '未配置'}</Descriptions.Item><Descriptions.Item label="短信签名">{status.smsSignName || '未配置'}</Descriptions.Item><Descriptions.Item label="密钥状态"><Tag color={status.smsChecks[0]?.configured ? 'green' : 'default'}>{status.smsChecks[0]?.configured ? '服务器已托管' : '未配置'}</Tag></Descriptions.Item></Descriptions><Space wrap><Button type="primary" onClick={() => onNavigate('smsTemplates')}>管理短信模板</Button><Button onClick={() => onNavigate('smsProviderRules')}>发送规则</Button><Button onClick={() => onNavigate('smsRecords')}>发送记录</Button></Space></div>
    </section>
  </div>;
}
