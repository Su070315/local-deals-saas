import { ReloadOutlined } from '@ant-design/icons';
import { Button, Card, Descriptions, Empty, Popconfirm, Space, Table, Tag, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import dayjs from 'dayjs';
import type { AuditIntegrity, AuditRecord, LoginSession, TransactionPage } from './workspace-model';

type AccountSecurityPageProps = {
  page: 'sessions' | 'platformAudits';
  sessions: LoginSession[];
  auditRecords: AuditRecord[];
  integrity: AuditIntegrity | null;
  transactionPage: TransactionPage;
  onChangeTransactionPage: (current: number, pageSize: number) => void;
  onRevokeSession: (sessionId: string) => void;
  onRefreshAudit: () => void;
};

export default function AccountSecurityPage({ page, sessions, auditRecords, integrity, transactionPage, onChangeTransactionPage, onRevokeSession, onRefreshAudit }: AccountSecurityPageProps) {
  return page === 'sessions'
    ? <SessionPanel sessions={sessions} onRevoke={onRevokeSession} />
    : <><AuditIntegrityPanel integrity={integrity} onRefresh={onRefreshAudit} /><AuditRecords records={auditRecords} transactionPage={transactionPage} onChangeTransactionPage={onChangeTransactionPage} /></>;
}

function SessionPanel({ sessions, onRevoke }: { sessions: LoginSession[]; onRevoke: (sessionId: string) => void }) {
  const columns: ColumnsType<LoginSession> = [
    { title: '设备', dataIndex: 'userAgent', render: (value) => value || '未知设备' },
    { title: 'IP', dataIndex: 'ipAddress', render: (value) => value || '-' },
    { title: '最近活动', dataIndex: 'lastSeenAt', render: (value) => dayjs(value).format('YYYY-MM-DD HH:mm') },
    { title: '登录时间', dataIndex: 'createdAt', render: (value) => dayjs(value).format('YYYY-MM-DD HH:mm') },
    { title: '状态', render: (_, record) => record.current ? <Tag color="green">当前设备</Tag> : <Tag>活动中</Tag> },
    { title: '操作', render: (_, record) => record.current ? <Typography.Text type="secondary">请使用顶部退出</Typography.Text> : <Popconfirm title="确认退出该设备？" onConfirm={() => onRevoke(record.id)}><Button danger size="small">退出设备</Button></Popconfirm> },
  ];
  return <Card className="data-panel" variant="borderless">{sessions.length ? <Table rowKey="id" columns={columns} dataSource={sessions} pagination={false} scroll={{ x: 850 }} /> : <Empty description="暂无活动设备" />}</Card>;
}

function AuditIntegrityPanel({ integrity, onRefresh }: { integrity: AuditIntegrity | null; onRefresh: () => void }) {
  const valid = integrity?.valid === true;
  const outbox = integrity?.outbox;
  return <Card className="data-panel" variant="borderless" title="审计链完整性" extra={<Button icon={<ReloadOutlined />} onClick={onRefresh}>重新检查</Button>}><Descriptions column={{ xs: 1, sm: 2, lg: 4 }}>
    <Descriptions.Item label="状态">{integrity ? <Tag color={valid ? 'green' : 'red'}>{valid ? '校验通过' : '发现异常'}</Tag> : <Tag>检查中</Tag>}</Descriptions.Item>
    <Descriptions.Item label="已检查记录">{integrity?.checked ?? '-'}</Descriptions.Item>
    <Descriptions.Item label="链末序号">{integrity?.lastSequence ?? '-'}</Descriptions.Item>
    <Descriptions.Item label="首个异常">{integrity?.firstInvalidSequence || (valid ? '-' : integrity?.reason || '-')}</Descriptions.Item>
    <Descriptions.Item label="待签名事件">{outbox ? <Tag color={outbox.pending || outbox.processing ? 'gold' : 'green'}>{outbox.pending + outbox.processing}</Tag> : '-'}</Descriptions.Item>
    <Descriptions.Item label="隔离事件">{outbox ? <Tag color={outbox.quarantined ? 'red' : 'green'}>{outbox.quarantined}</Tag> : '-'}</Descriptions.Item>
    <Descriptions.Item label="最早待签名">{outbox?.oldestPendingAt ? dayjs(outbox.oldestPendingAt).format('MM-DD HH:mm') : '-'}</Descriptions.Item>
  </Descriptions></Card>;
}

function AuditRecords({ records, transactionPage, onChangeTransactionPage }: { records: AuditRecord[]; transactionPage: TransactionPage; onChangeTransactionPage: (current: number, pageSize: number) => void }) {
  const columns: ColumnsType<AuditRecord> = [
    { title: '时间', dataIndex: 'createdAt', render: (value) => dayjs(value).format('YYYY-MM-DD HH:mm:ss') },
    { title: '动作', dataIndex: 'action' },
    { title: '资源', render: (_, record) => `${record.resourceType} · ${record.resourceId.slice(0, 8)}` },
    { title: '操作者', render: (_, record) => <Space direction="vertical" size={0}><span>{record.actorId}</span><Typography.Text type="secondary">{record.actorRole || '未知角色'}</Typography.Text></Space> },
    { title: '请求 ID', dataIndex: 'requestId', render: (value) => value ? String(value).slice(0, 16) : '-' },
    { title: '来源', render: (_, record) => <Space direction="vertical" size={0}><span>{record.ipAddress || '-'}</span><Typography.Text type="secondary">{record.userAgent ? String(record.userAgent).slice(0, 28) : '-'}</Typography.Text></Space> },
  ];
  return <Card className="data-panel" variant="borderless">{records.length ? <Table rowKey="id" columns={columns} dataSource={records} pagination={{ current: transactionPage.current, pageSize: transactionPage.pageSize, total: transactionPage.total, showSizeChanger: true, pageSizeOptions: [10, 25, 50, 100], showTotal: (total) => `共 ${total} 条`, onChange: onChangeTransactionPage }} scroll={{ x: 780 }} /> : <Empty description="暂无数据" />}</Card>;
}
