import { ReloadOutlined, SearchOutlined } from '@ant-design/icons';
import { Avatar, Button, Input, Popconfirm, Select, Space, Statistic, Table, Tag, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useMemo, useState } from 'react';
import type { RequestBody } from '../api-contract';
import { DataTable } from './data-table-shell';
import type { Deal, Store } from './workspace-model';
import { money, statusColor, statusText } from './workspace-model';

export type CatalogDataPageProps = {
  page: 'stores' | 'packages';
  data: unknown[];
  readOnly: boolean;
  onStoreEdit: (record: Store) => void;
  onStoreSaleChange: (record: Store, openForSale: boolean) => void;
  onStoreVersionsOpen: (record: Store) => void;
  onPackageEdit: (record: Deal) => void;
  onPackageStatusChange: (record: Deal, status: RequestBody<'AppController_packageStatus'>['status']) => void;
  onPackageVersionsOpen: (record: Deal) => void;
};

export default function CatalogDataPage(props: CatalogDataPageProps) {
  const [keyword, setKeyword] = useState('');
  const [status, setStatus] = useState('ALL');
  const packages = useMemo(() => props.page === 'packages' ? props.data as Deal[] : [], [props.data, props.page]);
  const filtered = useMemo(() => packages.filter((record) => {
    const keywordMatch = !keyword.trim() || `${record.title} ${record.description} ${record.tags.join(' ')}`.toLowerCase().includes(keyword.trim().toLowerCase());
    return keywordMatch && (status === 'ALL' || record.status === status);
  }), [keyword, packages, status]);
  const onSale = packages.filter((record) => record.status === 'ON_SALE').length;
  const sold = packages.reduce((sum, record) => sum + Number(record.soldCount || 0), 0);
  if (props.page === 'stores') return <DataTable data={props.data as Store[]} columns={storeColumns(props)} />;
  return <div className="product-catalog-page">
    <section className="product-filter-panel"><Input allowClear prefix={<SearchOutlined />} value={keyword} onChange={(event) => setKeyword(event.target.value)} placeholder="搜索商品名称、标签或介绍" /><Select value={status} onChange={setStatus} options={[{ value: 'ALL', label: '全部状态' }, { value: 'ON_SALE', label: '销售中' }, { value: 'OFF_SALE', label: '已下架' }, { value: 'DRAFT', label: '草稿' }]} /><Button icon={<ReloadOutlined />} onClick={() => { setKeyword(''); setStatus('ALL'); }}>重置</Button></section>
    <div className="operation-metrics product-metrics"><div className="operation-metric blue"><Statistic title="商品总数" value={packages.length} suffix="个" /></div><div className="operation-metric green"><Statistic title="销售中" value={onSale} suffix="个" /></div><div className="operation-metric orange"><Statistic title="累计销量" value={sold} suffix="份" /></div><div className="operation-metric purple"><Statistic title="已下架" value={packages.length - onSale} suffix="个" /></div></div>
    <section className="operation-table product-list-panel"><div className="operation-table-heading"><div><strong>商品库</strong><span>当前显示 {filtered.length} 个商品</span></div><Tag color="blue">到店核销商品</Tag></div><Table rowKey="id" columns={packageColumns(props)} dataSource={filtered} pagination={{ pageSize: 12, showSizeChanger: false }} scroll={{ x: 1060 }} /></section>
  </div>;
}

function storeColumns(props: CatalogDataPageProps): ColumnsType<Store> {
  return [
    { title: '门店', dataIndex: 'name' },
    { title: '地址', dataIndex: 'address' },
    { title: '地图坐标', render: (_, record) => record.latitude !== null && record.longitude !== null ? `${record.latitude.toFixed(6)}, ${record.longitude.toFixed(6)}` : <Tag>未设置</Tag> },
    { title: '营业时间', dataIndex: 'businessHours' },
    { title: '新售状态', dataIndex: 'openForSale', render: (value) => <Tag color={value ? 'green' : 'orange'}>{value ? '可售' : '暂停新售'}</Tag> },
    { title: '历史券履约', dataIndex: 'openForVerification', render: (value) => <Tag color={value ? 'green' : 'red'}>{value ? '可核销' : '已停止履约'}</Tag> },
    { title: '版本', dataIndex: 'version', width: 72, render: (value) => `v${value}` },
    {
      title: '操作',
      render: (_, record) => !props.readOnly && <Space size={4}>
        <Button size="small" onClick={() => props.onStoreEdit(record)}>编辑</Button>
        <Button size="small" onClick={() => props.onStoreVersionsOpen(record)}>版本</Button>
        <Popconfirm title={record.openForSale ? '暂停该门店的新订单？' : '恢复该门店的新订单？'} description={record.openForSale ? '此操作不影响已购券核销；停止履约仅可由平台单独确认。' : undefined} onConfirm={() => props.onStoreSaleChange(record, !record.openForSale)}>
          <Button size="small">{record.openForSale ? '暂停新售' : '恢复新售'}</Button>
        </Popconfirm>
      </Space>,
    },
  ];
}

function packageColumns(props: CatalogDataPageProps): ColumnsType<Deal> {
  return [
    { title: '商品', dataIndex: 'title', width: 320, render: (value, record) => <div className="product-title-cell"><Avatar shape="square" size={58} src={record.coverImageUrl || undefined}>{String(value).slice(0, 1)}</Avatar><Space direction="vertical" size={2}><b>{value}</b><Typography.Text type="secondary" ellipsis>{record.description}</Typography.Text>{record.tags.length ? <Space size={4} wrap>{record.tags.map((tag) => <Tag key={tag}>{tag}</Tag>)}</Space> : null}</Space></div> },
    { title: '售价', render: (_, record) => <Space direction="vertical" size={0}><span>{money(record.priceFen)}</span>{record.originalPriceFen && record.originalPriceFen > record.priceFen ? <Typography.Text delete type="secondary">{money(record.originalPriceFen)}</Typography.Text> : null}</Space> },
    { title: '销量/限量', width: 110, render: (_, record) => `${record.soldCount}/${record.saleLimit || '不限'}` },
    { title: '每人限购', dataIndex: 'perCustomerLimit', width: 100, render: (value: number) => value ? `${value} 份` : '不限' },
    { title: '有效期', width: 200, render: (_, record) => <Space direction="vertical" size={0}><span>{String(record.validFrom).slice(0, 10)}</span><Typography.Text type="secondary">至 {String(record.validTo).slice(0, 10)}</Typography.Text></Space> },
    { title: '状态', dataIndex: 'status', render: (value) => <Tag color={statusColor(value)}>{statusText(value)}</Tag> },
    {
      title: '操作',
      fixed: 'right', width: 184,
      render: (_, record) => !props.readOnly && <Space size={2}>
        <Button type="link" size="small" onClick={() => props.onPackageEdit(record)}>编辑</Button>
        <Button type="link" size="small" onClick={() => props.onPackageVersionsOpen(record)}>版本</Button>
        <Popconfirm title={record.status === 'ON_SALE' ? '确认下架该套餐？' : '确认上架该套餐？'} description={record.status === 'ON_SALE' ? '下架后停止新订单，已购券仍按原规则履约。' : '上架后顾客端将立即可见并可购买。'} onConfirm={() => props.onPackageStatusChange(record, record.status === 'ON_SALE' ? 'OFF_SALE' : 'ON_SALE')}>
          <Button type="link" danger={record.status === 'ON_SALE'} size="small">{record.status === 'ON_SALE' ? '下架' : '上架'}</Button>
        </Popconfirm>
      </Space>,
    },
  ];
}
