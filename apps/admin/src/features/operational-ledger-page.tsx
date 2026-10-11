import { EditOutlined, PlusOutlined, ReloadOutlined, SearchOutlined } from '@ant-design/icons';
import { Button, Form, Input, InputNumber, Modal, Select, Space, Statistic, Table, Tag, message } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import dayjs from 'dayjs';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { money } from './workspace-model';

type Request = <T>(path: string, init?: RequestInit) => Promise<T>;
type LedgerEntry = { id: string; category: string; referenceNo: string; subjectName: string; amountFen: number; status: string; occurredAt: string; note: string; updatedAt: string };
const PAGE_CONFIG: Record<string, { category: string; title: string; singular: string; subject: string; statuses: Array<{ value: string; label: string }> }> = {
  memberRecharge: { category: 'MEMBER_RECHARGE', title: '会员储值记录', singular: '储值记录', subject: '会员', statuses: [{ value: 'PENDING', label: '待入账' }, { value: 'COMPLETED', label: '已入账' }, { value: 'REFUNDED', label: '已退款' }] },
  commissions: { category: 'DISTRIBUTION_COMMISSION', title: '分销佣金明细', singular: '佣金记录', subject: '一级分销员', statuses: [{ value: 'PENDING', label: '待结算' }, { value: 'SETTLED', label: '已结算' }] },
  withdrawals: { category: 'DISTRIBUTION_WITHDRAWAL', title: '提现申请', singular: '提现申请', subject: '一级分销员', statuses: [{ value: 'PENDING', label: '待审核' }, { value: 'APPROVED', label: '已通过' }, { value: 'REJECTED', label: '已拒绝' }] },
  financeCommissionWithdrawals: { category: 'DISTRIBUTION_WITHDRAWAL', title: '佣金提现', singular: '提现申请', subject: '提现用户', statuses: [{ value: 'PENDING', label: '待审核' }, { value: 'APPROVED', label: '打款成功' }, { value: 'REJECTED', label: '审核拒绝' }] },
};

export default function OperationalLedgerPage({ page, merchantId, request }: { page: string; merchantId: string; request: Request }) {
  const config = PAGE_CONFIG[page];
  const [rows, setRows] = useState<LedgerEntry[]>([]);
  const [keyword, setKeyword] = useState('');
  const [status, setStatus] = useState('ALL');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState<LedgerEntry | null>(null);
  const [open, setOpen] = useState(false);
  const [form] = Form.useForm();
  const load = useCallback(async () => {
    setLoading(true);
    try { const result = await request<LedgerEntry[]>(`/merchant-operations/${merchantId}/ledger/${config.category}`); setRows(Array.isArray(result) ? result : []); }
    catch (error) { message.error((error as Error).message); }
    finally { setLoading(false); }
  }, [config.category, merchantId, request]);
  useEffect(() => { void load(); }, [load]);
  const filtered = useMemo(() => rows.filter((row) => (!keyword.trim() || `${row.referenceNo} ${row.subjectName} ${row.note}`.toLowerCase().includes(keyword.trim().toLowerCase())) && (status === 'ALL' || row.status === status)), [keyword, rows, status]);

  function edit(row?: LedgerEntry) {
    const next = row || null; setEditing(next); form.resetFields();
    form.setFieldsValue(next ? { ...next, amountYuan: next.amountFen / 100, occurredAt: dayjs(next.occurredAt).format('YYYY-MM-DDTHH:mm') } : { status: 'PENDING', amountYuan: 0, occurredAt: dayjs().format('YYYY-MM-DDTHH:mm') });
    setOpen(true);
  }
  async function save(values: Record<string, unknown>) {
    setSaving(true);
    try {
      await request(`/merchant-operations/${merchantId}/ledger`, { method: 'POST', body: JSON.stringify({ ...(editing ? { id: editing.id } : {}), category: config.category, subjectName: values.subjectName, amountFen: Math.round(Number(values.amountYuan || 0) * 100), status: values.status, occurredAt: new Date(String(values.occurredAt)).toISOString(), note: values.note || '', metadata: {} }) });
      message.success(editing ? '台账记录已更新' : `${config.singular}已创建`); setOpen(false); setEditing(null); await load();
    } catch (error) { message.error((error as Error).message); }
    finally { setSaving(false); }
  }

  const completedStatuses = new Set(config.statuses.filter((item) => item.value !== 'PENDING').map((item) => item.value));
  const settledAmount = rows.filter((row) => completedStatuses.has(row.status) && row.status !== 'REJECTED' && row.status !== 'REFUNDED').reduce((sum, row) => sum + row.amountFen, 0);
  const columns: ColumnsType<LedgerEntry> = [
    { title: '业务编号', dataIndex: 'referenceNo', width: 190 },
    { title: config.subject, dataIndex: 'subjectName', width: 180 },
    { title: '金额', dataIndex: 'amountFen', width: 120, align: 'right', render: (value: number) => <strong>{money(value)}</strong> },
    { title: '业务时间', dataIndex: 'occurredAt', width: 165, render: (value: string) => dayjs(value).format('YYYY-MM-DD HH:mm') },
    { title: '状态', dataIndex: 'status', width: 110, render: (value: string) => <Tag color={value === 'PENDING' ? 'gold' : ['REJECTED', 'REFUNDED'].includes(value) ? 'red' : 'green'}>{config.statuses.find((item) => item.value === value)?.label || value}</Tag> },
    { title: '备注', dataIndex: 'note', ellipsis: true, render: (value: string) => value || '-' },
    { title: '操作', fixed: 'right', width: 90, render: (_, row) => row.status === 'PENDING' ? <Button type="link" icon={<EditOutlined />} onClick={() => edit(row)}>处理</Button> : <span className="table-muted">已完成</span> },
  ];
  return <div className="merchant-operation-page operational-ledger-page">
    <section className="operation-filter"><Input allowClear prefix={<SearchOutlined />} placeholder={`搜索${config.title}`} value={keyword} onChange={(event) => setKeyword(event.target.value)} /><Select value={status} onChange={setStatus} options={[{ value: 'ALL', label: '全部状态' }, ...config.statuses]} /><Button icon={<ReloadOutlined />} loading={loading} onClick={() => void load()}>刷新</Button><Button type="primary" icon={<PlusOutlined />} onClick={() => edit()}>新增{config.singular}</Button></section>
    <div className="operation-metrics"><div className="operation-metric blue"><Statistic title="记录总数" value={rows.length} /></div><div className="operation-metric orange"><Statistic title="待处理" value={rows.filter((row) => row.status === 'PENDING').length} /></div><div className="operation-metric green"><Statistic title="已处理" value={rows.filter((row) => row.status !== 'PENDING').length} /></div><div className="operation-metric purple"><Statistic title="有效金额" value={money(settledAmount)} /></div></div>
    <section className="operation-table"><div className="operation-table-heading"><div><strong>{config.title}</strong><span>共 {filtered.length} 条</span></div><Tag color="blue">独立业务台账</Tag></div><Table rowKey="id" loading={loading} columns={columns} dataSource={filtered} pagination={{ pageSize: 12, showSizeChanger: false }} scroll={{ x: 980 }} /></section>
    <Modal open={open} title={`${editing ? '处理' : '新增'}${config.singular}`} confirmLoading={saving} onCancel={() => { if (!saving) setOpen(false); }} onOk={() => form.submit()} destroyOnHidden><Form form={form} layout="vertical" onFinish={(values) => void save(values)}><Form.Item name="subjectName" label={config.subject} rules={[{ required: true }]}><Input maxLength={100} /></Form.Item><Space className="form-row"><Form.Item name="amountYuan" label="金额（元）" rules={[{ required: true }]}><InputNumber min={0.01} precision={2} /></Form.Item><Form.Item name="status" label="状态" rules={[{ required: true }]}><Select options={config.statuses} /></Form.Item></Space><Form.Item name="occurredAt" label="业务时间" rules={[{ required: true }]}><Input type="datetime-local" /></Form.Item><Form.Item name="note" label="备注"><Input.TextArea rows={3} maxLength={500} /></Form.Item></Form></Modal>
  </div>;
}
