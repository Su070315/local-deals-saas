import { CheckCircleFilled, ReloadOutlined, WarningFilled } from '@ant-design/icons';
import { Alert, Button, Descriptions, Space, Tag, message } from 'antd';
import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';

type Request = <T>(path: string, init?: RequestInit) => Promise<T>;
type LogisticsStatus = {
  localDeliveryReady: boolean;
  localDeliveryShopId: string;
  localDeliveryChecks: Array<{ key: string; label: string; configured: boolean }>;
  expressReady: boolean;
  expressChecks: Array<{ key: string; label: string; configured: boolean }>;
};

export default function LogisticsPlatformPage({ merchantId, request, onNavigate }: { merchantId: string; request: Request; onNavigate: (page: string) => void }) {
  const [status, setStatus] = useState<LogisticsStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const load = useCallback(async () => {
    setLoading(true);
    try { setStatus(await request<LogisticsStatus>(`/wechat-platform/status?merchantId=${merchantId}`)); }
    catch (error) { message.error((error as Error).message); }
    finally { setLoading(false); }
  }, [merchantId, request]);
  useEffect(() => { void load(); }, [load]);

  if (!status) return <section className="wechat-platform-page"><Button loading={loading} icon={<ReloadOutlined />} onClick={() => void load()}>加载配送平台状态</Button></section>;
  const allReady = status.localDeliveryReady && status.expressReady;
  return <div className="wechat-platform-page">
    <section className="wechat-hero"><div><span>门店履约能力</span><h2>配送与物流服务</h2><p>统一检查顺丰同城和快递100服务端配置，商户端只维护配送范围、计费与出单规则</p></div><div className="wechat-hero-actions"><Tag color={allReady ? 'green' : 'gold'}>{allReady ? '物流服务已就绪' : '部分能力待配置'}</Tag><Button ghost icon={<ReloadOutlined />} loading={loading} onClick={() => void load()}>刷新状态</Button></div></section>
    {!allReady && <Alert showIcon type="warning" message="外部物流凭据尚未完整配置" description="请由服务器运维配置供应商应用凭据和 HTTPS 回调地址。密钥不会显示或保存到商户端。" />}
    <section className="wechat-config-grid">
      <ProviderPanel title="顺丰同城" subtitle="同城配送下单与状态回调" ready={status.localDeliveryReady} checks={status.localDeliveryChecks}><Descriptions column={1} size="small"><Descriptions.Item label="店铺标识">{status.localDeliveryShopId || '未配置'}</Descriptions.Item></Descriptions><Space wrap><Button type="primary" onClick={() => onNavigate('deliveryPlans')}>配送方案</Button><Button onClick={() => onNavigate('freightRules')}>运费规则</Button></Space></ProviderPanel>
      <ProviderPanel title="快递100" subtitle="快递公司配置与物流轨迹回调" ready={status.expressReady} checks={status.expressChecks}><Space wrap><Button type="primary" onClick={() => onNavigate('expressRules')}>快递规则</Button><Button onClick={() => onNavigate('orders')}>订单发货</Button></Space></ProviderPanel>
    </section>
  </div>;
}

function ProviderPanel({ title, subtitle, ready, checks, children }: { title: string; subtitle: string; ready: boolean; checks: LogisticsStatus['localDeliveryChecks']; children: ReactNode }) {
  return <div className="wechat-config-panel"><div className="wechat-section-title"><div><strong>{title}</strong><span>{subtitle}</span></div><Tag color={ready ? 'green' : 'gold'}>{ready ? '已就绪' : '待配置'}</Tag></div><div className="wechat-check-list">{checks.map((check) => <div key={check.key}>{check.configured ? <CheckCircleFilled className="ok" /> : <WarningFilled className="warn" />}<span>{check.label}</span><Tag color={check.configured ? 'green' : 'gold'}>{check.configured ? '已配置' : '待配置'}</Tag></div>)}</div>{children}</div>;
}
