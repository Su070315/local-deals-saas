import { DownloadOutlined, ReloadOutlined, SearchOutlined } from '@ant-design/icons';
import { Button, Empty, Input, Segmented, Select, Space, Table, Tag, message } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import dayjs from 'dayjs';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { money } from './workspace-model';

type Request = <T>(path: string, init?: RequestInit) => Promise<T>;
type FlowPage = 'paymentTransactions' | 'refundTransactions';
type PaymentRow = { id: string; orderId: string; orderNo: string; provider: string; eventType: string; amountFen: number; occurredAt: string; receivedAt: string; status: string; processingNote: string };
type RefundRow = { id: string; orderId: string; orderNo: string; voucherId: string; amountFen: number; reason: string; status: string; lastAttemptAt: string | null; attemptCount: number; createdAt: string; ticketId?: string | null; ticketPreview?: string | null; voucherStatus?: string | null; orderStatus?: string | null };
type PageResult<T> = { items: T[]; page: number; pageSize: number; total: number };

export default function MerchantFinanceFlowPage({ page, merchantId, request }: { page: FlowPage; merchantId: string; request: Request }) {
  const payment = page === 'paymentTransactions';
  const [rows, setRows] = useState<Array<PaymentRow | RefundRow>>([]);
  const [loading, setLoading] = useState(false);
  const [keyword, setKeyword] = useState('');
  const [submittedKeyword, setSubmittedKeyword] = useState('');
  const [status, setStatus] = useState('ALL');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const endpoint = payment ? 'payment-transactions' : 'refund-transactions';
      const result = await request<PageResult<PaymentRow | RefundRow>>(`/${endpoint}?merchantId=${merchantId}&page=1&pageSize=100`);
      setRows(Array.isArray(result.items) ? result.items : []);
    } catch (error) { message.error((error as Error).message); }
    finally { setLoading(false); }
  }, [merchantId, payment, request]);
  useEffect(() => { void load(); }, [load]);

  const statuses = useMemo(() => payment
    ? [{ value: 'ALL', label: '全部' }, { value: 'PAYMENT_SUCCEEDED', label: '支付成功' }, { value: 'PAYMENT_FAILED', label: '支付失败' }, { value: 'PAYMENT_CLOSED', label: '超时关闭' }]
    : [{ value: 'ALL', label: '全部' }, { value: 'PROCESSING', label: '退款中' }, { value: 'SUCCEEDED', label: '退款成功' }, { value: 'FAILED', label: '退款失败' }], [payment]);
  const filtered = useMemo(() => rows.filter((row) => {
    const eventStatus = payment ? (row as PaymentRow).eventType : row.status;
    if (status !== 'ALL' && eventStatus !== status) return false;
    const occurredAt = payment ? (row as PaymentRow).occurredAt : (row as RefundRow).createdAt;
    if (from && dayjs(occurredAt).isBefore(dayjs(`${from}T00:00:00`))) return false;
    if (to && dayjs(occurredAt).isAfter(dayjs(`${to}T23:59:59`))) return false;
    const text = Object.values(row).join(' ').toLowerCase();
    return !submittedKeyword || text.includes(submittedKeyword.toLowerCase());
  }), [from, payment, rows, status, submittedKeyword, to]);
  const tabOptions = statuses.map((item) => ({ ...item, label: `${item.label}(${item.value === 'ALL' ? rows.length : rows.filter((row) => (payment ? (row as PaymentRow).eventType : row.status) === item.value).length})` }));

  function reset() { setKeyword(''); setSubmittedKeyword(''); setStatus('ALL'); setFrom(''); setTo(''); }
  function exportCsv() {
    const header = payment ? ['流水ID', '订单号', '支付渠道', '状态', '金额', '创建时间'] : ['退款ID', '订单号', '券ID', '状态', '到账金额', '退款时间'];
    const lines = filtered.map((row) => payment
      ? [(row as PaymentRow).id, (row as PaymentRow).orderNo, (row as PaymentRow).provider, paymentEventText((row as PaymentRow).eventType), ((row.amountFen || 0) / 100).toFixed(2), (row as PaymentRow).occurredAt]
      : [row.id, row.orderNo, (row as RefundRow).voucherId, refundStatusText(row.status), ((row.amountFen || 0) / 100).toFixed(2), (row as RefundRow).createdAt]);
    const csv = `\uFEFF${[header, ...lines].map((line) => line.map((cell) => `"${String(cell ?? '').replaceAll('"', '""')}"`).join(',')).join('\r\n')}`;
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = `${payment ? '支付流水' : '退款流水'}-${dayjs().format('YYYYMMDDHHmmss')}.csv`; anchor.click(); URL.revokeObjectURL(url);
  }

  return <div className="merchant-finance-flow-page">
    <section className="flow-filter-panel">
      <Input allowClear prefix={<SearchOutlined />} value={keyword} onChange={(event) => setKeyword(event.target.value)} onPressEnter={() => setSubmittedKeyword(keyword.trim())} placeholder={payment ? '流水ID、订单号或支付渠道' : '退款ID、订单号或券ID'} />
      <Select value={status} onChange={setStatus} options={statuses} />
      <Input aria-label="开始日期" type="date" value={from} max={to || undefined} onChange={(event) => setFrom(event.target.value)} />
      <Input aria-label="结束日期" type="date" value={to} min={from || undefined} onChange={(event) => setTo(event.target.value)} />
      <Button type="primary" icon={<SearchOutlined />} onClick={() => setSubmittedKeyword(keyword.trim())}>搜索</Button>
      <Button onClick={reset}>重置</Button>
    </section>
    <section className="flow-status-panel"><Segmented value={status} options={tabOptions} onChange={(value) => setStatus(String(value))} /></section>
    <section className="operation-table"><div className="operation-table-heading"><div><strong>{payment ? '支付流水' : '退款流水'}</strong><span>共 {filtered.length} 条；{payment ? '含支付失败/超时关闭事件，营业额仅计支付成功' : '关联券、订单与售后工单状态，可追溯退款来源'}</span></div><Space><Button icon={<DownloadOutlined />} disabled={!filtered.length} onClick={exportCsv}>导出表格</Button><Button icon={<ReloadOutlined />} loading={loading} onClick={() => void load()}>刷新</Button></Space></div><Table rowKey="id" loading={loading} columns={payment ? paymentColumns : refundColumns} dataSource={filtered} locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无流水" /> }} pagination={{ pageSize: 15, showSizeChanger: false }} scroll={{ x: 1080 }} /></section>
  </div>;
}

const paymentColumns: ColumnsType<PaymentRow | RefundRow> = [
  { title: '流水ID', dataIndex: 'id', width: 220, render: (value: string) => <span className="flow-id">{value}</span> },
  { title: '订单号', dataIndex: 'orderNo', width: 210 },
  { title: '支付渠道', dataIndex: 'provider', width: 130, render: (value: string) => providerText(value) },
  { title: '状态', dataIndex: 'eventType', width: 120, render: (value: string) => <Tag color={value === 'PAYMENT_SUCCEEDED' ? 'green' : value === 'PAYMENT_FAILED' ? 'orange' : 'default'}>{paymentEventText(value)}</Tag> },
  { title: '处理状态', dataIndex: 'status', width: 120, render: (value: string) => <Tag color={value === 'PROCESSED' ? 'green' : value === 'REJECTED' ? 'red' : 'gold'}>{paymentStatusText(value)}</Tag> },
  { title: '支付金额', dataIndex: 'amountFen', align: 'right', width: 120, render: money },
  { title: '创建时间', dataIndex: 'occurredAt', width: 180, render: dateTime },
];

const refundColumns: ColumnsType<PaymentRow | RefundRow> = [
  { title: '退款ID', dataIndex: 'id', width: 220, render: (value: string) => <span className="flow-id">{value}</span> },
  { title: '订单号', dataIndex: 'orderNo', width: 210 },
  { title: '券ID', dataIndex: 'voucherId', width: 220 },
  { title: '状态', dataIndex: 'status', width: 110, render: (value: string) => <Tag color={value === 'SUCCEEDED' ? 'green' : value === 'FAILED' ? 'red' : 'gold'}>{refundStatusText(value)}</Tag> },
  { title: '券状态', dataIndex: 'voucherStatus', width: 120, render: (value: string | null) => value ? <Tag color={value === 'REFUNDED' ? 'green' : value === 'USED' ? 'blue' : value === 'UNUSED' ? 'default' : 'gold'}>{voucherStatusText(value)}</Tag> : '-' },
  { title: '订单状态', dataIndex: 'orderStatus', width: 110, render: (value: string | null) => value ? <Tag color={value === 'REFUNDED' ? 'green' : value === 'PAID' ? 'blue' : 'default'}>{value}</Tag> : '-' },
  { title: '退款原因', dataIndex: 'reason', width: 130, render: refundReasonText },
  { title: '关联工单', dataIndex: 'ticketPreview', width: 160, render: (value: string | null | undefined, row) => { const refund = row as RefundRow; return refund.ticketId ? <span title={refund.ticketId}>{value || refund.ticketId.slice(0, 8) + '…'}</span> : '-'; } },
  { title: '到账金额', dataIndex: 'amountFen', align: 'right', width: 110, render: money },
  { title: '退款时间', dataIndex: 'createdAt', width: 170, render: dateTime },
];

function voucherStatusText(value: string) { return ({ UNUSED: '未使用', USED: '已核销', REFUND_PENDING: '退款中', REFUNDED: '已退款', EXPIRED: '已过期' } as Record<string, string>)[value] || value; }

function providerText(value: string) { return ({ mock: '本地演示', wechat_pay: '微信小程序', wechat: '微信小程序' } as Record<string, string>)[String(value || '').toLowerCase()] || value || '-'; }
function paymentEventText(value: string) { return ({ PAYMENT_SUCCEEDED: '支付成功', PAYMENT_FAILED: '支付失败', PAYMENT_CLOSED: '超时关闭' } as Record<string, string>)[value] || value; }
function paymentStatusText(value: string) { return ({ RECEIVED: '已接收', PROCESSED: '已处理', REJECTED: '已拒绝', NEEDS_RECONCILIATION: '待对账' } as Record<string, string>)[value] || value; }
function refundStatusText(value: string) { return ({ PROCESSING: '退款中', SUCCEEDED: '退款成功', FAILED: '退款失败' } as Record<string, string>)[value] || value; }
function refundReasonText(value: string) { return ({ CUSTOMER_SELF_SERVICE: '用户申请', STORE_CLOSURE: '门店停业补偿', PLATFORM_EXCEPTION_REFUND: '异常退款' } as Record<string, string>)[value] || value || '-'; }
function dateTime(value: string) { return value ? dayjs(value).format('YYYY-MM-DD HH:mm:ss') : '-'; }
