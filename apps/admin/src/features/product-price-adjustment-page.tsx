import { ReloadOutlined, SaveOutlined, SearchOutlined } from '@ant-design/icons';
import { Button, Input, InputNumber, Space, Table, Tag, message } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Deal } from './workspace-model';
import { money, statusColor, statusText } from './workspace-model';

type Request = <T>(path: string, init?: RequestInit) => Promise<T>;

export default function ProductPriceAdjustmentPage({ merchantId, request }: { merchantId: string; request: Request }) {
  const [packages, setPackages] = useState<Deal[]>([]);
  const [keyword, setKeyword] = useState('');
  const [drafts, setDrafts] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const load = useCallback(async () => {
    setLoading(true);
    try { const rows = await request<Deal[]>(`/merchants/${merchantId}/packages`); setPackages(Array.isArray(rows) ? rows : []); setDrafts(Object.fromEntries((rows || []).map((row) => [row.id, row.priceFen / 100]))); }
    catch (error) { message.error((error as Error).message); }
    finally { setLoading(false); }
  }, [merchantId, request]);
  useEffect(() => { void load(); }, [load]);
  const rows = useMemo(() => packages.filter((row) => !keyword.trim() || `${row.title} ${row.skuCode || ''} ${row.categoryName || ''}`.toLowerCase().includes(keyword.trim().toLowerCase())), [keyword, packages]);

  async function save() {
    const changed = packages.filter((row) => Number(drafts[row.id]) * 100 !== row.priceFen);
    if (!changed.length) { message.info('没有需要保存的价格变更'); return; }
    setSaving(true);
    try {
      for (const row of changed) {
        const priceFen = Math.round(Number(drafts[row.id]) * 100);
        if (!Number.isInteger(priceFen) || priceFen < 1) throw new Error(`${row.title} 的价格不正确`);
        const originalPriceFen = row.originalPriceFen && row.originalPriceFen >= priceFen ? row.originalPriceFen : null;
        await request(`/merchants/${merchantId}/packages`, { method: 'POST', body: JSON.stringify({
          id: row.id, expectedVersion: row.version, title: row.title, description: row.description, priceFen,
          originalPriceFen, memberPriceFen: row.memberPriceFen && row.memberPriceFen <= priceFen ? row.memberPriceFen : null,
          purchasePriceFen: row.purchasePriceFen, productType: row.productType || 'GROUP_BUY', skuCode: row.skuCode || '', barcode: row.barcode || '',
          recommendation: row.recommendation || '', coverImageUrl: row.coverImageUrl || null, galleryUrls: row.galleryUrls || [], videoUrl: row.videoUrl || null,
          categoryName: row.categoryName || '', unit: row.unit || '份', minPurchaseQuantity: row.minPurchaseQuantity || 1, virtualSales: row.virtualSales || 0,
          tags: row.tags || [], fulfillmentMethods: row.fulfillmentMethods || ['STORE_PICKUP'], distributionEnabled: row.distributionEnabled === true,
          batchManaged: row.batchManaged === true, pointsEnabled: row.pointsEnabled !== false, inventoryEnabled: row.inventoryEnabled !== false,
          inventoryWarningThreshold: row.inventoryWarningThreshold || 0, salesChannels: row.salesChannels || ['ONLINE', 'OFFLINE'],
          guaranteeLabels: row.guaranteeLabels || [], parameterValues: row.parameterValues || [], purchaseNotes: row.purchaseNotes || '', usageRules: row.usageRules || '', detailContent: row.detailContent || '',
          saleLimit: row.saleLimit || 0, perCustomerLimit: row.perCustomerLimit || 0, storeIds: row.storeIds, validFrom: String(row.validFrom).slice(0, 10), validTo: String(row.validTo).slice(0, 10), status: row.status,
        }) });
      }
      message.success(`已保存 ${changed.length} 个商品的价格`); await load();
    } catch (error) { message.error((error as Error).message); }
    finally { setSaving(false); }
  }

  const columns: ColumnsType<Deal> = [
    { title: '商品', dataIndex: 'title', width: 260, render: (value, row) => <Space direction="vertical" size={0}><strong>{value}</strong><span className="muted-text">{row.skuCode || '未设置货号'} · {row.categoryName || '未分类'}</span></Space> },
    { title: '当前售价', dataIndex: 'priceFen', width: 120, render: (value) => money(value) },
    { title: '新售价（元）', width: 170, render: (_, row) => <InputNumber min={0.01} precision={2} value={drafts[row.id]} onChange={(value) => setDrafts((previous) => ({ ...previous, [row.id]: Number(value || 0) }))} /> },
    { title: '会员价', dataIndex: 'memberPriceFen', width: 110, render: (value) => value ? money(value) : '未设置' },
    { title: '销售状态', dataIndex: 'status', width: 110, render: (value) => <Tag color={statusColor(value)}>{statusText(value)}</Tag> },
  ];
  return <div className="product-price-adjustment-page">
    <section className="operation-filter"><Input allowClear prefix={<SearchOutlined />} placeholder="商品名称 / 货号 / 分类" value={keyword} onChange={(event) => setKeyword(event.target.value)} /><Button icon={<ReloadOutlined />} onClick={() => { setKeyword(''); void load(); }}>重置</Button><Button type="primary" icon={<SaveOutlined />} loading={saving} onClick={() => void save()}>保存改价</Button></section>
    <section className="operation-table"><div className="operation-table-heading"><div><strong>商品改价</strong><span>支持批量调整零售价，服务端保留商品版本和审计记录</span></div><Tag color="blue">一级分销商品同样适用</Tag></div><Table rowKey="id" loading={loading} columns={columns} dataSource={rows} pagination={{ pageSize: 12 }} scroll={{ x: 820 }} /></section>
  </div>;
}
