import { EditOutlined, EyeOutlined, PlusOutlined, ReloadOutlined, SearchOutlined } from '@ant-design/icons';
import { Alert, Button, Form, Input, InputNumber, Modal, Space, Switch, Table, Tag, message } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import dayjs from 'dayjs';
import { useCallback, useEffect, useMemo, useState } from 'react';

type Request = <T>(path: string, init?: RequestInit) => Promise<T>;
type Setting = { id: string; type: string; name: string; description: string; config?: { value?: string }; status: string; sortOrder: number; updatedAt: string };
const PAGE_CONFIG: Record<string, { type: string; title: string; singular: string; valueLabel: string; mall?: boolean; records?: boolean }> = {
  productCategories: { type: 'PRODUCT_CATEGORY', title: '商品分类', singular: '分类', valueLabel: '上级分类' },
  productSpecs: { type: 'PRODUCT_SPEC', title: '规格管理', singular: '规格', valueLabel: '规格值（使用逗号分隔）' },
  productTags: { type: 'PRODUCT_TAG', title: '商品标签', singular: '标签', valueLabel: '标签样式' },
  productGuarantees: { type: 'PRODUCT_GUARANTEE', title: '商品保障', singular: '保障项', valueLabel: '顾客端展示文案' },
  productParameters: { type: 'PRODUCT_PARAMETER', title: '商品参数', singular: '参数', valueLabel: '参数默认值/可选值' },
  productGroups: { type: 'PRODUCT_GROUP_PACKAGE', title: '组合套餐', singular: '组合套餐', valueLabel: '包含商品/组合价/库存策略' },
  productReviews: { type: 'PRODUCT_REVIEW', title: '商品评价', singular: '评价记录', valueLabel: '订单/星级/商家回复', records: true },
  productReviewSettings: { type: 'PRODUCT_REVIEW_SETTING', title: '评价设置', singular: '评价规则', valueLabel: '自动评价/展示/追评规则' },
  memberLevels: { type: 'MEMBER_LEVEL', title: '会员等级', singular: '等级', valueLabel: '升级门槛/权益' },
  memberTags: { type: 'MEMBER_TAG', title: '会员标签', singular: '标签', valueLabel: '标签规则' },
  memberPaidPlans: { type: 'MEMBER_PAID_PLAN', title: '付费会员套餐', singular: '付费套餐', valueLabel: '价格/时长/订阅奖励' },
  memberRechargeRules: { type: 'MEMBER_RECHARGE_RULE', title: '储值规则', singular: '储值规则', valueLabel: '充值金额/赠送金额/积分/卡券' },
  distributionLevels: { type: 'DISTRIBUTION_LEVEL', title: '分销员等级', singular: '分销等级', valueLabel: '晋升门槛/一级佣金比例' },
  distributionRewards: { type: 'DISTRIBUTION_REWARD', title: '分销奖励任务', singular: '奖励任务', valueLabel: '达成条件/奖励' },
  distributionRecommendationRewards: { type: 'DISTRIBUTION_RECOMMENDATION_REWARD', title: '推荐奖励', singular: '推荐奖励规则', valueLabel: '直接推荐订单返利/结算时间/奖励对象' },
  distributionRecruitment: { type: 'DISTRIBUTION_RECRUITMENT', title: '分销招募设置', singular: '招募配置', valueLabel: '准入条件/申请表单' },
  distributionWithdrawalSettings: { type: 'DISTRIBUTION_WITHDRAWAL_SETTING', title: '提现设置', singular: '提现规则', valueLabel: '提现门槛/单次上限/每日次数' },
  inventorySuppliers: { type: 'INVENTORY_SUPPLIER', title: '供应商管理', singular: '供应商', valueLabel: '联系人/电话/结算方式' },
  inventoryExpirySettings: { type: 'INVENTORY_EXPIRY_SETTING', title: '保质期设置', singular: '效期规则', valueLabel: '临期预警天数/过期处理' },
  inventoryOutboundRules: { type: 'INVENTORY_OUTBOUND_RULE', title: '出库规则', singular: '出库规则', valueLabel: '批次选择策略/适用门店' },
  inventoryTransferDisputes: { type: 'INVENTORY_TRANSFER_DISPUTE', title: '调拨争议', singular: '争议记录', valueLabel: '关联调拨单/处理结论' },
  marketingRules: { type: 'MARKETING_RULE', title: '优惠规则', singular: '规则', valueLabel: '优惠条件' },
  smsTemplates: { type: 'MARKETING_SMS_TEMPLATE', title: '短信模板', singular: '短信模板', valueLabel: '腾讯云模板 ID/变量说明' },
  smsProviderRules: { type: 'MARKETING_SMS_PROVIDER', title: '短信发送规则', singular: '发送规则', valueLabel: '触发场景/频控/发送时段' },
  smsRecords: { type: 'MARKETING_SMS_RECORD', title: '短信发送记录', singular: '发送记录', valueLabel: '任务编号/发送结果', records: true },
  marketingMaterials: { type: 'MARKETING_MATERIAL', title: '内容素材', singular: '营销素材', valueLabel: 'COS 对象地址/素材类型' },
  marketingPublish: { type: 'MARKETING_PUBLISH_CHANNEL', title: '内容投放', singular: '投放计划', valueLabel: '渠道/发布时间/目标人群' },
  groupInstances: { type: 'MARKETING_GROUP_INSTANCE', title: '拼团实例', singular: '拼团实例', valueLabel: '活动/团长/成团进度', records: true },
  pointsExchanges: { type: 'POINTS_EXCHANGE', title: '积分兑换记录', singular: '兑换记录', valueLabel: '会员/积分/履约状态', records: true },
  couponDistributionRecords: { type: 'COUPON_DISTRIBUTION', title: '领券与核销记录', singular: '发券记录', valueLabel: '会员/券码/使用状态', records: true },
  systemMessages: { type: 'STORE_SYSTEM_MESSAGE', title: '系统消息', singular: '消息模板', valueLabel: '触发事件/接收角色' },
  deliveryPlans: { type: 'STORE_DELIVERY_PLAN', title: '门店配送方案', singular: '配送方案', valueLabel: '配送范围/时段/起送价' },
  freightRules: { type: 'STORE_FREIGHT_RULE', title: '运费规则', singular: '运费规则', valueLabel: '计费范围/首重/续重或距离' },
  expressRules: { type: 'STORE_EXPRESS_RULE', title: '快递100配置', singular: '快递规则', valueLabel: '快递公司/电子面单/回调策略' },
  pointsMall: { type: 'POINTS_PRODUCT', title: '积分商品', singular: '积分商品', valueLabel: '兑换积分/库存' },
  mallPages: { type: 'MALL_PAGE', title: '商城页面', singular: '页面', valueLabel: '页面类型', mall: true },
  mallSystemPages: { type: 'MALL_SYSTEM_PAGE', title: '系统页面', singular: '系统页', valueLabel: '系统页面类型', mall: true },
  mallMemberCenter: { type: 'MALL_MEMBER_CENTER', title: '个人中心', singular: '个人中心模块', valueLabel: '模块类型/跳转目标', mall: true },
  mallCategoryLayout: { type: 'MALL_CATEGORY_LAYOUT', title: '分类布局', singular: '分类布局', valueLabel: '布局模式/每行数量', mall: true },
  mallRoles: { type: 'MALL_ROLE', title: '商城角色权限', singular: '角色', valueLabel: '角色/页面权限/操作范围' },
  mallMaterials: { type: 'MALL_MATERIAL', title: '素材库', singular: '素材', valueLabel: 'COS 对象地址', mall: true },
  mallThemes: { type: 'MALL_THEME', title: '主题换肤', singular: '主题', valueLabel: '主题色', mall: true },
};

export default function MerchantSettingsPage({ page, merchantId, request }: { page: string; merchantId: string; request: Request }) {
  const config = PAGE_CONFIG[page];
  const [rows, setRows] = useState<Setting[]>([]);
  const [keyword, setKeyword] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState<Setting | null>(null);
  const [preview, setPreview] = useState<Setting | null>(null);
  const [open, setOpen] = useState(false);
  const [form] = Form.useForm();

  const load = useCallback(async () => {
    setLoading(true);
    try { const result = await request<Setting[]>(`/merchant-operations/${merchantId}/settings/${config.type}`); setRows(Array.isArray(result) ? result : []); }
    catch (error) { message.error((error as Error).message); }
    finally { setLoading(false); }
  }, [config.type, merchantId, request]);
  useEffect(() => { void load(); }, [load]);

  const data = useMemo(() => rows.filter((row) => !keyword.trim() || `${row.name} ${row.description} ${row.config?.value || ''}`.toLowerCase().includes(keyword.trim().toLowerCase())), [keyword, rows]);

  function edit(row?: Setting) {
    setEditing(row || null); form.resetFields();
    form.setFieldsValue(row ? { ...row, value: row.config?.value || '', enabled: ['ACTIVE', 'PUBLISHED'].includes(row.status) } : { enabled: !config.mall, sortOrder: rows.length });
    setOpen(true);
  }

  async function save(values: Record<string, unknown>, row = editing) {
    setSaving(true);
    try {
      const nextStatus = typeof values.status === 'string' ? values.status : config.mall ? values.enabled ? 'PUBLISHED' : 'DRAFT' : values.enabled ? 'ACTIVE' : 'DISABLED';
      await request(`/merchant-operations/${merchantId}/settings`, { method: 'POST', body: JSON.stringify({ ...(row ? { id: row.id } : {}), type: config.type, name: values.name, description: values.description || '', config: { value: values.value || '' }, status: nextStatus, sortOrder: values.sortOrder || 0 }) });
      message.success(row ? '配置已保存' : `${config.singular}已新增`); setOpen(false); setEditing(null); await load();
    } catch (error) { message.error((error as Error).message); }
    finally { setSaving(false); }
  }

  async function toggle(row: Setting, checked: boolean) { await save({ ...row, value: row.config?.value || '', status: config.mall ? checked ? 'PUBLISHED' : 'DRAFT' : checked ? 'ACTIVE' : 'DISABLED' }, row); }

  const columns: ColumnsType<Setting> = [
    { title: '名称', dataIndex: 'name', width: 220 },
    { title: config.valueLabel, dataIndex: ['config', 'value'], width: 240, render: (value: string) => value || '-' },
    { title: '说明', dataIndex: 'description', ellipsis: true },
    { title: '排序', dataIndex: 'sortOrder', width: 80, align: 'right' },
    { title: '状态', dataIndex: 'status', width: 100, render: (value: string) => <Tag color={['ACTIVE', 'PUBLISHED'].includes(value) ? 'green' : value === 'DRAFT' ? 'gold' : 'default'}>{statusText(value)}</Tag> },
    { title: config.mall ? '发布' : '启用', width: 76, render: (_: unknown, row: Setting) => <Switch size="small" checked={['ACTIVE', 'PUBLISHED'].includes(row.status)} onChange={(checked) => void toggle(row, checked)} /> },
    { title: '更新时间', dataIndex: 'updatedAt', width: 150, render: (value: string) => value ? dayjs(value).format('YYYY-MM-DD HH:mm') : '-' },
    { title: '操作', fixed: 'right', width: config.mall ? 150 : 82, render: (_: unknown, row: Setting) => <Space size={0}>{config.mall && <Button type="link" icon={<EyeOutlined />} onClick={() => setPreview(row)}>预览</Button>}<Button type="link" icon={<EditOutlined />} onClick={() => edit(row)}>编辑</Button></Space> },
  ];

  return <div className="merchant-settings-page">
    {page === 'smsProviderRules' && <Alert showIcon type="info" message="此处只维护业务发送规则" description="腾讯云 SecretId、SecretKey、SDK AppID 和短信签名必须由运维配置到服务器环境变量，禁止填写在名称、说明或规则内容中。" />}
    <section className="operation-filter"><Input allowClear prefix={<SearchOutlined />} placeholder={`搜索${config.title}`} value={keyword} onChange={(event) => setKeyword(event.target.value)} /><span /><Button icon={<ReloadOutlined />} onClick={() => void load()}>刷新</Button>{config.records ? <span /> : <Button type="primary" icon={<PlusOutlined />} onClick={() => edit()}>新增{config.singular}</Button>}</section>
    {config.mall && <section className="mall-summary"><div><strong>{config.title}</strong><span>配置后可预览，确认无误再发布；修改草稿不会影响当前已发布版本。</span></div><div><b>{rows.filter((row) => row.status === 'PUBLISHED').length}</b><span>已发布</span></div><div><b>{rows.filter((row) => row.status === 'DRAFT').length}</b><span>草稿</span></div></section>}
    <section className="operation-table"><div className="operation-table-heading"><div><strong>{config.title}</strong><span>共 {data.length} 条</span></div><Tag color="blue">{config.records ? '业务记录' : '商户独立配置'}</Tag></div><Table rowKey="id" loading={loading} size="middle" columns={columns} dataSource={data} pagination={false} scroll={{ x: 980 }} /></section>
    <Modal open={open} title={`${editing ? '编辑' : '新增'}${config.singular}`} onCancel={() => { if (!saving) setOpen(false); }} onOk={() => form.submit()} confirmLoading={saving} destroyOnHidden><Form form={form} layout="vertical" onFinish={(values) => void save(values)}><Form.Item name="name" label="名称" rules={[{ required: true, message: `请输入${config.singular}名称` }]}><Input /></Form.Item><Form.Item name="value" label={config.valueLabel}><Input placeholder={page === 'mallThemes' ? '#1554d1' : undefined} /></Form.Item><Form.Item name="description" label="说明"><Input.TextArea rows={3} /></Form.Item><Space className="form-row"><Form.Item name="sortOrder" label="排序"><InputNumber min={0} /></Form.Item><Form.Item name="enabled" label="状态" valuePropName="checked"><Switch checkedChildren={config.mall ? '已发布' : '启用'} unCheckedChildren={config.mall ? '草稿' : '停用'} /></Form.Item></Space></Form></Modal>
    <Modal open={Boolean(preview)} title="商城效果预览" footer={null} onCancel={() => setPreview(null)} width={430}><div className="mall-phone-preview"><div className="mall-phone-bar">示例商城</div><div className="mall-phone-cover" style={page === 'mallThemes' && preview?.config?.value ? { background: preview.config.value } : undefined}>{preview?.name}</div><div className="mall-phone-content"><strong>{preview?.name}</strong><p>{preview?.description || '商城页面内容预览'}</p><Tag color="blue">{preview?.config?.value || config.valueLabel}</Tag></div></div></Modal>
  </div>;
}

function statusText(value: string) { return ({ ACTIVE: '启用', DISABLED: '停用', DRAFT: '草稿', PUBLISHED: '已发布' } as Record<string, string>)[value] || value; }
