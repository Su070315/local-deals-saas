import {
  BankOutlined, BarcodeOutlined, BellOutlined, SafetyCertificateOutlined,
  ShopOutlined, TransactionOutlined,
} from '@ant-design/icons';
import { Alert, Button, Card, Descriptions, Empty, Popconfirm, Segmented, Space, Statistic, Table, Tag, Typography } from 'antd';
import dayjs from 'dayjs';
import React, { useEffect, useState } from 'react';
import type { DashboardSummary, MerchantReadiness, MerchantReadinessState, PlatformAccessProfile, Role, TransferVoucher, User, WorkQueue } from './workspace-model';

type OverviewPageProps = {
  summary: DashboardSummary | null;
  user: User;
  workQueue: WorkQueue | null;
  merchantReadiness: MerchantReadiness | null;
  formatMoney: (fen?: number) => string;
  statusColor: (status: string) => string;
  statusText: (status: string) => string;
  canPlatform: (user: User, ...profiles: PlatformAccessProfile[]) => boolean;
  onRetryRefund: (voucherId: string) => void;
  onTransferVoucher: (voucher: TransferVoucher) => void;
  onStoreClosureRefund: (voucherId: string) => void;
  onNavigate: (target: string) => void;
  merchantId?: string;
  request: <T>(path: string, init?: RequestInit) => Promise<T>;
};

type OperationSummary = {
  inventory: { batchCount: number; availableQuantity: number; warningCount: number };
  members: { total: number; active: number; balanceFen: number; points: number };
  campaigns: { total: number; active: number; redemptions: number };
  promoters: { total: number; pending: number; salesFen: number; commissionFen: number };
};
type RangeReport = {
  summary: { paidAmountFen: number; refundedAmountFen: number; netAmountFen?: number; serviceFeeFen: number; orderCount: number; voucherCount: number; payingCustomerCount: number; refundRate: number };
  daily: Array<{ day: string; paidAmountFen: number; refundedAmountFen: number; netAmountFen?: number; orderCount: number }>;
  packages: Array<{ packageId: string; title: string; orderCount: number; paidAmountFen: number; voucherCount: number; refundAmountFen: number }>;
};

const readinessActionLabels: Record<string, string> = {
  merchants: '管理商家',
  stores: '管理可售门店',
  packages: '管理在售套餐',
  staff: '管理核销员授权',
  profile: '完善服务电话',
  template: '设置主推套餐',
  registration: '推进主体与授权',
};

export default function OverviewPage({ summary, user, workQueue, merchantReadiness, formatMoney, statusColor, statusText, canPlatform, onRetryRefund, onTransferVoucher, onStoreClosureRefund, onNavigate, merchantId, request }: OverviewPageProps) {
  const role = user.role;
  const [range, setRange] = useState('TODAY');
  const [dashboardView, setDashboardView] = useState<'WORKBENCH' | 'PRODUCT'>('WORKBENCH');
  const [operations, setOperations] = useState<OperationSummary | null>(null);
  const [rangeReport, setRangeReport] = useState<RangeReport | null>(null);
  const [trendReport, setTrendReport] = useState<RangeReport | null>(null);
  const [operationsError, setOperationsError] = useState('');
  const [reportError, setReportError] = useState('');
  useEffect(() => {
    if (!merchantId || role === 'STORE_STAFF') { setOperations(null); setOperationsError(''); return; }
    let active = true;
    request<OperationSummary>(`/merchant-operations/${merchantId}/summary`)
      .then((value) => { if (active) { setOperations(value); setOperationsError(''); } })
      .catch((error) => { if (active) setOperationsError((error as Error).message || '运营摘要加载失败'); });
    return () => { active = false; };
  }, [merchantId, request, role]);
  useEffect(() => {
    if (!merchantId || role !== 'MERCHANT_ADMIN') { setRangeReport(null); setTrendReport(null); setReportError(''); return; }
    let active = true;
    Promise.all([
      request<RangeReport>(`/reports/analytics?merchantId=${merchantId}&${reportRange(range)}`),
      request<RangeReport>(`/reports/analytics?merchantId=${merchantId}&${reportRange('MONTH')}`),
    ]).then(([current, trend]) => { if (active) { setRangeReport(current); setTrendReport(trend); setReportError(''); } })
      .catch((error) => { if (active) setReportError((error as Error).message || '经营报表加载失败'); });
    return () => { active = false; };
  }, [merchantId, range, request, role]);
  if (role === 'STORE_STAFF') {
    const staffSummary = summary && 'stores' in summary ? summary : null;
    return <><OverviewIntro role={role} /><div className="metric-grid"><Metric tone="blue" label="授权门店" value={staffSummary?.stores} suffix="家" /><Metric tone="green" label="我的核销" value={staffSummary?.verifications} suffix="笔" /></div><RoleWorkflow role={role} onNavigate={onNavigate} /></>;
  }
  const businessSummary = summary && 'merchants' in summary ? summary : null;
  const scopedToMerchant = Boolean(businessSummary?.scopeMerchantId);
  return <>
    <OverviewIntro role={role} />
    {role === 'MERCHANT_ADMIN' && <><OverviewModeTabs value={dashboardView} onChange={setDashboardView} /><TimeFilter value={range} onChange={setRange} /></>}
    {operationsError && <Alert type="error" showIcon message="运营摘要加载失败" description={operations ? `当前保留上次成功加载的数据：${operationsError}` : operationsError} />}
    {reportError && <Alert type="error" showIcon message="经营报表加载失败" description={rangeReport || trendReport ? `当前保留上次成功加载的数据：${reportError}` : reportError} />}
    {role === 'MERCHANT_ADMIN'
      ? <MerchantOverviewMetrics view={dashboardView} report={rangeReport} operations={operations} formatMoney={formatMoney} />
      : <div className="metric-grid"><Metric tone="blue" label={scopedToMerchant ? '营业额' : '权限范围商家'} value={scopedToMerchant ? formatMoney(Number(rangeReport?.summary?.netAmountFen ?? Math.max(0, Number(rangeReport?.summary.paidAmountFen || 0) - Number(rangeReport?.summary.refundedAmountFen || 0)))) : businessSummary?.merchants} suffix={scopedToMerchant ? undefined : '家'} /><Metric tone="green" label={scopedToMerchant ? '订单笔数' : '权限范围订单'} value={scopedToMerchant ? rangeReport?.summary.orderCount || 0 : businessSummary?.orders} suffix="单" /><Metric tone="orange" label={scopedToMerchant ? '退款金额' : '权限范围券'} value={scopedToMerchant ? formatMoney(rangeReport?.summary.refundedAmountFen || 0) : businessSummary?.vouchers} /><Metric tone="purple" label="会员数量" value={operations?.members.total || 0} suffix="人" /></div>}
    {role === 'MERCHANT_ADMIN' && dashboardView === 'WORKBENCH' && <MerchantDashboardBreakdown summary={businessSummary} operations={operations} formatMoney={formatMoney} onNavigate={onNavigate} />}
    {role === 'MERCHANT_ADMIN' && dashboardView === 'PRODUCT' && <MerchantProductOverview report={rangeReport} formatMoney={formatMoney} />}
    {role === 'MERCHANT_ADMIN' && <MerchantOverviewTrend daily={trendReport?.daily || []} formatMoney={formatMoney} />}
    <RoleWorkflow role={role} onNavigate={onNavigate} />
    {role !== 'MERCHANT_ADMIN' && <MerchantReadinessPanel readiness={merchantReadiness} onNavigate={onNavigate} />}
    {role === 'PLATFORM_ADMIN' && <PlatformWorkQueue queue={workQueue} user={user} formatMoney={formatMoney} statusColor={statusColor} statusText={statusText} canPlatform={canPlatform} onRetryRefund={onRetryRefund} onTransferVoucher={onTransferVoucher} onStoreClosureRefund={onStoreClosureRefund} onNavigate={onNavigate} />}
    <Card className="data-panel capability-panel" title="经营保障" variant="borderless"><Descriptions column={{ xs: 1, sm: 2, lg: 4 }}><Descriptions.Item label="交易">订单由服务端统一校验</Descriptions.Item><Descriptions.Item label="券码">动态签名与过期控制</Descriptions.Item><Descriptions.Item label="核销">单券原子化处理</Descriptions.Item><Descriptions.Item label="结算">按真实核销流水汇总</Descriptions.Item></Descriptions></Card>
  </>;
}

function OverviewModeTabs({ value, onChange }: { value: 'WORKBENCH' | 'PRODUCT'; onChange: (value: 'WORKBENCH' | 'PRODUCT') => void }) {
  return <section className="overview-mode-tabs"><Segmented value={value} options={[{ value: 'WORKBENCH', label: '工作台' }, { value: 'PRODUCT', label: '商品数据' }]} onChange={(next) => onChange(next as 'WORKBENCH' | 'PRODUCT')} /></section>;
}

function MerchantOverviewMetrics({ view, report, operations, formatMoney }: { view: 'WORKBENCH' | 'PRODUCT'; report: RangeReport | null; operations: OperationSummary | null; formatMoney: (fen?: number) => string }) {
  const summary = report?.summary;
  const refundCount = Math.round(Number(summary?.voucherCount || 0) * Number(summary?.refundRate || 0));
  // 净营业额 = 支付金额 - 退款金额（退款订单金额不再计入营业额）
  const netAmountFen = Number(summary?.netAmountFen ?? Math.max(0, Number(summary?.paidAmountFen || 0) - Number(summary?.refundedAmountFen || 0)));
  return <div className="metric-grid">
    <Metric tone="blue" label={view === 'PRODUCT' ? '成交金额（GMV）' : '营业额'} value={formatMoney(view === 'PRODUCT' ? summary?.paidAmountFen || 0 : netAmountFen)} />
    <Metric tone="green" label={view === 'PRODUCT' ? '成交件数' : '订单笔数'} value={view === 'PRODUCT' ? summary?.voucherCount || 0 : summary?.orderCount || 0} suffix={view === 'PRODUCT' ? '件' : '单'} />
    <Metric tone="orange" label={view === 'PRODUCT' ? '退款件数' : '预估毛利'} value={view === 'PRODUCT' ? refundCount : formatMoney(netAmountFen - Number(summary?.serviceFeeFen || 0))} suffix={view === 'PRODUCT' ? '件' : undefined} />
    <Metric tone="purple" label={view === 'PRODUCT' ? '退款率' : '新增会员'} value={view === 'PRODUCT' ? `${(Number(summary?.refundRate || 0) * 100).toFixed(1)}%` : operations?.members.active || 0} suffix={view === 'PRODUCT' ? undefined : '人'} />
  </div>;
}

function MerchantProductOverview({ report, formatMoney }: { report: RangeReport | null; formatMoney: (fen?: number) => string }) {
  return <Card className="data-panel overview-product-panel" variant="borderless" title="商品经营表现" extra={<Tag color="blue">按商品维度</Tag>}><Table rowKey="packageId" pagination={{ pageSize: 8, hideOnSinglePage: true }} dataSource={report?.packages || []} columns={[{ title: '商品', dataIndex: 'title' }, { title: '订单', dataIndex: 'orderCount', align: 'right' }, { title: '成交件数', dataIndex: 'voucherCount', align: 'right' }, { title: 'GMV', dataIndex: 'paidAmountFen', align: 'right', render: formatMoney }, { title: '退款金额', dataIndex: 'refundAmountFen', align: 'right', render: formatMoney }]} /></Card>;
}

function MerchantOverviewTrend({ daily, formatMoney }: { daily: RangeReport['daily']; formatMoney: (fen?: number) => string }) {
  const maxAmount = Math.max(1, ...daily.flatMap((row) => [row.paidAmountFen, row.refundedAmountFen]));
  const maxOrders = Math.max(1, ...daily.map((row) => row.orderCount));
  return <Card className="data-panel overview-trend-panel" variant="borderless" title="近 30 天趋势图" extra={<Space><Tag color="blue">净营业额</Tag><Tag color="red">退款金额</Tag><Tag color="green">订单笔数</Tag></Space>}>{daily.length ? <div className="overview-trend" role="img" aria-label="净营业额、退款金额和订单笔数趋势">{daily.map((row) => { const net = Number(row.netAmountFen ?? Math.max(0, Number(row.paidAmountFen || 0) - Number(row.refundedAmountFen || 0))); return <div className="overview-trend-day" key={row.day} title={`${row.day} 净营业额 ${formatMoney(net)}，退款 ${formatMoney(row.refundedAmountFen)}，订单 ${row.orderCount} 笔`}><div className="overview-trend-bars"><span className="sales" style={{ height: `${Math.max(net ? 4 : 0, net / maxAmount * 100)}%` }} /><span className="refund" style={{ height: `${Math.max(row.refundedAmountFen ? 4 : 0, row.refundedAmountFen / maxAmount * 100)}%` }} /><span className="orders" style={{ height: `${Math.max(row.orderCount ? 4 : 0, row.orderCount / maxOrders * 100)}%` }} /></div><small>{row.day.slice(5)}</small></div>; })}</div> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="当前区间暂无趋势数据" />}</Card>;
}

function TimeFilter({ value, onChange }: { value: string; onChange: (value: string) => void }) { const options = [['TODAY', '今日'], ['YESTERDAY', '昨日'], ['WEEK', '近七天'], ['MONTH', '近三十天'], ['CURRENT_MONTH', '本月']]; return <section className="overview-time-filter"><div><span>经营数据</span><strong>时间筛选</strong></div><Space wrap>{options.map(([key, label]) => <Button type={value === key ? 'primary' : 'default'} key={key} onClick={() => onChange(key)}>{label}</Button>)}</Space></section>; }

function reportRange(range: string) { const to = range === 'YESTERDAY' ? dayjs().subtract(1, 'day') : dayjs(); const from = range === 'TODAY' || range === 'YESTERDAY' ? to : range === 'WEEK' ? to.subtract(6, 'day') : range === 'CURRENT_MONTH' ? to.startOf('month') : to.subtract(29, 'day'); return `from=${from.format('YYYY-MM-DD')}&to=${to.format('YYYY-MM-DD')}`; }

function MerchantDashboardBreakdown({ summary, operations, formatMoney, onNavigate }: { summary: { orders?: number; vouchers?: number } | null; operations: OperationSummary | null; formatMoney: (fen?: number) => string; onNavigate: (page: string) => void }) {
  const sections = [
    { title: '订单状态', page: 'orders', items: [['全部订单', summary?.orders || 0], ['门店待处理', 0], ['用户待核销/收货', summary?.vouchers || 0], ['售后待审核', 0]] },
    { title: '客户分布', page: 'reports', items: [['下单人数', operations?.members.active || 0], ['会员总数', operations?.members.total || 0], ['储值余额', formatMoney(operations?.members.balanceFen || 0)], ['会员积分', operations?.members.points || 0]] },
    { title: '商品库存', page: 'reports', items: [['库存批次', operations?.inventory.batchCount || 0], ['可用库存', operations?.inventory.availableQuantity || 0], ['库存预警', operations?.inventory.warningCount || 0], ['活动进行中', operations?.campaigns.active || 0]] },
    { title: '分佣相关', page: 'reports', items: [['一级分销员', operations?.promoters.total || 0], ['分销员待审核', operations?.promoters.pending || 0], ['累计销售', formatMoney(operations?.promoters.salesFen || 0)], ['累计佣金', formatMoney(operations?.promoters.commissionFen || 0)]] },
  ];
  return <div className="dashboard-breakdown">{sections.map((section) => <section key={section.title}><div className="dashboard-breakdown-title"><strong>{section.title}</strong><Button type="link" onClick={() => onNavigate(section.page)}>查看详情</Button></div><div>{section.items.map(([label, value]) => <article key={String(label)}><b>{value}</b><span>{label}</span></article>)}</div></section>)}</div>;
}

function OverviewIntro({ role }: { role: Role }) {
  const title = role === 'AGENCY_ADMIN' ? '商家运营总览' : role === 'PLATFORM_ADMIN' ? '平台总览' : role === 'STORE_STAFF' ? '核销工作' : '经营数据';
  return <section className="overview-intro"><div><span>经营数据</span><h2>{title}</h2><p>数据按当前账号权限范围实时汇总</p></div><div className="overview-live"><i />实时数据<small>{dayjs().format('YYYY-MM-DD HH:mm')}</small></div></section>;
}

function MerchantReadinessPanel({ readiness, onNavigate }: { readiness: MerchantReadiness | null; onNavigate: (target: string) => void }) {
  if (!readiness) return null;
  const labels: Record<MerchantReadinessState, string> = { READY: '已就绪', WARNING: '建议处理', BLOCKED: '阻塞新售' };
  const colors: Record<MerchantReadinessState, string> = { READY: 'green', WARNING: 'gold', BLOCKED: 'red' };
  const summary = readiness.blockedCount ? `${readiness.blockedCount} 项会阻止顾客下单` : '当前没有阻塞新售的项目';
  return <section className="merchant-readiness" aria-label="商家运营检查"><div className="readiness-heading"><div><Typography.Title level={5}>商家运营检查</Typography.Title><Typography.Text type="secondary">{readiness.brandName} · {readiness.readyCount}/{readiness.totalCount} 项已就绪 · {summary}</Typography.Text></div></div><div className="readiness-grid">{readiness.checks.map((check) => {
    const actionLabel = check.action ? readinessActionLabels[check.action] || `处理${check.title}` : null;
    return <article className={`readiness-item readiness-${check.state.toLowerCase()}`} key={check.key}><div className="readiness-item-header"><Typography.Text strong>{check.title}</Typography.Text><Tag color={colors[check.state]}>{labels[check.state]}</Tag></div><Typography.Text type="secondary">{check.detail}</Typography.Text>{check.action && actionLabel && <Button type="link" size="small" aria-label={`${check.title}：${actionLabel}`} onClick={() => onNavigate(check.action!)}>{actionLabel}</Button>}</article>;
  })}</div></section>;
}

function RoleWorkflow({ role, onNavigate }: { role: Role; onNavigate: (target: string) => void }) {
  const workflows: Record<Role, { title: string; actions: Array<{ page: string; label: string; icon: React.ReactNode }> }> = {
    PLATFORM_ADMIN: { title: '平台待处理', actions: [{ page: 'merchants', label: '审核商家', icon: <ShopOutlined /> }, { page: 'registration', label: '核对开通', icon: <SafetyCertificateOutlined /> }, { page: 'bills', label: '核对账单', icon: <BankOutlined /> }] },
    AGENCY_ADMIN: { title: '商家开通与配置', actions: [{ page: 'merchants', label: '新增商家', icon: <ShopOutlined /> }, { page: 'profile', label: '填写商家资料', icon: <SafetyCertificateOutlined /> }, { page: 'stores', label: '配置门店', icon: <BankOutlined /> }, { page: 'packages', label: '配置商品', icon: <TransactionOutlined /> }] },
    MERCHANT_ADMIN: { title: '日常经营', actions: [{ page: 'orders', label: '查看订单', icon: <TransactionOutlined /> }, { page: 'vouchers', label: '查看核销', icon: <BarcodeOutlined /> }, { page: 'support', label: '处理售后', icon: <BellOutlined /> }, { page: 'reports', label: '查看经营数据', icon: <BankOutlined /> }] },
    STORE_STAFF: { title: '门店核销准备', actions: [{ page: 'stores', label: '查看授权门店', icon: <BankOutlined /> }, { page: 'verifications', label: '核对个人记录', icon: <BarcodeOutlined /> }] },
  };
  const workflow = workflows[role];
  return <section className="role-workflow" aria-label={workflow.title}><div className="workflow-heading"><Typography.Title level={5}>{workflow.title}</Typography.Title>{role === 'STORE_STAFF' && <Tag color="blue">扫码在核销助手完成</Tag>}</div><div className="workflow-actions">{workflow.actions.map((action, index) => <Button key={action.page} type={index === 0 ? 'primary' : 'default'} icon={action.icon} onClick={() => onNavigate(action.page)}>{action.label}</Button>)}</div></section>;
}

function PlatformWorkQueue({ queue, user, formatMoney, statusColor, statusText, canPlatform, onRetryRefund, onTransferVoucher, onStoreClosureRefund, onNavigate }: Pick<OverviewPageProps, 'formatMoney' | 'statusColor' | 'statusText' | 'canPlatform' | 'onRetryRefund' | 'onTransferVoucher' | 'onStoreClosureRefund' | 'onNavigate'> & { queue: WorkQueue | null; user: User }) {
  if (!queue) return null;
  const canOperate = canPlatform(user, 'OPERATIONS');
  const canManageFinance = canPlatform(user, 'FINANCE');
  return <section className="work-queue" aria-label="平台运营待办"><Typography.Title level={5}>运营待办</Typography.Title><div className="queue-grid">
    {canOperate && <><QueuePanel title="合同临期" count={queue.totals.contractsExpiring}>{queue.contractsExpiring.map((item) => <QueueItem key={item.merchantId} title={item.brandName} detail={`合同至 ${String(item.contractEndsAt).slice(0, 10)} · 剩余 ${item.daysRemaining} 天`} />)}</QueuePanel><QueuePanel title="暂停新售" count={queue.totals.salesSuspended}>{queue.salesSuspended.map((item) => <QueueItem key={item.merchantId} title={item.brandName} detail={item.contractEndsAt ? `合同至 ${String(item.contractEndsAt).slice(0, 10)}` : `最近更新 ${dayjs(item.updatedAt).format('MM-DD HH:mm')}`} />)}</QueuePanel><QueuePanel title="待发布套餐" count={queue.totals.draftPackages}>{queue.draftPackages.map((item) => <QueueItem key={item.packageId} title={item.title} detail={`${item.brandName} · 更新于 ${dayjs(item.updatedAt).format('MM-DD HH:mm')}`} />)}</QueuePanel></>}
    {canManageFinance && <><QueuePanel title="账单待处理" count={queue.totals.billsRequiringAttention}>{queue.billsRequiringAttention.map((item) => <QueueItem key={item.billId} title={`${item.brandName} · ${item.period}`} detail={<><Tag color={statusColor(item.status)}>{statusText(item.status)}</Tag> {formatMoney(item.serviceFeeFen)} · {item.status === 'DISPUTED' ? '等待平台处理' : `截止 ${dayjs(item.status === 'DISPUTE_WINDOW' ? item.disputeEndsAt : item.dueAt).format('MM-DD')}`}</>} />)}</QueuePanel><QueuePanel title="退款待确认" count={queue.totals.failedRefunds}>{queue.failedRefunds.map((item) => <QueueItem key={item.refundId} title={item.brandName} detail={`${formatMoney(item.amountFen)} · 已尝试 ${item.attemptCount} 次 · 最近尝试 ${dayjs(item.lastAttemptAt || item.createdAt).format('MM-DD HH:mm')}`} action={<Popconfirm title="重新确认这笔退款？" description="系统会复用原退款幂等键，不会重复退款。" onConfirm={() => onRetryRefund(item.voucherId)}><Button type="link" size="small">重新确认退款</Button></Popconfirm>} />)}</QueuePanel></>}
    {(canOperate || canManageFinance) && <QueuePanel title="停止履约待处理" count={queue.totals.closedStoreVouchers}>{queue.closedStoreVouchers.map((item) => <QueueItem key={item.voucherId} title={`${item.brandName} · ${item.storeName}`} detail={`券 ${item.code} · ${formatMoney(item.faceValueFen)} · 有效至 ${dayjs(item.validTo).format('MM-DD')}`} action={<Space size={4}>{canOperate && <Button type="link" size="small" onClick={() => onTransferVoucher({ id: item.voucherId, merchantId: item.merchantId, code: item.code, storeId: item.storeId, faceValueFen: item.faceValueFen })}>转移门店</Button>}{canManageFinance && <Popconfirm title="按停止履约补偿退款？" description="退款后该券立即失效，系统会使用当前支付适配器处理。" okButtonProps={{ danger: true }} onConfirm={() => onStoreClosureRefund(item.voucherId)}><Button type="link" danger size="small">补偿退款</Button></Popconfirm>}</Space>} />)}</QueuePanel>}
    {canOperate && <QueuePanel title="售后首响超时" count={queue.totals.supportFirstResponseOverdue}>{queue.supportFirstResponseOverdue.map((item) => <QueueItem key={item.ticketId} title={item.brandName} detail={`应于 ${dayjs(item.firstResponseDueAt).format('MM-DD HH:mm')} 前首次响应`} action={<Button type="link" size="small" onClick={() => onNavigate('support')}>处理工单</Button>} />)}</QueuePanel>}
  </div></section>;
}

function QueuePanel({ title, count, children }: { title: string; count: number; children: React.ReactNode }) { return <Card className="queue-panel" title={<Space size={8}>{title}<Tag>{count}</Tag></Space>} variant="borderless">{React.Children.count(children) ? <div className="queue-list">{children}</div> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无待办" />}</Card>; }
function QueueItem({ title, detail, action }: { title: string; detail: React.ReactNode; action?: React.ReactNode }) { return <div className="queue-item"><Typography.Text strong ellipsis={{ tooltip: title }}>{title}</Typography.Text><Typography.Text type="secondary">{detail}</Typography.Text>{action}</div>; }
function Metric({ label, value, suffix, tone }: { label: string; value: string | number | null | undefined; suffix?: string; tone: 'blue' | 'green' | 'orange' | 'purple' }) { return <Card variant="borderless" className={`metric metric-${tone}`}><Statistic title={label} value={value ?? 0} suffix={suffix} /></Card>; }
