import { CloudDownloadOutlined, ReloadOutlined, UploadOutlined } from '@ant-design/icons';
import { Alert, Button, Divider, Drawer, Empty, Input, Select, Space, Spin, Table, Tag, Typography, message } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RequestBody } from '../api-contract';
import { parseMerchantImportCsv, merchantImportTemplate, type MerchantImportItem } from './merchant-import-csv';
import type { Agency, MerchantImportOperation, MerchantImportOperationSummary, User } from './workspace-model';

type Request = <T>(path: string, init?: RequestInit) => Promise<T>;
type ImportResult = { externalRef?: unknown; ok?: unknown; merchantId?: unknown; brandName?: unknown; status?: unknown; error?: unknown };
type Props = { user: User; agencies: Agency[]; request: Request; onImported: () => void; onRequireStepUp: () => void };
type ImportPayload = RequestBody<'AppController_merchantBatchImport'>;

const terminalStatuses = new Set(['COMPLETED', 'PARTIAL', 'FAILED']);

function statusLabel(status: string) {
  return ({ PENDING: '排队中', PROCESSING: '处理中', COMPLETED: '已完成', PARTIAL: '部分完成', FAILED: '失败' } as Record<string, string>)[status] || status;
}

function statusColor(status: string) {
  return ({ PENDING: 'gold', PROCESSING: 'blue', COMPLETED: 'green', PARTIAL: 'orange', FAILED: 'red' } as Record<string, string>)[status] || 'default';
}

export default function MerchantImportPanel({ user, agencies, request, onImported, onRequireStepUp }: Props) {
  const allowFinancialTerms = user.role === 'PLATFORM_ADMIN';
  const [open, setOpen] = useState(false);
  const [agencyId, setAgencyId] = useState(user.agencyId || '');
  const [note, setNote] = useState('批量导入商家');
  const [csvText, setCsvText] = useState('');
  const [operation, setOperation] = useState<MerchantImportOperation | null>(null);
  const [history, setHistory] = useState<MerchantImportOperationSummary[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [operationLoading, setOperationLoading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const notifiedOperationRef = useRef<string | null>(null);
  const operationRequestRef = useRef(0);

  const refreshHistory = useCallback(async () => {
    setHistoryLoading(true);
    try { setHistory(await request<MerchantImportOperationSummary[]>('/merchant-import-operations')); }
    catch { /* request() already opens the operator issue panel. */ }
    finally { setHistoryLoading(false); }
  }, [request]);

  const loadOperation = useCallback(async (operationId: string) => {
    const requestId = ++operationRequestRef.current;
    setOperation(null);
    setOperationLoading(true);
    try {
      const detail = await request<MerchantImportOperation>(`/merchant-import-operations/${operationId}`);
      if (requestId === operationRequestRef.current) setOperation(detail);
    } catch { /* request() already opens the operator issue panel. */ }
    finally { if (requestId === operationRequestRef.current) setOperationLoading(false); }
  }, [request]);

  useEffect(() => {
    if (!open) return;
    if (user.role === 'AGENCY_ADMIN') setAgencyId(user.agencyId || '');
    else if (!agencyId) setAgencyId(agencies.find((agency) => agency.active)?.id || '');
    void refreshHistory();
  }, [agencies, agencyId, open, refreshHistory, user.agencyId, user.role]);

  useEffect(() => {
    if (!open || !operation || terminalStatuses.has(operation.status)) return undefined;
    let cancelled = false;
    const timer = window.setInterval(() => {
      void request<MerchantImportOperation>(`/merchant-import-operations/${operation.id}`).then((next) => {
        if (cancelled) return;
        setOperation(next);
        if (terminalStatuses.has(next.status)) {
          if (next.succeededCount > 0 && notifiedOperationRef.current !== next.id) {
            notifiedOperationRef.current = next.id;
            onImported();
          }
          void refreshHistory();
        }
      }).catch(() => undefined);
    }, 1500);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [onImported, open, operation, refreshHistory, request]);

  const parsed = useMemo(() => {
    if (!csvText.trim()) return { items: [] as MerchantImportItem[], error: '' };
    try { return { items: parseMerchantImportCsv(csvText, allowFinancialTerms), error: '' }; }
    catch (error) { return { items: [] as MerchantImportItem[], error: (error as Error).message }; }
  }, [allowFinancialTerms, csvText]);

  function close() { if (!submitting) setOpen(false); }
  function downloadTemplate() {
    const blob = new Blob([merchantImportTemplate(allowFinancialTerms)], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url; anchor.download = allowFinancialTerms ? 'merchant-import-platform.csv' : 'merchant-import-agency.csv'; anchor.click();
    URL.revokeObjectURL(url);
  }
  function readFile(file: File | undefined) {
    if (!file) return;
    if (file.size > 262_144) { message.error('CSV 文件不能超过 256 KB'); return; }
    void file.text().then(setCsvText).catch(() => message.error('无法读取 CSV 文件'));
  }
  async function submit() {
    if (!agencyId) { message.warning('请选择归属代理商'); return; }
    if (!parsed.items.length || parsed.error) { message.warning(parsed.error || '请先粘贴或上传有效 CSV'); return; }
    const payload: ImportPayload = { note: note.trim(), items: parsed.items };
    if (payload.note.length < 3) { message.warning('导入说明至少 3 个字符'); return; }
    setSubmitting(true);
    try {
      const created = await request<MerchantImportOperation>(`/agencies/${agencyId}/merchants/batch-import`, {
        method: 'POST', headers: { 'Idempotency-Key': crypto.randomUUID().replaceAll('-', '') }, body: JSON.stringify(payload),
      });
      operationRequestRef.current += 1; setOperationLoading(false); setOperation(created); setCsvText(''); await refreshHistory(); message.success(`导入任务已创建：${created.id}`);
    } catch (error) {
      const text = (error as Error).message;
      if (text.includes('身份') || text.includes('密码')) onRequireStepUp();
      message.error(text);
    } finally { setSubmitting(false); }
  }

  const resultColumns: ColumnsType<ImportResult> = [
    { title: '行标识', dataIndex: 'externalRef', width: 150 },
    { title: '结果', dataIndex: 'ok', width: 90, render: (ok) => <Tag color={ok ? 'green' : 'red'}>{ok ? '成功' : '失败'}</Tag> },
    { title: '商家', dataIndex: 'brandName', render: (value, record) => record.ok ? <Typography.Text>{String(value || '-')}</Typography.Text> : <Typography.Text type="danger">{String(record.error || '导入失败')}</Typography.Text> },
  ];
  const historyColumns: ColumnsType<MerchantImportOperationSummary> = [
    { title: '任务', dataIndex: 'id', ellipsis: true },
    { title: '状态', dataIndex: 'status', width: 100, render: (value) => <Tag color={statusColor(String(value))}>{statusLabel(String(value))}</Tag> },
    { title: '进度', width: 90, render: (_, record) => `${record.succeededCount}/${record.totalCount}` },
    { title: '创建时间', dataIndex: 'createdAt', width: 165, render: (value) => new Date(String(value)).toLocaleString('zh-CN', { hour12: false }) },
  ];
  const activeAgency = agencies.find((agency) => agency.id === agencyId);
  return <>
    <Button icon={<UploadOutlined />} onClick={() => setOpen(true)}>批量导入</Button>
    <Drawer title="批量导入商家" open={open} onClose={close} width="min(840px, 100vw)" destroyOnClose={false}>
      <Space direction="vertical" size="large" style={{ width: '100%' }}>
        {user.role === 'PLATFORM_ADMIN' ? <Select aria-label="导入归属代理商" placeholder="选择归属代理商" value={agencyId || undefined} onChange={setAgencyId} options={agencies.filter((agency) => agency.active).map((agency) => ({ value: agency.id, label: agency.name }))} style={{ width: '100%' }} /> : <Alert type="info" showIcon message={`导入至当前代理商：${activeAgency?.name || '当前代理商'}`} />}
        <Typography.Text type="secondary">仅导入主体、品牌和服务电话，不创建管理员账号；任务完成后请在开户与授权中补齐管理员邀请。</Typography.Text>
        <Space wrap>
          <Button icon={<CloudDownloadOutlined />} onClick={downloadTemplate}>下载 CSV 模板</Button>
          <Button onClick={() => fileInputRef.current?.click()}>选择 CSV 文件</Button>
          <input ref={fileInputRef} hidden type="file" accept=".csv,text/csv" onChange={(event) => { readFile(event.target.files?.[0]); event.currentTarget.value = ''; }} />
        </Space>
        <Input.TextArea aria-label="商家 CSV 内容" value={csvText} onChange={(event) => setCsvText(event.target.value)} rows={9} maxLength={262144} showCount placeholder="粘贴 CSV 内容，首行为 externalRef,legalName,brandName,servicePhone" />
        {parsed.error ? <Alert type="error" showIcon message={parsed.error} /> : parsed.items.length > 0 ? <Alert type="success" showIcon message={`已解析 ${parsed.items.length} 家商家，可提交`} /> : null}
        <Input aria-label="导入说明" value={note} onChange={(event) => setNote(event.target.value)} maxLength={500} placeholder="导入说明" />
        <Space>
          <Button type="primary" loading={submitting} disabled={!parsed.items.length || !!parsed.error || !agencyId} onClick={() => void submit()}>提交导入任务</Button>
          <Button onClick={() => { operationRequestRef.current += 1; setOperationLoading(false); setCsvText(''); setOperation(null); }}>清空</Button>
        </Space>
        {operationLoading ? <Spin /> : null}
        {operation && <><Divider orientation="left">当前任务</Divider><Space direction="vertical" size={4}><Typography.Text copyable={{ text: operation.id }}>任务编号：{operation.id}</Typography.Text><Typography.Text>状态：<Tag color={statusColor(operation.status)}>{statusLabel(operation.status)}</Tag> 已成功 {operation.succeededCount} 家，失败 {operation.failedCount} 家</Typography.Text>{operation.error && <Typography.Text type="danger">{operation.error}</Typography.Text>}</Space>{operation.results?.length ? <Table<ImportResult> rowKey={(record) => String(record.externalRef)} size="small" pagination={false} columns={resultColumns} dataSource={operation.results as ImportResult[]} scroll={{ x: 560 }} /> : null}</>}
        <Divider orientation="left">最近任务</Divider>
        {history.length ? <Table<MerchantImportOperationSummary> loading={historyLoading} rowKey="id" size="small" pagination={{ pageSize: 5, hideOnSinglePage: true }} columns={historyColumns} dataSource={history} onRow={(record) => ({ onClick: () => void loadOperation(record.id), style: { cursor: 'pointer' } })} scroll={{ x: 540 }} /> : historyLoading ? <Spin /> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无导入任务" />}
        <Button icon={<ReloadOutlined />} loading={historyLoading} onClick={() => void refreshHistory()}>刷新任务列表</Button>
      </Space>
    </Drawer>
  </>;
}
