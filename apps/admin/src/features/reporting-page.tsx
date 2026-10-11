import { Alert, Card, Empty, Progress, Space, Table, Tag, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import type { ReportAnalytics } from './workspace-model';
import { money } from './workspace-model';
import { Metric } from './workspace-widgets';

// 净营业额字段由后端新增（generated api-contract 尚未同步），此处做最小类型扩展，避免依赖重新生成
type AnalyticsRow = ReportAnalytics['daily'][number] & { netAmountFen?: number };
type AnalyticsSummary = ReportAnalytics['summary'] & { netAmountFen?: number };

const percent = (value: number) => `${(value * 100).toFixed(1)}%`;

export function ReportingPage({ report }: { report: ReportAnalytics | null }) {
  if (!report) return <Empty description="暂无经营数据" />;
  const raw = report as Partial<ReportAnalytics>;
  const summary = raw.summary as AnalyticsSummary | undefined;
  const daily = (Array.isArray(raw.daily) ? raw.daily : []) as AnalyticsRow[];
  const stores = Array.isArray(raw.stores) ? raw.stores : [];
  const packages = Array.isArray(raw.packages) ? raw.packages : [];
  const alerts = Array.isArray(raw.alerts) ? raw.alerts : [];
  const range = raw.range || { from: '-', to: '-' };
  const values = {
    paidAmountFen: Number(summary?.paidAmountFen || 0),
    refundedAmountFen: Number(summary?.refundedAmountFen || 0),
    netAmountFen: Number(summary?.netAmountFen ?? Math.max(0, Number(summary?.paidAmountFen || 0) - Number(summary?.refundedAmountFen || 0))),
    verifiedAmountFen: Number(summary?.verifiedAmountFen || 0),
    serviceFeeFen: Number(summary?.serviceFeeFen || 0),
    orderCount: Number(summary?.orderCount || 0),
    voucherCount: Number(summary?.voucherCount || 0),
    payingCustomerCount: Number(summary?.payingCustomerCount || 0),
    repeatCustomerCount: Number(summary?.repeatCustomerCount || 0),
    verificationRate: Number(summary?.verificationRate || 0),
    refundRate: Number(summary?.refundRate || 0),
  };
  const maxDailyAmount = Math.max(1, ...daily.flatMap((row) => [row.netAmountFen ?? Math.max(0, Number(row.paidAmountFen || 0) - Number(row.refundedAmountFen || 0)), row.verifiedAmountFen]));
  const storeColumns: ColumnsType<ReportAnalytics['stores'][number]> = [
    { title: '门店', dataIndex: 'storeName' },
    { title: '订单', dataIndex: 'orderCount', align: 'right' },
    { title: '净营业额', align: 'right', render: (_, row) => money(Number(row.paidAmountFen || 0) - Number(row.refundAmountFen || 0)) },
    { title: '支付金额', dataIndex: 'paidAmountFen', align: 'right', render: money },
    { title: '核销', dataIndex: 'verificationCount', align: 'right' },
    { title: '核销金额', dataIndex: 'verifiedAmountFen', align: 'right', render: money },
    { title: '退款金额', dataIndex: 'refundAmountFen', align: 'right', render: money },
  ];
  const packageColumns: ColumnsType<ReportAnalytics['packages'][number]> = [
    { title: '套餐', dataIndex: 'title' },
    { title: '订单', dataIndex: 'orderCount', align: 'right' },
    { title: '售券', dataIndex: 'voucherCount', align: 'right' },
    { title: '净营业额', align: 'right', render: (_, row) => money(Number(row.paidAmountFen || 0) - Number(row.refundAmountFen || 0)) },
    { title: '支付金额', dataIndex: 'paidAmountFen', align: 'right', render: money },
    { title: '核销', dataIndex: 'verificationCount', align: 'right' },
    { title: '退款金额', dataIndex: 'refundAmountFen', align: 'right', render: money },
  ];
  const repeatRate = values.payingCustomerCount ? values.repeatCustomerCount / values.payingCustomerCount : 0;

  return <div className="reporting-page">
    <div className="report-range"><Typography.Text strong>{range.from} 至 {range.to}</Typography.Text><Typography.Text type="secondary">按中国标准时间统计</Typography.Text></div>
    {alerts.map((alert) => <Alert key={alert.code} type={alert.severity === 'WARNING' ? 'warning' : 'info'} showIcon message={alert.title} description={alert.detail} />)}
    <div className="metric-grid report-metrics">
      <Metric label="净营业额" value={money(values.netAmountFen)} />
      <Metric label="支付金额" value={money(values.paidAmountFen)} />
      <Metric label="退款金额" value={money(values.refundedAmountFen)} />
      <Metric label="核销金额" value={money(values.verifiedAmountFen)} />
      <Metric label="待结算服务费" value={money(values.serviceFeeFen)} />
      <Metric label="支付订单" value={values.orderCount} />
      <Metric label="售出券" value={values.voucherCount} />
      <Metric label="支付顾客" value={values.payingCustomerCount} />
      <Metric label="复购顾客" value={values.repeatCustomerCount} />
    </div>
    <div className="report-rate-grid">
      <Card variant="borderless" title="核销率"><Progress percent={values.verificationRate * 100} format={() => percent(values.verificationRate)} strokeColor="#087f5b" /></Card>
      <Card variant="borderless" title="退款率"><Progress percent={values.refundRate * 100} format={() => percent(values.refundRate)} status={values.refundRate > 0.2 ? 'exception' : 'normal'} strokeColor={values.refundRate > 0.2 ? undefined : '#d97706'} /></Card>
      <Card variant="borderless" title="复购率"><Progress percent={repeatRate * 100} format={() => percent(repeatRate)} strokeColor="#2563eb" /></Card>
    </div>
    <Card className="data-panel report-trend-panel" variant="borderless" title="每日金额趋势" extra={<Space size={12}><Tag color="blue">净营业额</Tag><Tag color="green">核销</Tag></Space>}>
      {daily.length ? <div className="report-trend" role="img" aria-label="每日净营业额和核销金额趋势">{daily.map((row) => { const net = Number(row.netAmountFen ?? Math.max(0, Number(row.paidAmountFen || 0) - Number(row.refundedAmountFen || 0))); return <div className="report-trend-day" key={row.day} title={`${row.day} 净营业额 ${money(net)}，核销 ${money(row.verifiedAmountFen)}`}><div className="report-bars"><span className="report-bar paid" style={{ height: `${Math.max(net ? 3 : 0, net / maxDailyAmount * 100)}%` }} /><span className="report-bar verified" style={{ height: `${Math.max(row.verifiedAmountFen ? 3 : 0, row.verifiedAmountFen / maxDailyAmount * 100)}%` }} /></div><Typography.Text type="secondary">{row.day.slice(5)}</Typography.Text></div>; })}</div> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="当前区间暂无交易" />}
    </Card>
    <div className="report-comparison-grid">
      <Card className="data-panel" variant="borderless" title="门店对比"><Table rowKey="storeId" size="small" columns={storeColumns} dataSource={stores} pagination={false} scroll={{ x: 720 }} locale={{ emptyText: '暂无门店数据' }} /></Card>
      <Card className="data-panel" variant="borderless" title="套餐对比"><Table rowKey="packageId" size="small" columns={packageColumns} dataSource={packages} pagination={{ pageSize: 8, hideOnSinglePage: true }} scroll={{ x: 720 }} locale={{ emptyText: '暂无套餐数据' }} /></Card>
    </div>
  </div>;
}
