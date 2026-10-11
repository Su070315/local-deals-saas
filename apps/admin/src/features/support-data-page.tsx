import { Button, Space, Tag, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import dayjs from 'dayjs';
import { DataTable } from './data-table-shell';
import type { TablePaging } from './data-table-shell';
import type { SupportTicket, User } from './workspace-model';
import { platformCan, statusColor, statusText } from './workspace-model';

export type SupportDataPageProps = {
  data: unknown[];
  user: User;
  paging: TablePaging;
  onReply: (ticket: SupportTicket) => void;
  onResolve: (ticket: SupportTicket) => void;
  onExceptionRefundReview: (ticket: SupportTicket, approved: boolean) => void;
  onExceptionRefundExecute: (ticket: SupportTicket) => void;
};

export default function SupportDataPage(props: SupportDataPageProps) {
  const columns: ColumnsType<SupportTicket> = [
    { title: '提交时间', dataIndex: 'createdAt', render: (value) => dayjs(value).format('YYYY-MM-DD HH:mm') },
    { title: '类型', dataIndex: 'type', render: (value) => <Tag color={value === 'EXCEPTION_REFUND' ? 'purple' : 'blue'}>{value === 'EXCEPTION_REFUND' ? '异常退款申请' : '顾客售后'}</Tag> },
    { title: '关联券', dataIndex: 'voucherId', render: (value) => value ? String(value).slice(0, 8) : '-' },
    { title: '问题描述', dataIndex: 'content', render: (value) => <Typography.Text ellipsis={{ tooltip: value }} style={{ maxWidth: 260 }}>{value}</Typography.Text> },
    ...(props.user.role === 'PLATFORM_ADMIN' && platformCan(props.user, 'OPERATIONS') ? [{ title: '联系电话', dataIndex: 'contactPhone', render: (value: string | null | undefined) => value || '-' } as ColumnsType<SupportTicket>[number]] : []),
    {
      title: '首次响应',
      render: (_, record) => record.type !== 'GENERAL' ? '-' : record.firstRespondedAt
        ? <Tag color="green">{dayjs(record.firstRespondedAt).format('MM-DD HH:mm')}</Tag>
        : record.firstResponseDueAt && dayjs(record.firstResponseDueAt).isBefore(dayjs())
          ? <Tag color="red">已超时</Tag>
          : record.firstResponseDueAt ? <Tag color="gold">截止 {dayjs(record.firstResponseDueAt).format('MM-DD HH:mm')}</Tag> : '-',
    },
    { title: '退款审批', render: (_, record) => record.type === 'EXCEPTION_REFUND' ? <Tag color={statusColor(record.exceptionRefundApprovalStatus || 'PENDING_REVIEW')}>{statusText(record.exceptionRefundApprovalStatus || 'PENDING_REVIEW')}</Tag> : '-' },
    { title: '回复', render: (_, record) => record.replyCount ? `${record.replyCount} 条${record.latestReplyAt ? ` · ${dayjs(record.latestReplyAt).format('MM-DD HH:mm')}` : ''}` : '-' },
    { title: '状态', dataIndex: 'status', render: (value) => <Tag color={statusColor(value)}>{statusText(value)}</Tag> },
    { title: '处理说明', dataIndex: 'resolutionNote', render: (value) => value || '-' },
    { title: '操作', render: (_, record) => supportActions(props, record) },
  ];
  return <DataTable data={props.data as SupportTicket[]} columns={columns} paging={props.paging} />;
}

function supportActions(props: SupportDataPageProps, record: SupportTicket) {
  if (record.status !== 'OPEN') return <Typography.Text type="secondary">-</Typography.Text>;
  if (record.type !== 'EXCEPTION_REFUND') return <Space size={4}><Button size="small" onClick={() => props.onReply(record)}>回复</Button><Button size="small" type="primary" onClick={() => props.onResolve(record)}>回复并结案</Button></Space>;
  if (props.user.role !== 'PLATFORM_ADMIN' || !platformCan(props.user, 'FINANCE')) return <Typography.Text type="secondary">待平台财务处理</Typography.Text>;
  if (record.exceptionRefundApprovalStatus === 'PENDING_REVIEW') return <Space size={4}><Button size="small" type="primary" onClick={() => props.onExceptionRefundReview(record, true)}>批准退款</Button><Button size="small" danger onClick={() => props.onExceptionRefundReview(record, false)}>驳回</Button></Space>;
  if (record.exceptionRefundApprovalStatus !== 'APPROVED') return <Typography.Text type="secondary">已处理</Typography.Text>;
  return record.exceptionRefundApprovedBy === props.user.id
    ? <Typography.Text type="secondary">待其他财务执行</Typography.Text>
    : <Button size="small" danger onClick={() => props.onExceptionRefundExecute(record)}>执行退款</Button>;
}
