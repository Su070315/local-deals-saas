import { DownloadOutlined, ReloadOutlined, SearchOutlined } from '@ant-design/icons';
import { Button, Empty, Input, Space, Statistic, Table, Tag, message } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import dayjs from 'dayjs';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { money } from './workspace-model';

type Request = <T>(path: string, init?: RequestInit) => Promise<T>;
type FinancePage = 'financeStatement' | 'balanceStatistics';
type Report = {
  summary: { paidAmountFen: number; refundedAmountFen: number; serviceFeeFen: number; orderCount: number };
  stores: Array<{ storeId: string; storeName: string; orderCount: number; paidAmountFen: number; refundAmountFen: number }>;
};
type LedgerEntry = { id: string; referenceNo: string; subjectName: string; amountFen: number; status: string; occurredAt: string; note: string; metadata?: Record<string, unknown> };

export default function MerchantFinanceDashboardPage({ page, merchantId, request }: { page: FinancePage; merchantId: string; request: Request }) {
  const statement = page === 'financeStatement';
  const [report, setReport] = useState<Report | null>(null);
  const [ledger, setLedger] = useState<LedgerEntry[]>([]);
  const [range, setRange] = useState('TODAY');
  const [keyword, setKeyword] = useState('');
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      if (statement) setReport(await request<Report>(`/reports/analytics?merchantId=${merchantId}&${rangeQuery(range)}`));
      else {
        const rows = await request<LedgerEntry[]>(`/merchant-operations/${merchantId}/ledger/MEMBER_RECHARGE`);
        setLedger(Array.isArray(rows) ? rows : []);
      }
    } catch (error) { message.error((error as Error).message); }
    finally { setLoading(false); }
  }, [merchantId, range, request, statement]);
  useEffect(() => { void load(); }, [load]);

  const filteredStores = useMemo(() => (report?.stores || []).filter((row) => !keyword.trim() || row.storeName.toLowerCase().includes(keyword.trim().toLowerCase())), [keyword, report?.stores]);
  const dateRange = rangeDates(range);
  const filteredLedger = useMemo(() => ledger.filter((row) => {
    const day = dayjs(row.occurredAt);
    return day.isAfter(dateRange.from.subtract(1, 'second')) && day.isBefore(dateRange.to.add(1, 'second')) && (!keyword.trim() || `${row.referenceNo} ${row.subjectName} ${row.note}`.toLowerCase().includes(keyword.trim().toLowerCase()));
  }), [dateRange.from, dateRange.to, keyword, ledger]);
  const completed = filteredLedger.filter((row) => row.status === 'COMPLETED');
  const principalFen = completed.reduce((sum, row) => sum + Number(row.metadata?.principalFen ?? row.amountFen), 0);
  const giftFen = completed.reduce((sum, row) => sum + Number(row.metadata?.giftFen || 0), 0);

  const metrics = statement ? [
    ['门店总数', report?.stores.length || 0], ['交易额', money(report?.summary.paidAmountFen || 0)],
    ['退款金额', money(report?.summary.refundedAmountFen || 0)], ['实际收入', money(Math.max(0, Number(report?.summary.paidAmountFen || 0) - Number(report?.summary.refundedAmountFen || 0) - Number(report?.summary.serviceFeeFen || 0)))],
  ] : [
    ['有效笔数', completed.length], ['充值本金', money(principalFen)], ['赠送金额', money(giftFen)], ['可用总额', money(principalFen + giftFen)],
  ];

  function exportCsv() {
    const lines = statement
      ? filteredStores.map((row) => [row.storeId, row.storeName, row.orderCount, row.paidAmountFen / 100, row.refundAmountFen / 100, (row.paidAmountFen - row.refundAmountFen) / 100])
      : filteredLedger.map((row) => [row.referenceNo, row.subjectName, row.amountFen / 100, row.status, row.occurredAt, row.note]);
    const header = statement ? ['门店ID', '门店名称', '订单笔数', '交易额', '退款金额', '实际收入'] : ['批次ID', '会员', '充值金额', '状态', '时间', '备注'];
    const csv = `\uFEFF${[header, ...lines].map((line) => line.map((cell) => `"${String(cell ?? '').replaceAll('"', '""')}"`).join(',')).join('\r\n')}`;
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' })); const anchor = document.createElement('a'); anchor.href = url; anchor.download = `${statement ? '账单统计' : '储值统计'}-${dayjs().format('YYYYMMDDHHmmss')}.csv`; anchor.click(); URL.revokeObjectURL(url);
  }

  return <div className="merchant-finance-dashboard">
    <section className="finance-range-panel"><div><strong>时间筛选</strong><span>按中国标准时间汇总</span></div><Space wrap>{(statement ? [['TODAY', '今日'], ['YESTERDAY', '昨日'], ['WEEK', '近七天'], ['MONTH', '近三十天'], ['CUSTOM', '本月']] : [['ALL', '全部'], ['TODAY', '今日'], ['YESTERDAY', '昨日'], ['WEEK', '近七天'], ['MONTH', '近三十天'], ['CUSTOM', '本月']]).map(([value, label]) => <Button key={value} type={range === value ? 'primary' : 'default'} onClick={() => setRange(value)}>{label}</Button>)}</Space></section>
    <section className="finance-metric-grid">{metrics.map(([label, value], index) => <div className={index === metrics.length - 1 ? 'income' : ''} key={String(label)}><Statistic title={label} value={value} /></div>)}</section>
    <section className="finance-table-toolbar"><Input allowClear prefix={<SearchOutlined />} value={keyword} onChange={(event) => setKeyword(event.target.value)} placeholder={statement ? '门店名称' : '批次ID、会员或备注'} /><Button type="primary" icon={<SearchOutlined />}>搜索</Button><Button icon={<DownloadOutlined />} disabled={statement ? !filteredStores.length : !filteredLedger.length} onClick={exportCsv}>导出表格</Button><Button icon={<ReloadOutlined />} loading={loading} onClick={() => void load()}>刷新</Button></section>
    <section className="operation-table"><Table rowKey="id" loading={loading} columns={statement ? statementColumns : balanceColumns} dataSource={statement ? filteredStores.map((row) => ({ ...row, id: row.storeId })) : filteredLedger} locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无数据" /> }} pagination={{ pageSize: 15, showSizeChanger: false }} scroll={{ x: 960 }} /></section>
  </div>;
}

const statementColumns: ColumnsType<Record<string, unknown>> = [
  { title: '门店ID', dataIndex: 'storeId', width: 220 }, { title: '门店名称', dataIndex: 'storeName', width: 220 },
  { title: '订单笔数', dataIndex: 'orderCount', align: 'right', render: (value: number) => `${value} 笔` },
  { title: '交易额', dataIndex: 'paidAmountFen', align: 'right', render: money }, { title: '退款金额', dataIndex: 'refundAmountFen', align: 'right', render: money },
  { title: '实际收入', align: 'right', render: (_, row) => <strong className="finance-income-value">{money(Number(row.paidAmountFen || 0) - Number(row.refundAmountFen || 0))}</strong> },
];
const balanceColumns: ColumnsType<Record<string, unknown>> = [
  { title: '批次ID', dataIndex: 'referenceNo', width: 210 }, { title: '会员', dataIndex: 'subjectName', width: 180 },
  { title: '充值本金', dataIndex: 'amountFen', align: 'right', render: money }, { title: '赠金', align: 'right', render: (_, row) => money(Number((row.metadata as Record<string, unknown> | undefined)?.giftFen || 0)) },
  { title: '状态', dataIndex: 'status', width: 110, render: (value: string) => <Tag color={value === 'COMPLETED' ? 'green' : value === 'REFUNDED' ? 'red' : 'gold'}>{value === 'COMPLETED' ? '已入账' : value === 'REFUNDED' ? '已退款' : '待入账'}</Tag> },
  { title: '时间', dataIndex: 'occurredAt', width: 180, render: (value: string) => dayjs(value).format('YYYY-MM-DD HH:mm:ss') }, { title: '备注', dataIndex: 'note', render: (value: string) => value || '-' },
];

function rangeDates(range: string) { const today = dayjs(); const to = range === 'YESTERDAY' ? today.subtract(1, 'day').endOf('day') : today.endOf('day'); const from = range === 'ALL' ? dayjs('2000-01-01') : range === 'TODAY' || range === 'YESTERDAY' ? to.startOf('day') : range === 'WEEK' ? to.subtract(6, 'day').startOf('day') : range === 'CUSTOM' ? to.startOf('month') : to.subtract(29, 'day').startOf('day'); return { from, to }; }
function rangeQuery(range: string) { const dates = rangeDates(range); return `from=${dates.from.format('YYYY-MM-DD')}&to=${dates.to.format('YYYY-MM-DD')}`; }
