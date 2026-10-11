import {
  CheckCircleOutlined,
  CopyOutlined,
  EyeOutlined,
  ReloadOutlined,
  SearchOutlined,
  SettingOutlined,
  SyncOutlined,
} from '@ant-design/icons';
import { Button, Input, Modal, Select, Space, Tag, message } from 'antd';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Merchant } from './workspace-model';

type Request = <T>(path: string, init?: RequestInit) => Promise<T>;

type WechatStatus = {
  merchantId: string;
  merchantName: string;
  merchantLegalName: string;
  servicePhone: string;
  onboardingStatus?: string;
  syncStatus?: string;
  publicationEntitlementStatus: string;
  authorizerAppId: string;
  authorizationStatus: string | null;
  authorizedAt: string | null;
  componentReady: boolean;
  configuredCount: number;
  totalCount: number;
  checks?: Array<{ key: string; label: string; configured: boolean }>;
  requirements?: Array<{ key: string; label: string; configured: boolean }>;
  steps?: Array<{ key: string; label: string; state: 'complete' | 'current' | 'pending' }>;
  actions?: { canStartAuthorization: boolean; canManageFiling: boolean; canUploadMaterials: boolean };
};

type StatusRow = Merchant & { wechat: WechatStatus | null; loading?: boolean };

const EMPTY_STATUS: WechatStatus = {
  merchantId: '', merchantName: '', merchantLegalName: '', servicePhone: '', onboardingStatus: 'ACTION_REQUIRED',
  publicationEntitlementStatus: 'NONE', authorizerAppId: '', authorizationStatus: null, authorizedAt: null,
  componentReady: false, configuredCount: 0, totalCount: 0,
};

const processItems = [
  { key: 'basic', label: '基础信息' },
  { key: 'category', label: '类目设置' },
  { key: 'auth', label: '微信认证' },
  { key: 'filing', label: '备案状态' },
  { key: 'code', label: '代码配置' },
];

function maskPhone(phone: string) {
  if (!phone) return '-';
  if (phone.length < 8) return phone;
  return `${phone.slice(0, 3)}********${phone.slice(-4)}`;
}

function isAuthorized(status: WechatStatus | null) {
  return Boolean(status?.authorizerAppId && status.authorizationStatus !== 'REVOKED');
}

function stateFor(status: WechatStatus | null, key: string) {
  if (!status) return { label: '未同步', tone: 'default' as const };
  const requirement = status.requirements?.find((item) => item.key === ({ basic: 'subject', category: 'qualification', auth: 'wechatCertification', filing: 'filing' } as Record<string, string>)[key]);
  if (key === 'code') return status.publicationEntitlementStatus === 'CONSUMED' ? { label: '已完成', tone: 'success' as const } : { label: status.componentReady ? '未开始' : '未同步', tone: 'default' as const };
  if (key === 'auth') return isAuthorized(status) ? { label: '已完成', tone: 'success' as const } : { label: '未开始', tone: 'default' as const };
  if (!requirement) return { label: '未开始', tone: 'default' as const };
  return requirement.configured ? { label: '已完成', tone: 'success' as const } : { label: '未开始', tone: 'default' as const };
}

function StatusTag({ status, compact = false }: { status: { label: string; tone: 'success' | 'default' }; compact?: boolean }) {
  return <Tag className={compact ? 'platform-wechat-status-tag compact' : 'platform-wechat-status-tag'} color={status.tone === 'success' ? 'success' : 'default'}>{status.label}</Tag>;
}

export default function PlatformWechatPage({ request, onRequireStepUp }: { request: Request; onRequireStepUp: () => void }) {
  const [rows, setRows] = useState<StatusRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState({ merchantNo: '', merchantId: '', appId: '', subject: '' });
  const [appliedQuery, setAppliedQuery] = useState(query);
  const [authorizedOnly, setAuthorizedOnly] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [configOpen, setConfigOpen] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [syncingAll, setSyncingAll] = useState(false);
  const [templateOptions, setTemplateOptions] = useState<Array<{ value: number; label: string }>>([]);
  const [selectedTemplateId, setSelectedTemplateId] = useState<number | undefined>(undefined);
  const [templatesLoading, setTemplatesLoading] = useState(false);
  // AppID 明文：平台管理员与代理商（AGENCY_ADMIN）可查看；接口已放行无需 StepUp（原 StepUpAuthGuard 已移除）
  const [plainAppIds, setPlainAppIds] = useState<Record<string, string>>({});
  const [plainLoadingId, setPlainLoadingId] = useState<string | null>(null);

  const loadPlainAppId = useCallback(async (merchantId: string) => {
    setPlainLoadingId(merchantId);
    try {
      const result = await request<{ appid: string }>(`/wechat-platform/appid?merchantId=${merchantId}`, { headers: { 'X-Silent-Errors': '1' } });
      setPlainAppIds((prev) => ({ ...prev, [merchantId]: result?.appid || '' }));
    } catch (error) {
      const text = (error as Error).message;
      if (text.includes('身份') || text.includes('密码')) onRequireStepUp();
      else message.error(text);
    } finally {
      setPlainLoadingId(null);
    }
  }, [request, onRequireStepUp]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const merchants = await request<Merchant[]>('/merchants');
      const nextRows = await Promise.all(merchants.map(async (merchant) => {
        try {
          const wechat = await request<WechatStatus>(`/wechat-platform/status?merchantId=${merchant.id}`);
          return { ...merchant, wechat };
        } catch {
          return { ...merchant, wechat: null };
        }
      }));
      setRows(nextRows);
      setSelectedId((current) => current && nextRows.some((row) => row.id === current) ? current : null);
    } catch (error) {
      message.error((error as Error).message);
    } finally {
      setLoading(false);
    }
  }, [request]);

  /** 加载模板库模板列表（用于选择同步版本 / 回退） */
  const loadTemplates = useCallback(async () => {
    setTemplatesLoading(true);
    try {
      const result = await request<{ items: Array<{ templateId: number; userVersion: string; userDesc: string; createTime: number }> }>('/wechat-platform/templates');
      const items = result?.items || [];
      setTemplateOptions(items.map((item) => ({
        value: item.templateId,
        label: `版本 ${item.userVersion} · 模板#${item.templateId}${item.userDesc ? `（${item.userDesc.slice(0, 24)}）` : ''}`,
      })));
      // 默认选中最新模板
      if (items.length) setSelectedTemplateId((current) => current ?? items[0].templateId);
    } catch (error) {
      message.error((error as Error).message);
    } finally {
      setTemplatesLoading(false);
    }
  }, [request]);

  useEffect(() => { void loadTemplates(); }, [loadTemplates]);

  /** 一键同步：把所选模板版本同步到所有已授权商家并设为体验版（可回退到旧版本） */
  const syncAll = useCallback(async () => {
    if (!selectedTemplateId) { message.warning('请先选择要同步的模板版本'); return; }
    setSyncingAll(true);
    try {
      const result = await request<{ total: number; userVersion: string; results: Array<{ merchantId: string; appId: string; status: string; version?: string; message?: string }> }>('/wechat-platform/sync-all', { method: 'POST', body: JSON.stringify({ templateId: selectedTemplateId }) });
      const okCount = result.results.filter((item) => item.status === 'ok').length;
      const failed = result.results.filter((item) => item.status === 'error');
      if (failed.length) {
        Modal.warning({ title: `同步完成：成功 ${okCount}/${result.total}`, width: 520, content: <pre style={{ whiteSpace: 'pre-wrap', maxHeight: 320, overflowY: 'auto' }}>{failed.map((item) => `${item.appId}: ${item.message}`).join('\n')}</pre> });
      } else {
        message.success(`全部 ${result.total} 个商家已同步到模板版本 ${result.userVersion}`);
      }
      void load();
    } catch (error) {
      message.error((error as Error).message);
    } finally {
      setSyncingAll(false);
    }
  }, [request, load, selectedTemplateId]);

  useEffect(() => { void load(); }, [load]);

  const filteredRows = useMemo(() => rows.filter((row) => {
    const status = row.wechat;
    const matches = !appliedQuery.merchantNo || row.servicePhone.includes(appliedQuery.merchantNo);
    const idMatches = !appliedQuery.merchantId || row.id.toLowerCase().includes(appliedQuery.merchantId.toLowerCase());
    const appMatches = !appliedQuery.appId || (status?.authorizerAppId || '').toLowerCase().includes(appliedQuery.appId.toLowerCase());
    const subjectMatches = !appliedQuery.subject || `${row.brandName} ${row.legalName}`.toLowerCase().includes(appliedQuery.subject.toLowerCase());
    return matches && idMatches && appMatches && subjectMatches && (!authorizedOnly || isAuthorized(status));
  }), [appliedQuery, authorizedOnly, rows]);

  const selectedRow = rows.find((row) => row.id === selectedId) || null;

  function applySearch() { setAppliedQuery(query); }
  function resetSearch() {
    const empty = { merchantNo: '', merchantId: '', appId: '', subject: '' };
    setQuery(empty); setAppliedQuery(empty); setAuthorizedOnly(false);
  }

  async function syncRow(row: StatusRow) {
    setBusyId(row.id);
    try {
      const wechat = await request<WechatStatus>(`/wechat-platform/status?merchantId=${row.id}`);
      setRows((current) => current.map((item) => item.id === row.id ? { ...item, wechat } : item));
      message.success(`${row.brandName} 的小程序状态已同步`);
    } catch (error) {
      message.error((error as Error).message);
    } finally {
      setBusyId(null);
    }
  }

  function showDetail(row: StatusRow, section: 'overview' | 'config' = 'overview') {
    setSelectedId(row.id);
    if (section === 'config') setConfigOpen(true);
  }

  const selectedStatus = selectedRow?.wechat || EMPTY_STATUS;
  const requirementCount = selectedStatus.totalCount ? `${selectedStatus.configuredCount}/${selectedStatus.totalCount}` : '待同步';

  return <div className="platform-wechat-page">
    <section className="platform-wechat-toolbar">
      <div className="platform-wechat-search-grid">
        <Input value={query.merchantNo} onChange={(event) => setQuery((value) => ({ ...value, merchantNo: event.target.value }))} placeholder="按商户号搜索" />
        <Input value={query.merchantId} onChange={(event) => setQuery((value) => ({ ...value, merchantId: event.target.value }))} placeholder="按商户ID搜索" />
        <Input value={query.appId} onChange={(event) => setQuery((value) => ({ ...value, appId: event.target.value }))} placeholder="按授权APPID搜索" />
        <Input value={query.subject} onChange={(event) => setQuery((value) => ({ ...value, subject: event.target.value }))} placeholder="按主体名称搜索" />
        <Button icon={<ReloadOutlined />} onClick={resetSearch}>重置</Button>
        <Button type="primary" icon={<SearchOutlined />} onClick={applySearch}>搜索</Button>
      </div>
      <div className="platform-wechat-toolbar-actions">
        <Select
          value={selectedTemplateId}
          placeholder="选择模板版本"
          style={{ width: 240 }}
          loading={templatesLoading}
          options={templateOptions}
          onChange={(value) => setSelectedTemplateId(value)}
          allowClear
        />
        <Button type="primary" icon={<SyncOutlined />} loading={syncingAll} onClick={() => void syncAll()}>同步到所选版本</Button>
        <Button type={authorizedOnly ? 'primary' : 'default'} onClick={() => setAuthorizedOnly((value) => !value)}>已有小程序授权</Button>
        <Button aria-label="刷新小程序状态" icon={<ReloadOutlined />} loading={loading} onClick={() => void load()} />
      </div>
    </section>

    <section className="platform-wechat-table-panel">
      <div className="platform-wechat-table-scroll">
        <table className="platform-wechat-table">
          <thead><tr><th>商户ID</th><th>商户号</th><th>主体名称</th><th>授权APPID</th><th>流程快照</th><th>操作</th></tr></thead>
          <tbody>
            {filteredRows.map((row) => <tr key={row.id} className={selectedId === row.id ? 'selected' : undefined}>
              <td><span className="platform-wechat-id">{row.id}</span></td>
              <td>{maskPhone(row.servicePhone)}</td>
              <td><strong>{row.brandName}</strong><small>{row.legalName}</small></td>
              <td>{row.wechat?.authorizerAppId ? (
                <Space wrap>
                  <span>{plainAppIds[row.id] || row.wechat.authorizerAppId}</span>
                  {!plainAppIds[row.id] && (
                    <Button type="link" size="small" loading={plainLoadingId === row.id} onClick={() => void loadPlainAppId(row.id)}>查看明文</Button>
                  )}
                </Space>
              ) : <span className="platform-wechat-pending">- [待授权]</span>}</td>
              <td><div className="platform-wechat-flow-tags">{processItems.map((item) => <span key={item.key} className="platform-wechat-flow-item"><a href="#wechat-detail" onClick={(event) => { event.preventDefault(); showDetail(row); }}>{item.label}</a><StatusTag compact status={stateFor(row.wechat, item.key)} /></span>)}</div></td>
              <td><Space size={4} wrap><Button type="link" size="small" icon={<EyeOutlined />} onClick={() => showDetail(row)}>详情</Button><Button type="link" size="small" icon={<SettingOutlined />} onClick={() => showDetail(row, 'config')}>配置</Button><Button type="link" size="small" icon={<ReloadOutlined />} loading={busyId === row.id} onClick={() => void syncRow(row)}>同步状态</Button></Space></td>
            </tr>)}
            {!loading && !filteredRows.length && <tr><td colSpan={6} className="platform-wechat-empty">暂无匹配的小程序商户</td></tr>}
          </tbody>
        </table>
      </div>
      <footer className="platform-wechat-table-footer">共 {filteredRows.length} 个商户 <span>授权状态由微信开放平台回调实时更新</span></footer>
    </section>

    {selectedRow && <section id="wechat-detail" className="platform-wechat-detail">
      <div className="platform-wechat-detail-heading"><div><span className="platform-wechat-eyebrow">小程序授权详情</span><h2>{selectedRow.brandName}</h2><p>{selectedRow.legalName} · {selectedRow.id}</p></div><Space><Button onClick={() => setSelectedId(null)}>收起</Button></Space></div>
      <div className="platform-wechat-detail-grid"><div><span>商户ID</span><strong>{selectedRow.id}</strong></div><div><span>商户号</span><strong>{maskPhone(selectedRow.servicePhone)}</strong></div><div><span>授权 APPID</span><Space wrap><strong>{plainAppIds[selectedRow.id] || selectedStatus.authorizerAppId || '待授权后同步'}</strong>{!plainAppIds[selectedRow.id] && selectedStatus.authorizerAppId && <Button type="link" size="small" loading={plainLoadingId === selectedRow.id} onClick={() => void loadPlainAppId(selectedRow.id)}>查看明文</Button>}</Space></div><div><span>当前配置</span><strong>{requirementCount}</strong></div></div>
      <div className="platform-wechat-detail-section"><div className="platform-wechat-section-title"><strong>发布步骤</strong><span>点击步骤可快速定位待办</span></div><div className="platform-wechat-steps">{(selectedStatus.steps?.length ? selectedStatus.steps : processItems.map((item, index) => ({ key: item.key, label: item.label, state: index < 2 ? 'complete' as const : index === 2 ? 'current' as const : 'pending' as const }))).map((step, index) => <div key={step.key} className={`platform-wechat-step ${step.state}`}><span>{step.state === 'complete' ? <CheckCircleOutlined /> : index + 1}</span><strong>{step.label}</strong><small>{step.state === 'complete' ? '已完成' : step.state === 'current' ? '进行中' : '未开始'}</small></div>)}</div></div>
      <div className="platform-wechat-detail-section"><div className="platform-wechat-section-title"><strong>流程状态</strong><span>最近同步：{selectedStatus.authorizedAt ? String(selectedStatus.authorizedAt).slice(0, 16).replace('T', ' ') : '尚未授权'}</span></div><div className="platform-wechat-process-grid">{processItems.map((item) => <div key={item.key}><span>{item.label}</span><StatusTag status={stateFor(selectedRow.wechat, item.key)} /></div>)}</div></div>
    </section>}

    <Modal title="微信小程序配置" open={configOpen} width={720} onCancel={() => setConfigOpen(false)} footer={<Button type="primary" onClick={() => setConfigOpen(false)}>关闭</Button>}>
      <div className="platform-wechat-config-form"><label>第三方平台 AppID<Input value={selectedStatus.authorizerAppId || '待授权后同步'} readOnly suffix={<CopyOutlined />} /></label><label>授权回调地址<Input value="/api/wechat/authorization/callback" readOnly /></label><label>消息事件回调<Input value="/api/wechat/$APPID$/callback" readOnly /></label><label>小程序服务器域名<Input value="https://api.example.com" readOnly /></label></div>
      <p className="platform-wechat-modal-hint">第三方平台密钥、Token 和消息加密 Key 由服务端环境变量统一托管，管理端只展示脱敏信息和回调地址，避免敏感配置进入浏览器。</p>
    </Modal>
  </div>;
}
