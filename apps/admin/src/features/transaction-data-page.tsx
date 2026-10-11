import { Button, Popconfirm, Space, Tag, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import dayjs from 'dayjs';
import { DataTable } from './data-table-shell';
import type { TablePaging } from './data-table-shell';
import type { OrderRecord, Store, TransferVoucher, User, VerificationRecord, VoucherRecord } from './workspace-model';
import { money, platformCan, statusColor, statusText } from './workspace-model';

export type TransactionDataPageProps = {
  page: 'orders' | 'vouchers' | 'verifications';
  data: unknown[];
  stores: Store[];
  user: User;
  paging: TablePaging;
  onVoucherTransfer: (record: TransferVoucher) => void;
  onRefundRetry: (voucherId: string) => void;
};

export default function TransactionDataPage(props: TransactionDataPageProps) {
  if (props.page === 'orders') return <DataTable data={props.data as OrderRecord[]} columns={orderColumns} paging={props.paging} />;
  if (props.page === 'vouchers') return <DataTable data={props.data as VoucherRecord[]} columns={voucherColumns(props)} paging={props.paging} />;
  return <DataTable data={props.data as VerificationRecord[]} columns={verificationColumns(props.stores)} paging={props.paging} />;
}

const orderColumns: ColumnsType<OrderRecord> = [
  { title: '订单号', dataIndex: 'orderNo' },
  { title: '数量', dataIndex: 'quantity' },
  { title: '金额', dataIndex: 'amountFen', render: money },
  { title: '状态', dataIndex: 'status', render: (status) => <Tag color={statusColor(status)}>{statusText(status)}</Tag> },
  { title: '下单时间', dataIndex: 'createdAt', render: (value) => dayjs(value).format('YYYY-MM-DD HH:mm') },
];

function voucherColumns(props: TransactionDataPageProps): ColumnsType<VoucherRecord> {
  return [
    { title: '券码', dataIndex: 'code' },
    { title: '核销门店', dataIndex: 'storeId', render: (id) => props.stores.find((store) => store.id === id)?.name || String(id).slice(0, 8) },
    { title: '面值', dataIndex: 'faceValueFen', render: money },
    { title: '状态', render: (_, record) => <Space size={4}><Tag color={statusColor(record.status)}>{statusText(record.status)}</Tag>{record.status === 'REFUND_PENDING' && <Typography.Text type="secondary">{record.refundStatus === 'FAILED' ? '支付暂未确认' : '支付确认中'}</Typography.Text>}</Space> },
    { title: '有效至', dataIndex: 'validTo', render: (value) => String(value).slice(0, 10) },
    { title: '创建时间', dataIndex: 'createdAt', render: (value) => dayjs(value).format('YYYY-MM-DD HH:mm') },
    {
      title: '操作',
      render: (_, record) => props.user.role === 'PLATFORM_ADMIN' && platformCan(props.user, 'OPERATIONS') && record.status === 'UNUSED'
        ? <Button type="link" size="small" onClick={() => props.onVoucherTransfer(record)}>转移门店</Button>
        : props.user.role === 'PLATFORM_ADMIN' && platformCan(props.user, 'FINANCE') && record.status === 'REFUND_PENDING' && record.refundStatus === 'FAILED'
          ? <Popconfirm title="重新确认这笔退款？" description="系统会复用原退款幂等键，不会重复退款。" onConfirm={() => props.onRefundRetry(record.id)}><Button type="link" size="small">重新确认退款</Button></Popconfirm>
          : <Typography.Text type="secondary">-</Typography.Text>,
    },
  ];
}

function verificationColumns(stores: Store[]): ColumnsType<VerificationRecord> {
  return [
    { title: '核销时间', dataIndex: 'verifiedAt', render: (value) => dayjs(value).format('YYYY-MM-DD HH:mm') },
    { title: '门店', dataIndex: 'storeId', render: (id) => stores.find((store) => store.id === id)?.name || String(id).slice(0, 8) },
    { title: '核销金额', dataIndex: 'amountFen', render: money },
    { title: '券记录', dataIndex: 'voucherId', render: (id) => String(id).slice(0, 8) },
  ];
}
