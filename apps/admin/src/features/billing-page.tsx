import { Card, Empty, Space, Table, Tag, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import dayjs from 'dayjs';
import type { MonthlyBill } from './workspace-model';
import { money, statusColor, statusText } from './workspace-model';

type BillingPageProps = {
  data: MonthlyBill[];
};

/** Legacy monthly bills are retained only as read-only operational evidence. */
export function BillingPage({ data }: BillingPageProps) {
  const columns: ColumnsType<MonthlyBill> = [
    { title: '账期', dataIndex: 'period' },
    { title: '核销金额', dataIndex: 'verifiedAmountFen', render: money },
    { title: '待结算服务费', dataIndex: 'serviceFeeFen', render: money },
    { title: '状态', dataIndex: 'status', render: (value) => <Tag color={statusColor(value)}>{statusText(value)}</Tag> },
    {
      title: '申诉',
      render: (_, record) => record.dispute
        ? <Space direction="vertical" size={0}><Tag color={statusColor(record.dispute.status)}>{statusText(record.dispute.status)}</Tag><Typography.Text ellipsis={{ tooltip: record.dispute.resolutionNote || record.dispute.content }} style={{ maxWidth: 220 }}>{record.dispute.resolutionNote || '等待平台处理'}</Typography.Text></Space>
        : '-',
    },
    {
      title: '收款复核',
      render: (_, record) => record.paymentConfirmationRequest
        ? <Space direction="vertical" size={0}><Tag color={statusColor(record.paymentConfirmationRequest.status)}>{statusText(record.paymentConfirmationRequest.status)}</Tag><Typography.Text ellipsis={{ tooltip: record.paymentConfirmationRequest.reviewNote || record.paymentConfirmationRequest.note }}>{record.paymentConfirmationRequest.reviewNote || record.paymentConfirmationRequest.note}</Typography.Text></Space>
        : '-',
    },
    { title: '开票状态', dataIndex: 'invoiceStatus', render: (value) => <Tag color={statusColor(value || 'PENDING')}>{statusText(value || 'PENDING')}</Tag> },
    { title: '发票号码', dataIndex: 'invoiceNumber', render: (value) => value || '-' },
    { title: '申诉截止', dataIndex: 'disputeEndsAt', render: (value) => dayjs(value).format('YYYY-MM-DD') },
  ];

  return <Card className="data-panel" variant="borderless">
    {data.length
      ? <Table rowKey="id" columns={columns} dataSource={data} pagination={{ pageSize: 10, showSizeChanger: false }} scroll={{ x: 880 }} />
      : <Empty description="暂无数据" />}
  </Card>;
}

export default BillingPage;
