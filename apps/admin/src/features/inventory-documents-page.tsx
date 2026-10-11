import { CheckOutlined, DeleteOutlined, EditOutlined, PlusOutlined, ReloadOutlined, SearchOutlined, StopOutlined } from '@ant-design/icons';
import { Button, Form, Input, InputNumber, Modal, Popconfirm, Select, Space, Statistic, Table, Tag, message } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import dayjs from 'dayjs';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Store } from './workspace-model';
import { money } from './workspace-model';

type Request = <T>(path: string, init?: RequestInit) => Promise<T>;
type DocumentType = 'PURCHASE' | 'REQUISITION' | 'INBOUND' | 'OUTBOUND' | 'LOSS' | 'COUNT' | 'TRANSFER';
type DocumentStatus = 'DRAFT' | 'CONFIRMED' | 'CANCELLED';
type InventoryBatch = { id: string; storeId: string | null; skuCode: string; productName: string; quantity: number; reservedQuantity: number; unitCostFen: number };
type DocumentItem = { batchId?: string; skuCode: string; productName: string; quantity: number; unitCostFen: number };
type InventoryDocument = { id: string; documentNo: string; type: DocumentType; storeId: string | null; sourceStoreId: string | null; targetStoreId: string | null; counterparty: string; items: DocumentItem[]; totalQuantity: number; totalAmountFen: number; occurredAt: string; status: DocumentStatus; note: string; confirmedAt: string | null; updatedAt: string };

const PAGE_CONFIG: Record<string, { type: DocumentType | null; title: string; counterparty: string }> = {
  inventoryRecords: { type: null, title: '库存记录', counterparty: '业务对象' },
  inventoryPurchase: { type: 'PURCHASE', title: '采购单', counterparty: '供应商' },
  inventoryRequisition: { type: 'REQUISITION', title: '门店要货', counterparty: '申请人' },
  inventoryInbound: { type: 'INBOUND', title: '入库单', counterparty: '来源单位' },
  inventoryOutbound: { type: 'OUTBOUND', title: '出库单', counterparty: '领用单位' },
  inventoryLoss: { type: 'LOSS', title: '报损单', counterparty: '报损原因' },
  inventoryCount: { type: 'COUNT', title: '库存盘点', counterparty: '盘点负责人' },
  inventoryTransfer: { type: 'TRANSFER', title: '库存调拨', counterparty: '经办人' },
};

export default function InventoryDocumentsPage({ page, merchantId, request, stores }: { page: string; merchantId: string; request: Request; stores: Store[] }) {
  const config = PAGE_CONFIG[page] || PAGE_CONFIG.inventoryPurchase;
  const [rows, setRows] = useState<InventoryDocument[]>([]);
  const [batches, setBatches] = useState<InventoryBatch[]>([]);
  const [keyword, setKeyword] = useState('');
  const [status, setStatus] = useState<'ALL' | DocumentStatus>('ALL');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState<InventoryDocument | null>(null);
  const [open, setOpen] = useState(false);
  const [form] = Form.useForm();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [documents, inventory] = await Promise.all([
        request<InventoryDocument[]>(`/merchant-operations/${merchantId}/inventory-documents${config.type ? `?type=${config.type}` : ''}`),
        request<InventoryBatch[]>(`/merchant-operations/${merchantId}/inventory`),
      ]);
      setRows(Array.isArray(documents) ? documents : []);
      setBatches(Array.isArray(inventory) ? inventory : []);
    } catch (error) { message.error((error as Error).message); }
    finally { setLoading(false); }
  }, [config.type, merchantId, request]);

  useEffect(() => { void load(); }, [load]);

  const filtered = useMemo(() => rows.filter((row) => {
    const text = `${row.documentNo} ${row.counterparty} ${row.items.map((item) => `${item.skuCode} ${item.productName}`).join(' ')}`.toLowerCase();
    return (!keyword.trim() || text.includes(keyword.trim().toLowerCase())) && (status === 'ALL' || row.status === status);
  }), [keyword, rows, status]);

  function edit(row?: InventoryDocument) {
    if (!config.type) return;
    const next = row || null;
    setEditing(next);
    form.resetFields();
    form.setFieldsValue(next ? {
      ...next, occurredAt: dayjs(next.occurredAt).format('YYYY-MM-DDTHH:mm'),
      items: next.items.map((item) => ({ ...item, unitCostYuan: item.unitCostFen / 100 })),
    } : { occurredAt: dayjs().format('YYYY-MM-DDTHH:mm'), items: [{ quantity: config.type === 'COUNT' ? 0 : 1, unitCostYuan: 0 }] });
    setOpen(true);
  }

  async function save(values: Record<string, unknown>) {
    const items = (values.items as Array<Record<string, unknown>>).map((item) => ({
      ...(item.batchId ? { batchId: item.batchId } : {}), skuCode: item.skuCode, productName: item.productName,
      quantity: Number(item.quantity), unitCostFen: Math.round(Number(item.unitCostYuan || 0) * 100),
    }));
    setSaving(true);
    try {
      await request(`/merchant-operations/${merchantId}/inventory-documents`, { method: 'POST', body: JSON.stringify({ ...(editing ? { id: editing.id } : {}), type: config.type, storeId: values.storeId, sourceStoreId: values.sourceStoreId, targetStoreId: values.targetStoreId, counterparty: values.counterparty || '', occurredAt: new Date(String(values.occurredAt)).toISOString(), note: values.note || '', items }) });
      message.success(editing ? '库存单据已保存' : `${config.title}草稿已创建`);
      setOpen(false); setEditing(null); await load();
    } catch (error) { message.error((error as Error).message); }
    finally { setSaving(false); }
  }

  async function changeStatus(row: InventoryDocument, nextStatus: 'CONFIRMED' | 'CANCELLED') {
    setSaving(true);
    try {
      await request(`/merchant-operations/${merchantId}/inventory-documents/${row.id}/status`, { method: 'POST', body: JSON.stringify({ status: nextStatus }) });
      const recordsOnly = ['PURCHASE', 'REQUISITION'].includes(row.type);
      message.success(nextStatus === 'CONFIRMED' ? recordsOnly ? '单据已确认，等待后续入库或调拨履约' : '单据已确认，库存已同步更新' : '单据已取消');
      await load();
    } catch (error) { message.error((error as Error).message); }
    finally { setSaving(false); }
  }

  const metrics = { total: rows.length, draft: rows.filter((row) => row.status === 'DRAFT').length, confirmed: rows.filter((row) => row.status === 'CONFIRMED').length, amount: rows.filter((row) => row.status === 'CONFIRMED').reduce((sum, row) => sum + row.totalAmountFen, 0) };
  const columns: ColumnsType<InventoryDocument> = [
    { title: '单据编号', dataIndex: 'documentNo', width: 180, render: (value: string, row) => <div className="order-primary"><strong>{value}</strong><span>{dayjs(row.occurredAt).format('YYYY-MM-DD HH:mm')}</span></div> },
    { title: config.counterparty, dataIndex: 'counterparty', width: 150, render: (value: string) => value || '-' },
    { title: '门店', width: 220, render: (_, row) => row.type === 'TRANSFER' ? `${storeName(stores, row.sourceStoreId)} → ${storeName(stores, row.targetStoreId)}` : storeName(stores, row.storeId) },
    { title: '商品数', dataIndex: 'items', align: 'right', render: (items: DocumentItem[]) => `${items.length} 种` },
    { title: config.type === 'COUNT' ? '盘点数量' : '总数量', dataIndex: 'totalQuantity', align: 'right' },
    { title: '金额', dataIndex: 'totalAmountFen', align: 'right', render: money },
    { title: '状态', dataIndex: 'status', width: 100, render: (value: DocumentStatus) => <Tag color={value === 'CONFIRMED' ? 'green' : value === 'DRAFT' ? 'gold' : 'default'}>{value === 'CONFIRMED' ? '已确认' : value === 'DRAFT' ? '草稿' : '已取消'}</Tag> },
    { title: '操作', fixed: 'right', width: 200, render: (_, row) => row.status === 'DRAFT' ? <Space size={0}><Button type="link" icon={<EditOutlined />} onClick={() => edit(row)}>编辑</Button><Popconfirm title="确认此库存单据？" description={['PURCHASE', 'REQUISITION'].includes(row.type) ? `${config.title}确认后只记录业务审批，不直接改变库存。` : '确认后将按单据内容更新库存，且不能再编辑。'} onConfirm={() => void changeStatus(row, 'CONFIRMED')}><Button type="link" icon={<CheckOutlined />}>确认</Button></Popconfirm><Popconfirm title="取消此草稿单据？" onConfirm={() => void changeStatus(row, 'CANCELLED')}><Button type="link" danger icon={<StopOutlined />}>取消</Button></Popconfirm></Space> : <span className="table-muted">{row.confirmedAt ? dayjs(row.confirmedAt).format('MM-DD HH:mm') : '-'}</span> },
  ];

  return <div className="inventory-documents-page merchant-operation-page">
    <section className="operation-filter"><Input allowClear prefix={<SearchOutlined />} placeholder={`搜索${config.title}编号、商品或经办信息`} value={keyword} onChange={(event) => setKeyword(event.target.value)} /><Select value={status} onChange={setStatus} options={[{ value: 'ALL', label: '全部状态' }, { value: 'DRAFT', label: '草稿' }, { value: 'CONFIRMED', label: '已确认' }, { value: 'CANCELLED', label: '已取消' }]} /><Button icon={<ReloadOutlined />} loading={loading} onClick={() => void load()}>刷新</Button>{config.type ? <Button type="primary" icon={<PlusOutlined />} onClick={() => edit()}>新建{config.title}</Button> : <span />}</section>
    <div className="operation-metrics"><div className="operation-metric blue"><Statistic title="单据总数" value={metrics.total} /></div><div className="operation-metric orange"><Statistic title="待确认" value={metrics.draft} /></div><div className="operation-metric green"><Statistic title="已确认" value={metrics.confirmed} /></div><div className="operation-metric purple"><Statistic title="确认金额" value={money(metrics.amount)} /></div></div>
    <section className="operation-table"><div className="operation-table-heading"><div><strong>{config.title}</strong><span>{config.type === 'REQUISITION' ? '要货审批与实际库存变更分离，后续由调拨或入库单履约' : '库存变化只由已确认单据产生'}</span></div><Tag color="blue">全程审计</Tag></div><Table rowKey="id" loading={loading} columns={columns} dataSource={filtered} pagination={{ pageSize: 12, showSizeChanger: false }} scroll={{ x: 1120 }} /></section>
    <Modal open={open} title={`${editing ? '编辑' : '新建'}${config.title}`} width={920} confirmLoading={saving} onCancel={() => { if (!saving) setOpen(false); }} onOk={() => form.submit()} destroyOnHidden>
      <Form form={form} layout="vertical" onFinish={(values) => void save(values)}><Space className="inventory-document-header" align="start">{config.type === 'TRANSFER' ? <><Form.Item name="sourceStoreId" label="调出门店" rules={[{ required: true }]}><Select showSearch optionFilterProp="label" options={stores.map((store) => ({ value: store.id, label: store.name }))} /></Form.Item><Form.Item name="targetStoreId" label="调入门店" rules={[{ required: true }]}><Select showSearch optionFilterProp="label" options={stores.map((store) => ({ value: store.id, label: store.name }))} /></Form.Item></> : <Form.Item name="storeId" label="门店" rules={[{ required: true }]}><Select showSearch optionFilterProp="label" options={stores.map((store) => ({ value: store.id, label: store.name }))} /></Form.Item>}<Form.Item name="counterparty" label={config.counterparty}><Input maxLength={120} /></Form.Item><Form.Item name="occurredAt" label="业务时间" rules={[{ required: true }]}><Input type="datetime-local" /></Form.Item></Space><Form.List name="items">{(fields, { add, remove }) => <div className="inventory-document-items"><div className="inventory-document-items-title"><strong>商品明细</strong><Button icon={<PlusOutlined />} onClick={() => add({ quantity: config.type === 'COUNT' ? 0 : 1, unitCostYuan: 0 })}>添加商品</Button></div>{fields.map((field) => <div className="inventory-document-item" key={field.key}>{['OUTBOUND', 'LOSS', 'COUNT', 'TRANSFER'].includes(config.type || '') && <Form.Item name={[field.name, 'batchId']} label="库存批次" rules={[{ required: true }]}><Select showSearch optionFilterProp="label" options={batches.map((batch) => ({ value: batch.id, label: `${batch.productName} / ${batch.skuCode} / 可用 ${batch.quantity - batch.reservedQuantity}` }))} onChange={(batchId) => { const batch = batches.find((item) => item.id === batchId); if (batch) { form.setFieldValue(['items', field.name, 'skuCode'], batch.skuCode); form.setFieldValue(['items', field.name, 'productName'], batch.productName); form.setFieldValue(['items', field.name, 'unitCostYuan'], batch.unitCostFen / 100); } }} /></Form.Item>}<Form.Item name={[field.name, 'skuCode']} label="货号" rules={[{ required: true }]}><Input /></Form.Item><Form.Item name={[field.name, 'productName']} label="商品名称" rules={[{ required: true }]}><Input /></Form.Item><Form.Item name={[field.name, 'quantity']} label={config.type === 'COUNT' ? '盘点数量' : '数量'} rules={[{ required: true }]}><InputNumber min={0} precision={0} /></Form.Item><Form.Item name={[field.name, 'unitCostYuan']} label="单位成本（元）" rules={[{ required: true }]}><InputNumber min={0} precision={2} /></Form.Item><Button className="inventory-item-remove" aria-label="删除商品明细" type="text" danger icon={<DeleteOutlined />} disabled={fields.length === 1} onClick={() => remove(field.name)} /></div>)}</div>}</Form.List><Form.Item name="note" label="备注"><Input.TextArea rows={3} maxLength={500} /></Form.Item></Form>
    </Modal>
  </div>;
}

function storeName(stores: Store[], id: string | null) { return stores.find((store) => store.id === id)?.name || '-'; }
