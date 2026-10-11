import { EyeOutlined, ReloadOutlined, SearchOutlined } from '@ant-design/icons';
import { Alert, Button, Descriptions, Drawer, Empty, Input, Segmented, Select, Space, Table, Tag, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import dayjs from 'dayjs';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { OrderRecord, Store } from './workspace-model';
import { money, statusColor, statusText } from './workspace-model';

type Request = <T>(path: string, init?: RequestInit) => Promise<T>;
type OrderStatus = 'PENDING_PAYMENT' | 'PAID' | 'CLOSED' | 'REFUNDED';
type OrderPage = { items: OrderRecord[]; page: number; pageSize: number; total: number; statusCounts: Record<OrderStatus, number> };

const STATUS_OPTIONS: Array<{ value: 'ALL' | OrderStatus; label: string }> = [
  { value: 'ALL', label: '全部' },
  { value: 'PENDING_PAYMENT', label: '付款阶段' },
  { value: 'PAID', label: '履约中' },
  { value: 'CLOSED', label: '已完成/关闭' },
  { value: 'REFUNDED', label: '售后' },
];

export default function MerchantOrdersPage({ merchantId, request, stores }: { merchantId: string; request: Request; stores: Store[] }) {
  const [result, setResult] = useState<OrderPage>({ items: [], page: 1, pageSize: 20, total: 0, statusCounts: { PENDING_PAYMENT: 0, PAID: 0, CLOSED: 0, REFUNDED: 0 } });
  const [keyword, setKeyword] = useState('');
  const [submittedKeyword, setSubmittedKeyword] = useState('');
  const [status, setStatus] = useState<'ALL' | OrderStatus>('ALL');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [storeId, setStoreId] = useState('ALL');
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [selected, setSelected] = useState<OrderRecord | null>(null);

  const load = useCallback(async (page = result.page, pageSize = result.pageSize) => {
    const query = new URLSearchParams({ merchantId, page: String(page), pageSize: String(pageSize) });
    if (status !== 'ALL') query.set('status', status);
    if (submittedKeyword) query.set('keyword', submittedKeyword);
    if (from) query.set('from', from);
    if (to) query.set('to', to);
    setLoading(true);
    try {
      const response = await request<OrderPage>(`/orders?${query.toString()}`);
      if (!Array.isArray(response.items) || !response.statusCounts) throw new Error('订单接口返回数据不完整，请稍后刷新重试');
      setResult(response);
      setLoadError('');
    } catch (error) {
      setLoadError((error as Error).message || '订单数据加载失败');
    } finally { setLoading(false); }
  }, [from, merchantId, request, result.page, result.pageSize, status, submittedKeyword, to]);

  useEffect(() => { void load(1, result.pageSize); }, [status, submittedKeyword, from, to]); // eslint-disable-line react-hooks/exhaustive-deps

  const statusOptions = useMemo(() => STATUS_OPTIONS.map((item) => {
    const count = item.value === 'ALL' ? Object.values(result.statusCounts).reduce((sum, value) => sum + value, 0) : result.statusCounts[item.value];
    return { value: item.value, label: `${item.label} ${count}` };
  }), [result.statusCounts]);
  const visibleItems = useMemo(() => storeId === 'ALL' ? result.items : result.items.filter((item) => item.storeId === storeId), [result.items, storeId]);

  const columns: ColumnsType<OrderRecord> = [
    { title: '订单信息', width: 230, render: (_, row) => <div className="order-primary"><strong>{row.orderNo}</strong><span>{dayjs(row.createdAt).format('YYYY-MM-DD HH:mm:ss')}</span></div> },
    { title: '商品', width: 260, render: (_, row) => <div className="order-product"><span className="order-product-cover">{row.packageTitleSnapshot.slice(0, 1)}</span><div><strong>{row.packageTitleSnapshot}</strong><span>{money(row.unitPriceFen)} × {row.quantity}</span></div></div> },
    { title: '门店', dataIndex: 'storeId', width: 160, render: (value: string) => stores.find((store) => store.id === value)?.name || '适用门店' },
    { title: '实付金额', dataIndex: 'amountFen', width: 120, align: 'right', render: (value: number) => <strong>{money(value)}</strong> },
    { title: '订单状态', dataIndex: 'status', width: 110, render: (value: string) => <Tag color={statusColor(value)}>{statusText(value)}</Tag> },
    { title: '操作', width: 88, fixed: 'right', render: (_, row) => <Button type="link" icon={<EyeOutlined />} onClick={() => setSelected(row)}>详情</Button> },
  ];

  function submitSearch() { setSubmittedKeyword(keyword.trim()); }
  function reset() { setKeyword(''); setSubmittedKeyword(''); setStatus('ALL'); setFrom(''); setTo(''); setStoreId('ALL'); }

  return <div className="merchant-orders-page">
    <section className="order-status-strip"><Segmented block value={status} options={statusOptions} onChange={(value) => setStatus(value as 'ALL' | OrderStatus)} /></section>
    <section className="order-filter-panel">
      <div className="order-filter-field order-filter-keyword"><label>订单搜索</label><Input value={keyword} onChange={(event) => setKeyword(event.target.value)} onPressEnter={submitSearch} allowClear placeholder="订单号或商品名称" prefix={<SearchOutlined />} /></div>
      <div className="order-filter-field"><label>订单门店</label><Select value={storeId} onChange={setStoreId} options={[{ value: 'ALL', label: '全部门店' }, ...stores.map((store) => ({ value: store.id, label: store.name }))]} /></div>
      <div className="order-filter-field"><label>下单日期</label><Space.Compact><Input aria-label="开始日期" type="date" value={from} max={to || undefined} onChange={(event) => setFrom(event.target.value)} /><Input aria-label="结束日期" type="date" value={to} min={from || undefined} onChange={(event) => setTo(event.target.value)} /></Space.Compact></div>
      <div className="order-filter-actions"><Button type="primary" icon={<SearchOutlined />} onClick={submitSearch}>查询</Button><Button icon={<ReloadOutlined />} onClick={reset}>重置</Button></div>
    </section>
    <section className="operation-table order-list-panel">
      <div className="operation-table-heading"><div><strong>订单列表</strong><span>当前显示 {visibleItems.length} 笔，共 {result.total} 笔订单</span></div><Button icon={<ReloadOutlined />} loading={loading} onClick={() => void load()}>刷新</Button></div>
      {loadError && <Alert type="error" showIcon message="订单数据加载失败" description={result.items.length ? `当前保留上次成功加载的订单数据：${loadError}` : loadError} action={<Button size="small" onClick={() => void load()}>重试</Button>} />}
      <Table rowKey="id" loading={loading} columns={columns} dataSource={visibleItems} locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={loadError ? '订单数据加载失败，请重试' : '暂无符合条件的订单'} /> }} pagination={{ current: result.page, pageSize: result.pageSize, total: storeId === 'ALL' ? result.total : visibleItems.length, showSizeChanger: true, pageSizeOptions: [10, 20, 50, 100], showTotal: (total) => `共 ${total} 条`, onChange: (page, pageSize) => void load(page, pageSize) }} scroll={{ x: 980 }} />
    </section>
    <Drawer open={Boolean(selected)} title="订单详情" width={520} onClose={() => setSelected(null)}>
      {selected && <><Descriptions column={1} bordered size="small"><Descriptions.Item label="订单号"><Typography.Text copyable>{selected.orderNo}</Typography.Text></Descriptions.Item><Descriptions.Item label="商品">{selected.packageTitleSnapshot}</Descriptions.Item><Descriptions.Item label="数量">{selected.quantity}</Descriptions.Item><Descriptions.Item label="单价">{money(selected.unitPriceFen)}</Descriptions.Item><Descriptions.Item label="实付金额">{money(selected.amountFen)}</Descriptions.Item><Descriptions.Item label="订单状态"><Tag color={statusColor(selected.status)}>{statusText(selected.status)}</Tag></Descriptions.Item><Descriptions.Item label="适用门店">{stores.find((store) => store.id === selected.storeId)?.name || selected.storeId.slice(0, 8)}</Descriptions.Item><Descriptions.Item label="使用有效期">{String(selected.validFromSnapshot).slice(0, 10)} 至 {String(selected.validToSnapshot).slice(0, 10)}</Descriptions.Item><Descriptions.Item label="支付截止">{dayjs(selected.paymentExpiresAt).format('YYYY-MM-DD HH:mm:ss')}</Descriptions.Item><Descriptions.Item label="下单时间">{dayjs(selected.createdAt).format('YYYY-MM-DD HH:mm:ss')}</Descriptions.Item></Descriptions><div className="order-detail-note">顾客身份与支付渠道敏感标识不会在商户工作台展示。</div></>}
    </Drawer>
  </div>;
}
