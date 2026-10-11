import { CheckOutlined, ReloadOutlined } from '@ant-design/icons';
import { Alert, Button, Input, InputNumber, Modal, Popconfirm, Select, Space, Tag, message } from 'antd';
import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import type { Role } from './workspace-model';
import {
  auditPayload, DEFAULT_AUDIT_ITEM, type AuditItemDraft, type MiniProgramRelease, releaseMeta, RELEASE_STATUS_META, type WechatPublishStatus,
} from './app-config-editor';

type Request = <T>(path: string, init?: RequestInit) => Promise<T>;

function Field({ label, children, block }: { label: string; children: ReactNode; block?: boolean }) {
  return (
    <div className={block ? 'wechat-pm-field wechat-pm-field--block' : 'wechat-pm-field'}>
      <label>{label}</label>
      <div>{children}</div>
    </div>
  );
}

/**
 * 代理商端发布管理：查看商家上传的代码状态，并负责 上传代码/体验版二维码/
 * 提交微信审核/查询审核结果/发布上线。商家端「同步小程序」只保留上传与体验版预览。
 */
export function PublishManagement({ merchantId, request, role }: { merchantId: string; request: Request; role?: Role }) {
  const [status, setStatus] = useState<WechatPublishStatus | null>(null);
  const [releases, setReleases] = useState<MiniProgramRelease[]>([]);
  const [versionInfo, setVersionInfo] = useState<{ wechat: { trial: { version: string; desc: string; updatedAt: string | null } | null; released: { version: string; desc: string; updatedAt: string | null } | null }; local: MiniProgramRelease | null; onlineConsistent: boolean; note: string } | null>(null);
  const [releaseLoadError, setReleaseLoadError] = useState('');
  const [versionInfoError, setVersionInfoError] = useState('');
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [templateId, setTemplateId] = useState<number | null>(null);
  // FIX(2026-08-10)：代理端批量同步模板版本选择（独立状态，与单家上传 templateId 互不影响）
  const [templates, setTemplates] = useState<Array<{ templateId: number; userVersion: string; createTime: number }>>([]);
  const [batchTemplateId, setBatchTemplateId] = useState<number | null>(null);
  const [templatesLoading, setTemplatesLoading] = useState(false);
  const [userVersion, setUserVersion] = useState(() => {
    const now = new Date();
    const pad = (v: number) => String(v).padStart(2, '0');
    return `${now.getFullYear()}.${pad(now.getMonth() + 1)}.${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
  });
  const [userDesc, setUserDesc] = useState('SaaS 小程序模板发布：读取商家装修配置动态渲染');
  const [auditItem, setAuditItem] = useState<AuditItemDraft>({ ...DEFAULT_AUDIT_ITEM });
  const [feedbackInfo, setFeedbackInfo] = useState('本版本为本地生活团购小程序，页面内容由商家在 SaaS 商户端配置，商品、门店、订单和券码均通过后端接口读取。');
  const [savedCategories, setSavedCategories] = useState<Array<{ firstId: number; firstClass: string; secondId: number; secondClass: string }>>([]);
  const [categoriesLoaded, setCategoriesLoaded] = useState(false);

  const latest = releases[0] || status?.latestRelease || null;
  const meta = releaseMeta(latest?.status);
  // 授权状态用 authorizationStatus 判断（authorizerAppId 对非平台角色脱敏隐藏，不能作为依据）
  const authorized = status?.authorizationStatus === 'AUTHORIZED';
  // 仅平台/代理商可执行发布操作（上传代码/生成二维码/提交审核/发布上线/回退），商家管理员只读查看状态与体验版二维码
  const isPlatform = role === 'PLATFORM_ADMIN' || role === 'AGENCY_ADMIN';

  const loadPublishState = useCallback(async () => {
    setLoading(true);
    try {
      const nextStatus = await request<WechatPublishStatus>(`/wechat-platform/status?merchantId=${merchantId}`);
      setStatus(nextStatus);
      try {
        const releasePage = await request<{ items: MiniProgramRelease[] }>(`/wechat-platform/releases?merchantId=${merchantId}`);
        if (!Array.isArray(releasePage.items)) throw new Error('发布记录接口返回格式异常');
        setReleases(releasePage.items);
        setReleaseLoadError('');
      } catch (error) {
        setReleaseLoadError((error as Error).message || '发布记录加载失败');
      }
      try {
        const versionData = await request<{ wechat: { trial: { version: string; desc: string; updatedAt: string | null } | null; released: { version: string; desc: string; updatedAt: string | null } | null }; local: MiniProgramRelease | null; onlineConsistent: boolean; note: string }>(`/wechat-platform/releases/version-info?merchantId=${merchantId}`);
        setVersionInfo(versionData);
        setVersionInfoError('');
      } catch (error) {
        setVersionInfoError((error as Error).message || '微信版本对账加载失败');
      }
    } catch (error) {
      message.error((error as Error).message);
    } finally {
      setLoading(false);
    }
  }, [merchantId, request]);

  const loadSavedCategories = useCallback(async () => {
    if (!status || status.authorizationStatus !== 'AUTHORIZED') { setCategoriesLoaded(true); return; }
    try {
      const items = await request<Array<{ firstId: number; firstClass: string; secondId: number; secondClass: string }>>(`/wechat-platform/categories/saved?merchantId=${merchantId}`);
      setSavedCategories(items || []);
      if (items?.length) {
        const first = items[0];
        setAuditItem((current) => ({
          ...current,
          firstClass: current.firstClass === DEFAULT_AUDIT_ITEM.firstClass ? first.firstClass : current.firstClass,
          secondClass: current.secondClass === DEFAULT_AUDIT_ITEM.secondClass ? first.secondClass : current.secondClass,
          firstId: current.firstId === DEFAULT_AUDIT_ITEM.firstId ? first.firstId : current.firstId,
          secondId: current.secondId === DEFAULT_AUDIT_ITEM.secondId ? first.secondId : current.secondId,
        }));
      }
    } catch {
      // 拉取失败不阻塞
    } finally {
      setCategoriesLoaded(true);
    }
  }, [merchantId, request, status?.authorizerAppId]);

  /** FIX(2026-08-10)：代理端批量同步模板列表（AGENCY_ADMIN 专用；平台端在"小程序模板"页已有同样入口） */
  const loadTemplates = useCallback(async () => {
    if (role !== 'AGENCY_ADMIN') return;
    setTemplatesLoading(true);
    try {
      const result = await request<{ items: Array<{ templateId: number; userVersion: string; createTime: number }> }>('/wechat-platform/templates');
      setTemplates((result.items || []).sort((a, b) => b.createTime - a.createTime));
    } catch {
      /* 模板列表加载失败不影响其他功能（批量同步仍可用服务端默认模板） */
    } finally {
      setTemplatesLoading(false);
    }
  }, [request, role]);

  useEffect(() => { void loadPublishState(); }, [loadPublishState]);
  useEffect(() => { void loadSavedCategories(); }, [loadSavedCategories]);
  useEffect(() => { void loadTemplates(); }, [loadTemplates]);

  // FIX(A)：审核中自动轮询——每 60s 静默查询一次审核结果，直到出终态（不再需要人工点「查询审核结果」）
  useEffect(() => {
    if (latest?.status !== 'AUDIT_SUBMITTED' || !latest?.auditId) return;
    const timer = setInterval(() => {
      void request<MiniProgramRelease>(`/wechat-platform/releases/query-audit?merchantId=${merchantId}`, {
        method: 'POST',
        body: JSON.stringify({ releaseId: latest.id }),
      }).then((result) => {
        setReleases((current) => [result, ...current.filter((item) => item.id !== result.id)]);
        if (result.status !== 'AUDIT_SUBMITTED') void loadPublishState();
      }).catch(() => { /* 静默，下一轮重试 */ });
    }, 60_000);
    return () => clearInterval(timer);
  }, [latest?.id, latest?.status, latest?.auditId, loadPublishState, merchantId, request]);

  async function runReleaseAction(label: string, action: () => Promise<MiniProgramRelease>) {
    setBusy(label);
    try {
      const result = await action();
      setReleases((current) => [result, ...current.filter((item) => item.id !== result.id)]);
      message.success(`${label}已完成`);
      await loadPublishState();
    } catch (error) {
      message.error((error as Error).message);
    } finally {
      setBusy(null);
    }
  }

  /** 回退线上版本：接口只返回成功消息（不产生 release 记录），单独处理 */
  async function revertRelease() {
    setBusy('回退线上版本');
    try {
      const result = await request<{ message: string }>(`/wechat-platform/releases/revert?merchantId=${merchantId}`, { method: 'POST' });
      message.success(result.message || '已回退线上版本');
      await loadPublishState();
    } catch (error) {
      message.error((error as Error).message);
    } finally {
      setBusy(null);
    }
  }

  /** 代理端批量同步：把所选模板版本上传到名下所有已授权商家（生成开发版/体验版）；审核与发布仍需逐商家操作（微信不支持批量） */
  async function doBatchSync() {
    setBusy('批量同步名下商家');
    try {
      const result = await request<{ total: number; userVersion: string; results: Array<{ merchantId: string; appId: string; status: string; message?: string }> }>('/wechat-platform/sync-all', { method: 'POST', body: JSON.stringify({ templateId: batchTemplateId || undefined }) });
      const failed = (result.results || []).filter((item) => item.status !== 'ok');
      message.success(failed.length ? `批量同步完成：成功 ${(result.results || []).length - failed.length}/${result.total}，失败 ${failed.length}（详见下方发布记录）` : `批量同步完成：${result.total} 家商家已上传模板 ${result.userVersion}`);
      await loadPublishState();
    } catch (error) {
      message.error((error as Error).message);
    } finally {
      setBusy(null);
    }
  }

  /** FIX(2026-08-10)：批量同步前校验——选中非最新模板时二次确认（防旧模板覆盖全部商家体验版） */
  function runBatchSync() {
    const latestTemplate = templates[0];
    if (batchTemplateId && latestTemplate && batchTemplateId !== latestTemplate.templateId) {
      const chosen = templates.find((item) => item.templateId === batchTemplateId);
      Modal.confirm({
        title: '确认使用旧模板同步？',
        content: `所选模板 #${batchTemplateId}（${chosen?.userVersion || ''}）不是最新模板（最新 #${latestTemplate.templateId} ${latestTemplate.userVersion}）。同步将把名下全部商家的体验版更新到该版本，确认继续？`,
        okText: '确认同步',
        okButtonProps: { danger: true },
        cancelText: '取消',
        onOk: () => { void doBatchSync(); },
      });
      return;
    }
    void doBatchSync();
  }

  const updateAuditItem = (patch: Partial<AuditItemDraft>) => setAuditItem((current) => ({ ...current, ...patch }));

  return (
    <div className="wechat-publish-panel">
      <Alert
        type={authorized ? 'success' : 'warning'}
        showIcon
        message={authorized ? '微信第三方平台发布链路已接入' : '该商户还没有完成小程序授权'}
        description={authorized
          ? '这里展示小程序模板发布状态与体验版二维码；上传模板代码、提交审核、发布上线由平台/代理商统一操作。'
          : '请先在「注册/授权」完成小程序授权，授权后由平台/代理商上传模板代码并发布体验版。'}
      />

      <div className="wechat-publish-grid">
        <section className="wechat-publish-card">
          <div className="app-config-block-title"><strong>当前发布版本</strong><span>平台/代理商最近一次上传的代码状态。</span></div>
          <div className="wechat-publish-status">
            <div>
              <span>版本状态</span>
              <strong><Tag color={meta.color}>{meta.label}</Tag>{latest?.userVersion || '尚未上传代码'}</strong>
            </div>
            <div>
              <span>授权 APPID</span>
              <strong>{role === 'PLATFORM_ADMIN' ? (status?.authorizerAppId || '待授权') : '仅平台可见'}</strong>
            </div>
            <div>
              <span>代码模板 ID</span>
              <strong>{latest?.templateId || '使用服务端默认配置'}</strong>
            </div>
            <div>
              <span>审核单号</span>
              <strong>{latest?.auditId || '-'}</strong>
            </div>
          </div>
          <div className="wechat-publish-steps">
            {['上传模板代码', '生成体验版二维码', '提交微信审核', '审核通过', '发布上线'].map((label, index) => (
              <div key={label} className={index <= meta.step ? 'done' : ''}><span>{index <= meta.step ? <CheckOutlined /> : index + 1}</span><b>{label}</b></div>
            ))}
          </div>
          {latest?.errorMessage && <Alert type="error" showIcon message="最近一次微信接口返回失败" description={latest.errorMessage} />}
          {latest?.trialQrUrl && <div className="wechat-publish-qrcode"><img src={latest.trialQrUrl} alt="小程序体验版二维码" /><span>微信扫码打开体验版（可发给商家预览）</span></div>}
          {versionInfoError && <Alert type="error" showIcon message="微信版本对账加载失败" description={versionInfo ? `当前保留上次成功对账结果：${versionInfoError}` : versionInfoError} />}
          {versionInfo && (versionInfo.note || versionInfo.wechat?.released || versionInfo.wechat?.trial) && (
            <Alert type={versionInfo.onlineConsistent ? 'success' : 'warning'} showIcon message="版本对账（微信侧实时）"
              description={`微信侧线上版本：${versionInfo.wechat?.released?.version || '暂无'}；体验版：${versionInfo.wechat?.trial?.version || '暂无'}${versionInfo.note ? `；${versionInfo.note}` : ''}`} />
          )}
        </section>

        {isPlatform && (
          <section className="wechat-publish-card">
            <div className="app-config-block-title"><strong>上传模板代码</strong><span>把平台的小程序模板提交到商户授权的小程序草稿箱。</span></div>
            <div className="app-config-field-grid">
              <Field label="微信代码模板 ID"><InputNumber min={1} precision={0} value={templateId} onChange={(value) => setTemplateId(typeof value === 'number' ? value : null)} placeholder="不填则用服务端环境变量" style={{ width: '100%' }} /></Field>
              <Field label="版本号"><Input value={userVersion} onChange={(event) => setUserVersion(event.target.value)} placeholder="例如 1.0.1" /></Field>
            </div>
            <Field label="版本说明" block><Input.TextArea rows={3} value={userDesc} onChange={(event) => setUserDesc(event.target.value)} /></Field>
            <Space wrap>
              <Button type="primary" disabled={!authorized} loading={busy === '上传模板代码'} onClick={() => void runReleaseAction('上传模板代码', () => request<MiniProgramRelease>(`/wechat-platform/releases/commit?merchantId=${merchantId}`, { method: 'POST', body: JSON.stringify({ templateId: templateId || undefined, userVersion, userDesc }) }))}>上传模板代码</Button>
              <Button disabled={!latest || latest.status === 'DRAFT' || latest.status === 'FAILED'} loading={busy === '生成体验版二维码'} onClick={() => void runReleaseAction('生成体验版二维码', () => request<MiniProgramRelease>(`/wechat-platform/releases/trial-qrcode?merchantId=${merchantId}`, { method: 'POST', body: JSON.stringify({ releaseId: latest?.id }) }))}>生成体验版二维码</Button>
              <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void loadPublishState()}>刷新发布状态</Button>
              {role === 'AGENCY_ADMIN' && <Select
                style={{ width: 230 }}
                value={batchTemplateId ?? undefined}
                placeholder="使用当前默认模板"
                loading={templatesLoading}
                allowClear
                options={templates.map((item) => ({ value: item.templateId, label: `#${item.templateId} · ${item.userVersion}` }))}
                onChange={(value) => setBatchTemplateId(typeof value === 'number' ? value : null)}
              />}
              {role === 'AGENCY_ADMIN' && <Button loading={busy === '批量同步名下商家'} onClick={() => void runBatchSync()}>批量同步名下商家</Button>}
            </Space>
          </section>
        )}
      </div>

      {isPlatform && (
        <section className="wechat-publish-card wechat-publish-card--wide">
          <div className="app-config-block-title"><strong>提交微信审核</strong><span>审核类目必须与微信小程序后台/第三方平台可选服务类目一致。</span></div>
        <div className="app-config-field-grid">
          <Field label="页面路径"><Input value={auditItem.address} onChange={(event) => updateAuditItem({ address: event.target.value })} /></Field>
          <Field label="页面标题"><Input value={auditItem.title} onChange={(event) => updateAuditItem({ title: event.target.value })} /></Field>
          <Field label="服务类目（已保存到微信）">
            {savedCategories.length ? (
              <Select
                placeholder="从已保存的服务类目中选择"
                value={`${auditItem.firstId}-${auditItem.secondId}`}
                onChange={(value) => {
                  const [firstId, secondId] = String(value).split('-').map(Number);
                  const found = savedCategories.find((item) => item.firstId === firstId && item.secondId === secondId);
                  updateAuditItem({
                    firstId, secondId,
                    firstClass: found?.firstClass || auditItem.firstClass,
                    secondClass: found?.secondClass || auditItem.secondClass,
                  });
                }}
                options={savedCategories.map((item) => ({ value: `${item.firstId}-${item.secondId}`, label: `${item.firstClass} / ${item.secondClass}` }))}
              />
            ) : categoriesLoaded ? (
              <Alert type="warning" showIcon message="该商家尚未把服务类目保存到微信，提交审核前请先在「类目设置」选择并保存。" />
            ) : (
              <span>加载中…</span>
            )}
          </Field>
          <Field label="一级类目名称"><Input value={auditItem.firstClass} onChange={(event) => updateAuditItem({ firstClass: event.target.value })} /></Field>
          <Field label="二级类目名称"><Input value={auditItem.secondClass} onChange={(event) => updateAuditItem({ secondClass: event.target.value })} /></Field>
          <Field label="一级类目 ID"><InputNumber min={1} precision={0} value={auditItem.firstId} onChange={(value) => updateAuditItem({ firstId: Number(value || DEFAULT_AUDIT_ITEM.firstId) })} style={{ width: '100%' }} /></Field>
          <Field label="二级类目 ID"><InputNumber min={1} precision={0} value={auditItem.secondId} onChange={(value) => updateAuditItem({ secondId: Number(value || DEFAULT_AUDIT_ITEM.secondId) })} style={{ width: '100%' }} /></Field>
          <Field label="标签"><Input value={auditItem.tag} onChange={(event) => updateAuditItem({ tag: event.target.value })} /></Field>
        </div>
        <Field label="审核说明" block><Input.TextArea rows={3} value={feedbackInfo} onChange={(event) => setFeedbackInfo(event.target.value)} /></Field>
        <Space wrap>
          <Button type="primary" disabled={!latest || !['COMMITTED', 'AUDIT_REJECTED'].includes(latest.status)} loading={busy === '提交微信审核'} onClick={() => void runReleaseAction('提交微信审核', () => request<MiniProgramRelease>(`/wechat-platform/releases/submit-audit?merchantId=${merchantId}`, { method: 'POST', body: JSON.stringify({ releaseId: latest?.id, itemList: [auditPayload(auditItem)], feedbackInfo }) }))}>提交微信审核</Button>
          <Button disabled={!latest?.auditId} loading={busy === '查询审核结果'} onClick={() => void runReleaseAction('查询审核结果', () => request<MiniProgramRelease>(`/wechat-platform/releases/query-audit?merchantId=${merchantId}`, { method: 'POST', body: JSON.stringify({ releaseId: latest?.id }) }))}>查询审核结果</Button>
          <Button danger type="primary" disabled={latest?.status !== 'AUDIT_APPROVED'} loading={busy === '发布上线'} onClick={() => void runReleaseAction('发布上线', () => request<MiniProgramRelease>(`/wechat-platform/releases/release?merchantId=${merchantId}`, { method: 'POST', body: JSON.stringify({ releaseId: latest?.id }) }))}>发布上线</Button>
          <Popconfirm
            title="确认回退线上版本？"
            description="回退后线上将回到上一个已发布版本，每次发布后有一次回退机会"
            okText="回退"
            cancelText="取消"
            onConfirm={() => void revertRelease()}
          >
            <Button danger disabled={latest?.status !== 'RELEASED'} loading={busy === '回退线上版本'}>回退线上版本</Button>
          </Popconfirm>
        </Space>
      </section>
      )}

      <section className="wechat-publish-card wechat-publish-card--wide">
        <div className="app-config-block-title"><strong>发布记录</strong><span>商家上传的代码与每次微信接口调用都会落库，便于追查。</span></div>
        {releaseLoadError && <Alert type="error" showIcon message="发布记录加载失败" description={releases.length ? `当前保留上次成功加载的发布记录：${releaseLoadError}` : releaseLoadError} action={<Button size="small" onClick={() => void loadPublishState()}>重试</Button>} />}
        <div className="wechat-publish-history">
          {releases.length ? releases.map((release) => {
            const releaseMetaItem = releaseMeta(release.status);
            return (
              <div className="wechat-publish-history-row" key={release.id}>
                <Tag color={releaseMetaItem.color}>{releaseMetaItem.label}</Tag>
                <strong>{release.userVersion}</strong>
                <span>{release.userDesc}</span>
                {release.auditId ? <span>审核单 {release.auditId}</span> : null}
                {release.errorMessage ? <span className="wechat-publish-error">{release.errorMessage}</span> : null}
              </div>
            );
          }) : (
            <div className="wechat-publish-empty">尚未上传小程序代码。请联系平台/代理商使用小程序模板统一发布。</div>
          )}
        </div>
      </section>
    </div>
  );
}
