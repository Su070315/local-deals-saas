import { Space, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import dayjs from 'dayjs';
import { DataTable } from './data-table-shell';
import type { TablePaging } from './data-table-shell';
import type { AuditRecord } from './workspace-model';

export default function AuditDataPage({ data, paging }: { data: unknown[]; paging: TablePaging }) {
  const columns: ColumnsType<AuditRecord> = [
    { title: '时间', dataIndex: 'createdAt', render: (value) => dayjs(value).format('YYYY-MM-DD HH:mm:ss') },
    { title: '动作', dataIndex: 'action' },
    { title: '资源', render: (_, record) => `${record.resourceType} · ${record.resourceId.slice(0, 8)}` },
    { title: '操作者', render: (_, record) => <Space direction="vertical" size={0}><span>{record.actorId}</span><Typography.Text type="secondary">{record.actorRole || '未知角色'}</Typography.Text></Space> },
    { title: '请求 ID', dataIndex: 'requestId', render: (value) => value ? String(value).slice(0, 16) : '-' },
    { title: '来源', render: (_, record) => <Space direction="vertical" size={0}><span>{record.ipAddress || '-'}</span><Typography.Text type="secondary">{record.userAgent ? String(record.userAgent).slice(0, 28) : '-'}</Typography.Text></Space> },
  ];
  return <DataTable data={data as AuditRecord[]} columns={columns} paging={paging} />;
}
