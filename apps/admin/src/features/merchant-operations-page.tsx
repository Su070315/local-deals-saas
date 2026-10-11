import { EditOutlined, PlusOutlined, ReloadOutlined, SearchOutlined } from '@ant-design/icons';
import { Button, Form, Input, InputNumber, Modal, Select, Space, Statistic, Switch, Table, Tag, message } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import dayjs from 'dayjs';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { money } from './workspace-model';

type Request = <T>(path: string, init?: RequestInit) => Promise<T>;
type OperationKind = 'inventory' | 'members' | 'campaigns' | 'promoters';
type RecordRow = Record<string, unknown> & { id: string; status?: string; updatedAt?: string };
type Summary = Record<OperationKind, Record<string, number>>;

const PAGE_KIND: Record<string, OperationKind> = {
  inventoryBatches: 'inventory', inventoryStock: 'inventory', inventoryRecords: 'inventory', inventoryAlerts: 'inventory', inventoryExpiryAlerts: 'inventory',
  inventoryPurchase: 'inventory', inventoryRequisition: 'inventory', inventoryInbound: 'inventory', inventoryOutbound: 'inventory', inventoryLoss: 'inventory', inventoryCount: 'inventory', inventoryTransfer: 'inventory',
  memberOverview: 'members', members: 'members', memberLevels: 'members', memberTags: 'members', memberRecharge: 'members',
  promoters: 'promoters', promoterApplications: 'promoters', commissions: 'promoters', withdrawals: 'promoters', distributionRewards: 'promoters',
  marketingRules: 'campaigns', campaigns: 'campaigns', memberMarketing: 'campaigns', presales: 'campaigns', groupBuys: 'campaigns', coupons: 'campaigns', periodicCoupons: 'campaigns', couponStats: 'campaigns', pointsMall: 'campaigns',
};

const PAGE_TITLE: Record<string, string> = {
  inventoryBatches: '批次查询', inventoryStock: '库存查询', inventoryRecords: '库存记录', inventoryAlerts: '库存预警', inventoryExpiryAlerts: '保质期预警', inventoryPurchase: '采购单', inventoryRequisition: '门店要货', inventoryInbound: '入库单', inventoryOutbound: '出库单', inventoryLoss: '报损单', inventoryCount: '库存盘点', inventoryTransfer: '库存调拨',
  memberOverview: '会员统计', members: '会员列表', memberLevels: '等级管理', memberTags: '标签管理', memberRecharge: '储值记录',
  promoters: '一级分销员', promoterApplications: '待审核列表', commissions: '佣金列表', withdrawals: '提现申请', distributionRewards: '奖励任务',
  marketingRules: '优惠规则', campaigns: '活动列表', memberMarketing: '会员营销', presales: '商品预售', groupBuys: '拼团活动', coupons: '优惠券', periodicCoupons: '周期券', couponStats: '优惠券统计', pointsMall: '积分商品',
};

const ENDPOINT: Record<OperationKind, string> = { inventory: 'inventory', members: 'members', campaigns: 'campaigns', promoters: 'promoters' };

export default function MerchantOperationsPage({ page, merchantId, request }: { page: string; merchantId: string; request: Request }) {
  const kind = PAGE_KIND[page] || 'inventory';
  const [rows, setRows] = useState<RecordRow[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [keyword, setKeyword] = useState('');
  const [status, setStatus] = useState('ALL');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState<RecordRow | null>(null);
  const [open, setOpen] = useState(false);
  const [form] = Form.useForm();

  const load = useCallback(async () => {
    if (!merchantId) return;
    setLoading(true);
    try {
      const [items, totals] = await Promise.all([
        request<RecordRow[]>(`/merchant-operations/${merchantId}/${ENDPOINT[kind]}`),
        request<Summary>(`/merchant-operations/${merchantId}/summary`),
      ]);
      setRows(Array.isArray(items) ? items : []);
      setSummary(totals);
    } catch (error) { message.error((error as Error).message); }
    finally { setLoading(false); }
  }, [kind, merchantId, request]);

  useEffect(() => { void load(); }, [load]);

  const viewRows = useMemo(() => page === 'inventoryStock' ? aggregateInventory(rows) : rows, [page, rows]);
  const filteredRows = useMemo(() => viewRows.filter((row) => {
    if (page === 'inventoryAlerts' && row.status === 'NORMAL') return false;
    if (page === 'inventoryExpiryAlerts') {
      const expiresAt = row.expiresAt ? dayjs(String(row.expiresAt)) : null;
      if (!['EXPIRING', 'EXPIRED'].includes(String(row.status || '')) && (!expiresAt || expiresAt.isAfter(dayjs().add(30, 'day')))) return false;
    }
    if (page === 'coupons' && !['COUPON', 'PERIODIC_COUPON'].includes(String(row.type || ''))) return false;
    if (page === 'periodicCoupons' && row.type !== 'PERIODIC_COUPON') return false;
    if (page === 'presales' && row.type !== 'PRESALE') return false;
    if (page === 'groupBuys' && row.type !== 'GROUP_BUY') return false;
    if (page === 'memberMarketing' && row.scope !== 'MEMBER_ONLY') return false;
    if (page === 'campaigns' && ['COUPON', 'PERIODIC_COUPON', 'PRESALE', 'GROUP_BUY'].includes(String(row.type || ''))) return false;
    if (page === 'promoterApplications' && row.status !== 'PENDING') return false;
    const statusMatches = status === 'ALL' || row.status === status;
    const keywordMatches = !keyword.trim() || Object.values(row).some((value) => String(value ?? '').toLowerCase().includes(keyword.trim().toLowerCase()));
    return statusMatches && keywordMatches;
  }), [keyword, page, status, viewRows]);

  function edit(row?: RecordRow) {
    const next = row || null;
    setEditing(next);
    form.resetFields();
    form.setFieldsValue(next ? editorValues(kind, next) : defaultValues(kind, page));
    setOpen(true);
  }

  async function save(values: Record<string, unknown>, row = editing) {
    setSaving(true);
    try {
      await request(`/merchant-operations/${merchantId}/${ENDPOINT[kind]}`, { method: 'POST', body: JSON.stringify(payload(kind, values, row?.id)) });
      message.success(row ? '已保存修改' : '已新增记录');
      setOpen(false); setEditing(null); form.resetFields(); await load();
    } catch (error) { message.error((error as Error).message); }
    finally { setSaving(false); }
  }

  async function toggle(row: RecordRow, checked: boolean) {
    const nextStatus = kind === 'campaigns' ? checked ? 'ACTIVE' : 'PAUSED' : kind === 'promoters' ? checked ? 'ACTIVE' : 'DISABLED' : kind === 'members' ? checked ? 'ACTIVE' : 'INACTIVE' : checked ? 'NORMAL' : 'DISABLED';
    await save({ ...editorValues(kind, row), status: nextStatus }, row);
  }

  if (page === 'memberOverview') return <MemberOverviewDashboard rows={rows} summary={summary?.members} loading={loading} onRefresh={() => void load()} />;
  if (page === 'couponStats') return <CouponStatsDashboard rows={rows} loading={loading} onRefresh={() => void load()} />;

  return <div className="merchant-operation-page">
    <section className="operation-filter"><Input allowClear prefix={<SearchOutlined />} placeholder={`搜索${PAGE_TITLE[page] || '经营记录'}`} value={keyword} onChange={(event) => setKeyword(event.target.value)} /><Select value={status} onChange={setStatus} options={statusOptions(kind)} /><Button icon={<ReloadOutlined />} onClick={() => void load()}>刷新</Button>{!['inventoryStock', 'inventoryAlerts', 'inventoryExpiryAlerts', 'memberOverview', 'promoterApplications', 'couponStats'].includes(page) ? <Button type="primary" icon={<PlusOutlined />} onClick={() => edit()}>新增{singular(kind, page)}</Button> : <span />}</section>
    <div className="operation-metrics">{metrics(kind, summary?.[kind]).map((item) => <div className={`operation-metric ${item.tone}`} key={item.label}><Statistic title={item.label} value={item.value} /></div>)}</div>
    <section className="operation-table"><div className="operation-table-heading"><div><strong>{PAGE_TITLE[page]}</strong><span>共 {filteredRows.length} 条</span></div><Tag color="blue">{kind === 'promoters' ? '仅一级分销' : '实时经营数据'}</Tag></div><Table rowKey="id" loading={loading} size="middle" columns={columns(kind, edit, toggle, page)} dataSource={filteredRows} pagination={{ pageSize: 12, showSizeChanger: false }} scroll={{ x: 960 }} /></section>
    <Modal open={open} title={`${editing ? '编辑' : '新增'}${singular(kind, page)}`} onCancel={() => { if (!saving) setOpen(false); }} onOk={() => form.submit()} confirmLoading={saving} width={720} destroyOnHidden>
      <Form form={form} layout="vertical" onFinish={(values) => void save(values)}><EditorFields kind={kind} page={page} /></Form>
    </Modal>
  </div>;
}

function MemberOverviewDashboard({ rows, summary, loading, onRefresh }: { rows: RecordRow[]; summary?: Record<string, number>; loading: boolean; onRefresh: () => void }) {
  const total = Number(summary?.total || rows.length);
  const active = Number(summary?.active || rows.filter((row) => row.status === 'ACTIVE').length);
  const inactive = Math.max(0, total - active);
  const paid = rows.filter((row) => /金|钻|付费|年卡|月卡/.test(String(row.level || ''))).length;
  const balanceFen = Number(summary?.balanceFen || rows.reduce((sum, row) => sum + Number(row.balanceFen || 0), 0));
  const points = Number(summary?.points || rows.reduce((sum, row) => sum + Number(row.points || 0), 0));
  const levelCounts = rows.reduce<Record<string, number>>((result, row) => { const key = String(row.level || '普通会员'); result[key] = (result[key] || 0) + 1; return result; }, {});
  const growth = Array.from({ length: 30 }, (_, index) => { const day = dayjs().subtract(29 - index, 'day').format('YYYY-MM-DD'); return rows.filter((row) => String(row.createdAt || '').slice(0, 10) === day).length; });
  const maximum = Math.max(1, ...growth);
  const pointsValue = growth.map((value, index) => `${20 + index * (760 / 29)},${210 - value / maximum * 170}`).join(' ');
  return <div className="member-overview-dashboard">
    <section className="member-dashboard-heading"><div><strong>会员数量统计</strong><span>会员总量、付费状态、活跃度、储值和积分的实时汇总</span></div><Button icon={<ReloadOutlined />} loading={loading} onClick={onRefresh}>刷新</Button></section>
    <section className="member-stat-grid">
      <StatisticCard label="会员总数" value={total} />
      <StatisticCard label="付费会员" value={paid} />
      <StatisticCard label="活跃会员" value={active} />
      <StatisticCard label="流失 / 不活跃" value={inactive} />
    </section>
    <section className="member-balance-grid">
      <StatisticCard label="剩余本金" value={money(balanceFen)} />
      <StatisticCard label="会员积分" value={points} />
      <StatisticCard label="剩余总余额" value={money(balanceFen)} />
      <StatisticCard label="累计会员数" value={total} />
    </section>
    <section className="member-breakdown-grid">
      <DonutPanel title="会员等级分布" subtitle="各等级会员人数占比" segments={Object.entries(levelCounts)} total={total} />
      <DonutPanel title="会员活跃度" subtitle="活跃 / 不活跃" segments={[[`活跃 (${active})`, active], [`不活跃 (${inactive})`, inactive]]} total={total} />
      <DonutPanel title="付费类型对比" subtitle="付费会员与普通会员" segments={[[`付费 (${paid})`, paid], [`普通 (${Math.max(0, total - paid)})`, Math.max(0, total - paid)]]} total={total} />
    </section>
    <section className="member-growth-panel"><div><strong>会员增长趋势</strong><span>近 30 天每日新增会员数</span></div><svg viewBox="0 0 800 230" role="img" aria-label="近 30 天会员增长趋势"><line x1="20" x2="780" y1="210" y2="210" /><line x1="20" x2="780" y1="40" y2="40" /><polyline points={pointsValue} /><g>{growth.map((value, index) => <circle key={index} cx={20 + index * (760 / 29)} cy={210 - value / maximum * 170} r="3" />)}</g></svg></section>
  </div>;
}

function StatisticCard({ label, value }: { label: string; value: string | number }) { return <div className="member-stat-card"><span>{label}</span><strong>{value}</strong></div>; }
function DonutPanel({ title, subtitle, segments, total }: { title: string; subtitle: string; segments: Array<[string, number]>; total: number }) {
  const first = segments[0]?.[1] || 0; const degree = total > 0 ? Math.round(first / total * 360) : 0;
  return <div className="member-donut-panel"><strong>{title}</strong><span>{subtitle}</span><div className="member-donut-content"><div className="member-donut" style={{ background: `conic-gradient(#2f73f6 0 ${degree}deg, #55b78b ${degree}deg 360deg)` }}><b>{total}</b><small>会员</small></div><div>{segments.length ? segments.map(([label, value], index) => <p key={label}><i className={index ? 'green' : 'blue'} />{label}<b>{total ? Math.round(value / total * 100) : 0}%</b></p>) : <p>暂无会员数据</p>}</div></div></div>;
}

function CouponStatsDashboard({ rows, loading, onRefresh }: { rows: RecordRow[]; loading: boolean; onRefresh: () => void }) {
  const coupons = rows.filter((row) => ['COUPON', 'PERIODIC_COUPON'].includes(String(row.type || '')));
  const active = coupons.filter((row) => row.status === 'ACTIVE').length;
  const redemptions = coupons.reduce((sum, row) => sum + Number(row.redemptions || 0), 0);
  const scheduled = coupons.filter((row) => row.status === 'DRAFT' || (row.startsAt && dayjs(String(row.startsAt)).isAfter(dayjs()))).length;
  const top = [...coupons].sort((left, right) => Number(right.redemptions || 0) - Number(left.redemptions || 0)).slice(0, 8);
  return <div className="member-overview-dashboard">
    <section className="member-dashboard-heading"><div><strong>优惠券数据统计</strong><span>券模板、启用状态、领取使用和周期发放活动汇总</span></div><Button icon={<ReloadOutlined />} loading={loading} onClick={onRefresh}>刷新</Button></section>
    <section className="member-stat-grid"><StatisticCard label="券模板" value={coupons.length} /><StatisticCard label="启用中" value={active} /><StatisticCard label="累计使用" value={redemptions} /><StatisticCard label="待开始" value={scheduled} /></section>
    <section className="operation-table"><div className="operation-table-heading"><div><strong>使用排行</strong><span>按累计使用次数排序</span></div><Tag color="blue">实时活动数据</Tag></div><Table rowKey="id" loading={loading} pagination={false} dataSource={top} columns={[{ title: '优惠券', dataIndex: 'name' }, { title: '类型', dataIndex: 'type', render: campaignType }, { title: '适用范围', dataIndex: 'scope' }, { title: '累计使用', dataIndex: 'redemptions', align: 'right' }, { title: '状态', dataIndex: 'status', render: (value: string) => <Tag color={value === 'ACTIVE' ? 'green' : value === 'DRAFT' ? 'gold' : 'default'}>{statusText(value)}</Tag> }]} /></section>
  </div>;
}

function columns(kind: OperationKind, edit: (row: RecordRow) => void, toggle: (row: RecordRow, checked: boolean) => Promise<void>, page: string): ColumnsType<RecordRow> {
  const active = (status?: string) => ['NORMAL', 'ACTIVE'].includes(status || '');
  const common = [{ title: '状态', dataIndex: 'status', width: 100, render: (value: string) => <Tag color={active(value) ? 'green' : value === 'PENDING' || value === 'EXPIRING' ? 'gold' : 'default'}>{statusText(value)}</Tag> }];
  const actions = [{ title: '启用', key: 'switch', width: 76, render: (_: unknown, row: RecordRow) => <Switch size="small" checked={active(row.status)} onChange={(checked) => void toggle(row, checked)} /> }, { title: '操作', key: 'actions', fixed: 'right' as const, width: 82, render: (_: unknown, row: RecordRow) => <Button type="link" icon={<EditOutlined />} onClick={() => edit(row)}>编辑</Button> }];
  if (kind === 'inventory' && page === 'inventoryStock') return [{ title: '商品', dataIndex: 'productName', width: 220 }, { title: '货号', dataIndex: 'skuCode', width: 150 }, { title: '批次数', dataIndex: 'batchCount', align: 'right' }, { title: '账面库存', dataIndex: 'quantity', align: 'right' }, { title: '已预留', dataIndex: 'reservedQuantity', align: 'right' }, { title: '可用库存', dataIndex: 'availableQuantity', align: 'right', render: (value: number) => <strong>{value}</strong> }, { title: '库存成本', dataIndex: 'stockValueFen', align: 'right', render: money }, ...common];
  if (kind === 'inventory') return [{ title: '批次号', dataIndex: 'id', width: 150, render: (value: string) => value.slice(0, 12) }, ...common, { title: '商品', dataIndex: 'productName', width: 180 }, { title: '货号', dataIndex: 'skuCode', width: 130 }, { title: '库存', dataIndex: 'quantity', align: 'right' }, { title: '预留', dataIndex: 'reservedQuantity', align: 'right' }, { title: '成本', dataIndex: 'unitCostFen', render: money }, { title: '到期时间', dataIndex: 'expiresAt', width: 150, render: dateText }, ...actions];
  if (kind === 'members') return [{ title: '会员ID', dataIndex: 'externalCustomerId', width: 150 }, { title: '手机号', dataIndex: 'phoneMasked', width: 130 }, { title: '姓名', dataIndex: 'name' }, { title: '等级', dataIndex: 'level' }, { title: '标签', dataIndex: 'tags', render: (value: string[]) => value?.map((tag) => <Tag key={tag}>{tag}</Tag>) }, { title: '余额', dataIndex: 'balanceFen', render: money }, { title: '积分', dataIndex: 'points' }, ...common, ...actions];
  if (kind === 'campaigns') return [{ title: '活动名称', dataIndex: 'name', width: 220 }, { title: '类型', dataIndex: 'type', render: campaignType }, { title: '范围', dataIndex: 'scope' }, { title: '开始时间', dataIndex: 'startsAt', width: 150, render: dateText }, { title: '结束时间', dataIndex: 'endsAt', width: 150, render: dateText }, { title: '使用次数', dataIndex: 'redemptions' }, ...common, ...actions];
  return [{ title: '联系方式', dataIndex: 'phoneMasked', width: 140 }, { title: '分销员', dataIndex: 'name' }, { title: '佣金比例', dataIndex: 'commissionRate', render: (value: string) => `${(Number(value) * 100).toFixed(1)}%` }, { title: '累计销售', dataIndex: 'salesFen', render: money }, { title: '累计佣金', dataIndex: 'commissionFen', render: money }, ...common, ...actions];
}

function EditorFields({ kind, page }: { kind: OperationKind; page: string }) {
  if (kind === 'inventory') return <><Form.Item name="productName" label="商品名称" rules={[{ required: true }]}><Input /></Form.Item><Space className="form-row" align="start"><Form.Item name="skuCode" label="货号" rules={[{ required: true }]}><Input /></Form.Item><Form.Item name="quantity" label="库存数量" rules={[{ required: true }]}><InputNumber min={0} /></Form.Item><Form.Item name="reservedQuantity" label="预留数量"><InputNumber min={0} /></Form.Item><Form.Item name="unitCostYuan" label="成本价（元）"><InputNumber min={0} precision={2} /></Form.Item></Space><Space className="form-row" align="start"><Form.Item name="productionDate" label="生产日期"><Input type="date" /></Form.Item><Form.Item name="expiresAt" label="到期时间"><Input type="datetime-local" /></Form.Item><Form.Item name="status" label="批次状态"><Select options={statusOptions(kind).slice(1)} /></Form.Item></Space><Form.Item name="note" label="备注"><Input.TextArea rows={3} /></Form.Item></>;
  if (kind === 'members') return <><Space className="form-row" align="start"><Form.Item name="externalCustomerId" label="会员ID" rules={[{ required: true }]}><Input /></Form.Item><Form.Item name="name" label="姓名" rules={[{ required: true }]}><Input /></Form.Item><Form.Item name="phone" label="手机号"><Input /></Form.Item></Space><Space className="form-row" align="start"><Form.Item name="level" label="会员等级"><Input /></Form.Item><Form.Item name="tags" label="标签"><Select mode="tags" /></Form.Item><Form.Item name="balanceYuan" label="储值余额（元）"><InputNumber min={0} precision={2} /></Form.Item><Form.Item name="points" label="积分"><InputNumber min={0} /></Form.Item></Space><Form.Item name="status" label="状态"><Select options={statusOptions(kind).slice(1)} /></Form.Item></>;
  if (kind === 'campaigns') { const lockedType = lockedCampaignType(page); return <><Form.Item name="name" label={['coupons', 'periodicCoupons'].includes(page) ? '优惠券名称' : '活动名称'} rules={[{ required: true }]}><Input /></Form.Item>{lockedType && <Form.Item name="type" hidden><Input /></Form.Item>}<Space className="form-row" align="start">{!lockedType && <Form.Item name="type" label="活动类型" rules={[{ required: true }]}><Select options={[{ value: 'NEW_CUSTOMER', label: '新人专享' }, { value: 'ORDER_DISCOUNT', label: '订单满减' }, { value: 'PRODUCT_DISCOUNT', label: '单品折扣' }, { value: 'MEMBER_BENEFIT', label: '会员营销' }, { value: 'PRESALE', label: '商品预售' }, { value: 'GROUP_BUY', label: '拼团活动' }]} /></Form.Item>}<Form.Item name="scope" label="适用范围"><Select options={[{ value: 'ALL_PRODUCTS', label: '全部商品' }, { value: 'SELECTED_PRODUCTS', label: '指定商品' }, { value: 'MEMBER_ONLY', label: '会员专享' }]} /></Form.Item><Form.Item name="ruleValue" label={['coupons', 'periodicCoupons'].includes(page) ? '优惠面额（元）' : '优惠值'}><InputNumber min={0} /></Form.Item></Space><Space className="form-row" align="start"><Form.Item name="startsAt" label="开始时间"><Input type="datetime-local" /></Form.Item><Form.Item name="endsAt" label="结束时间"><Input type="datetime-local" /></Form.Item><Form.Item name="status" label="状态"><Select options={statusOptions(kind).slice(1)} /></Form.Item></Space></>; }
  return <><Space className="form-row" align="start"><Form.Item name="name" label="分销员姓名" rules={[{ required: true }]}><Input /></Form.Item><Form.Item name="phone" label="手机号"><Input /></Form.Item><Form.Item name="commissionPercent" label="佣金比例（%）" rules={[{ required: true }]}><InputNumber min={0} max={100} precision={2} /></Form.Item><Form.Item name="status" label="审核状态"><Select options={statusOptions(kind).slice(1)} /></Form.Item></Space><Tag color="blue">仅建立商户与分销员的一层关系，不产生上级分销链。</Tag></>;
}

function payload(kind: OperationKind, values: Record<string, unknown>, id?: string) {
  const base = id ? { id } : {};
  if (kind === 'inventory') return { ...base, productName: values.productName, skuCode: values.skuCode, quantity: values.quantity, reservedQuantity: values.reservedQuantity || 0, unitCostFen: Math.round(Number(values.unitCostYuan || 0) * 100), productionDate: values.productionDate || undefined, expiresAt: values.expiresAt ? new Date(String(values.expiresAt)).toISOString() : undefined, status: values.status, note: values.note || '' };
  if (kind === 'members') return { ...base, externalCustomerId: values.externalCustomerId, name: values.name, ...(values.phone ? { phone: values.phone } : {}), level: values.level || '普通会员', tags: values.tags || [], balanceFen: Math.round(Number(values.balanceYuan || 0) * 100), points: values.points || 0, status: values.status };
  if (kind === 'campaigns') return { ...base, name: values.name, type: values.type, scope: values.scope || 'ALL_PRODUCTS', rules: { value: Number(values.ruleValue || 0) }, startsAt: values.startsAt ? new Date(String(values.startsAt)).toISOString() : undefined, endsAt: values.endsAt ? new Date(String(values.endsAt)).toISOString() : undefined, status: values.status };
  return { ...base, name: values.name, ...(values.phone ? { phone: values.phone } : {}), commissionRate: Number(values.commissionPercent || 0) / 100, status: values.status };
}

function editorValues(kind: OperationKind, row: RecordRow) { if (kind === 'inventory') return { ...row, unitCostYuan: Number(row.unitCostFen || 0) / 100, productionDate: String(row.productionDate || ''), expiresAt: inputDate(row.expiresAt) }; if (kind === 'members') return { ...row, balanceYuan: Number(row.balanceFen || 0) / 100, phone: '' }; if (kind === 'campaigns') return { ...row, ruleValue: Number((row.rules as { value?: number })?.value || 0), startsAt: inputDate(row.startsAt), endsAt: inputDate(row.endsAt) }; return { ...row, commissionPercent: Number(row.commissionRate || 0) * 100, phone: '' }; }
function defaultValues(kind: OperationKind, page = '') { return kind === 'inventory' ? { quantity: 0, reservedQuantity: 0, unitCostYuan: 0, status: 'NORMAL' } : kind === 'members' ? { level: '普通会员', tags: [], balanceYuan: 0, points: 0, status: 'ACTIVE' } : kind === 'campaigns' ? { type: lockedCampaignType(page) || 'ORDER_DISCOUNT', scope: page === 'memberMarketing' ? 'MEMBER_ONLY' : 'ALL_PRODUCTS', status: 'DRAFT' } : { commissionPercent: 5, status: 'PENDING' }; }
function statusOptions(kind: OperationKind) { const values = kind === 'inventory' ? ['NORMAL', 'EXPIRING', 'EXPIRED', 'DISABLED'] : kind === 'members' ? ['ACTIVE', 'INACTIVE'] : kind === 'campaigns' ? ['DRAFT', 'ACTIVE', 'PAUSED', 'ENDED'] : ['PENDING', 'ACTIVE', 'DISABLED']; return [{ value: 'ALL', label: '全部状态' }, ...values.map((value) => ({ value, label: statusText(value) }))]; }
function statusText(value: string) { return ({ NORMAL: '正常', EXPIRING: '临期', EXPIRED: '过期', DISABLED: '停用', ACTIVE: '启用', INACTIVE: '不活跃', DRAFT: '草稿', PAUSED: '暂停', ENDED: '已结束', PENDING: '待审核' } as Record<string, string>)[value] || value; }
function campaignType(value: string) { return ({ NEW_CUSTOMER: '新人专享', ORDER_DISCOUNT: '订单满减', PRODUCT_DISCOUNT: '单品折扣', MEMBER_BENEFIT: '会员营销', COUPON: '优惠券', PERIODIC_COUPON: '周期券', PRESALE: '商品预售', GROUP_BUY: '拼团活动', POINTS: '积分商品' } as Record<string, string>)[value] || value; }
function singular(kind: OperationKind, page = '') { return ['coupons', 'periodicCoupons'].includes(page) ? '优惠券' : page === 'presales' ? '预售活动' : page === 'groupBuys' ? '拼团活动' : page === 'memberMarketing' ? '会员活动' : ({ inventory: '库存批次', members: '会员', campaigns: '活动', promoters: '一级分销员' } as Record<OperationKind, string>)[kind]; }
function lockedCampaignType(page: string) { return ({ coupons: 'COUPON', periodicCoupons: 'PERIODIC_COUPON', presales: 'PRESALE', groupBuys: 'GROUP_BUY', memberMarketing: 'MEMBER_BENEFIT' } as Record<string, string>)[page] || ''; }
function metrics(kind: OperationKind, values?: Record<string, number>) { const v = values || {}; if (kind === 'inventory') return [{ label: '库存批次', value: v.batchCount || 0, tone: 'blue' }, { label: '可用库存', value: v.availableQuantity || 0, tone: 'green' }, { label: '预警批次', value: v.warningCount || 0, tone: 'orange' }]; if (kind === 'members') return [{ label: '会员总数', value: v.total || 0, tone: 'blue' }, { label: '活跃会员', value: v.active || 0, tone: 'green' }, { label: '储值余额', value: money(v.balanceFen || 0), tone: 'orange' }, { label: '会员积分', value: v.points || 0, tone: 'purple' }]; if (kind === 'campaigns') return [{ label: '活动总数', value: v.total || 0, tone: 'blue' }, { label: '进行中', value: v.active || 0, tone: 'green' }, { label: '累计使用', value: v.redemptions || 0, tone: 'orange' }]; return [{ label: '分销员', value: v.total || 0, tone: 'blue' }, { label: '待审核', value: v.pending || 0, tone: 'orange' }, { label: '累计销售', value: money(v.salesFen || 0), tone: 'green' }, { label: '累计佣金', value: money(v.commissionFen || 0), tone: 'purple' }]; }
function dateText(value: unknown) { return value ? dayjs(String(value)).format('YYYY-MM-DD HH:mm') : '-'; }
function inputDate(value: unknown) { return value ? dayjs(String(value)).format('YYYY-MM-DDTHH:mm') : ''; }
function aggregateInventory(rows: RecordRow[]): RecordRow[] {
  const groups = new Map<string, RecordRow>();
  rows.forEach((row) => {
    const key = `${String(row.storeId || '')}:${String(row.skuCode || '')}`;
    const current = groups.get(key) || { id: `stock-${key}`, productName: row.productName, skuCode: row.skuCode, storeId: row.storeId, quantity: 0, reservedQuantity: 0, availableQuantity: 0, stockValueFen: 0, batchCount: 0, status: 'NORMAL' };
    const quantity = Number(row.quantity || 0);
    const reserved = Number(row.reservedQuantity || 0);
    current.quantity = Number(current.quantity || 0) + quantity;
    current.reservedQuantity = Number(current.reservedQuantity || 0) + reserved;
    current.availableQuantity = Number(current.availableQuantity || 0) + Math.max(0, quantity - reserved);
    current.stockValueFen = Number(current.stockValueFen || 0) + quantity * Number(row.unitCostFen || 0);
    current.batchCount = Number(current.batchCount || 0) + 1;
    if (row.status !== 'NORMAL') current.status = row.status;
    groups.set(key, current);
  });
  return [...groups.values()];
}
