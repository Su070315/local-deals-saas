import { ReloadOutlined, RedoOutlined } from '@ant-design/icons';
import { Alert, Button, Card, Empty, Select, Space, Table, Tag, Typography, message } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import dayjs from 'dayjs';
import { useCallback, useEffect, useState } from 'react';
import { contractQuery } from '../api-contract';
import type { NotificationOperationsItem } from './workspace-model';

type Request = <T>(path: string, init?: RequestInit) => Promise<T>;
type NotificationStatus = NotificationOperationsItem['status'];

const statusOptions: Array<{ value: NotificationStatus | 'ALL'; label: string }> = [
  { value: 'ALL', label: '全部状态' },
  { value: 'PENDING', label: '待发送' },
  { value: 'PROCESSING', label: '处理中' },
  { value: 'SENT', label: '已发送' },
  { value: 'FAILED', label: '终态失败' },
];

const statusLabel: Record<NotificationStatus, string> = {
  PENDING: '待发送', PROCESSING: '处理中', SENT: '已发送', FAILED: '终态失败',
};

const statusColor: Record<NotificationStatus, string> = {
  PENDING: 'gold', PROCESSING: 'blue', SENT: 'green', FAILED: 'red',
};

function shortId(value: string | null): string {
  return value ? `${value.slice(0, 8)}…` : '-';
}

export default function NotificationOperationsPage({ request, onRequireStepUp }: { request: Request; onRequireStepUp: () => void }) {
  const [status, setStatus] = useState<NotificationStatus | 'ALL'>('ALL');
  const [records, setRecords] = useState<NotificationOperationsItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [retryingId, setRetryingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const query = contractQuery('AppController_notificationList', { status: status === 'ALL' ? undefined : status, limit: 100 });
      setRecords(await request<NotificationOperationsItem[]>(`/platform/notifications${query ? `?${query}` : ''}`));
    } catch (error) {
      message.error((error as Error).message);
    } finally {
      setLoading(false);
    }
  }, [request, status]);

  useEffect(() => { void load(); }, [load]);

  async function retry(record: NotificationOperationsItem) {
    if (record.status !== 'FAILED' || retryingId) return;
    setRetryingId(record.id);
    try {
      await request(`/platform/notifications/${record.id}/retry`, { method: 'POST' });
      message.success('通知已重新排队');
      await load();
    } catch (error) {
      const text = (error as Error).message;
      if (text.includes('身份') || text.includes('密码')) {
        message.warning('重试通知需要先完成身份确认。');
        onRequireStepUp();
      } else message.error(text);
    } finally {
      setRetryingId(null);
    }
  }

  const columns: ColumnsType<NotificationOperationsItem> = [
    { title: '创建时间', dataIndex: 'createdAt', width: 160, render: (value) => dayjs(value).format('YYYY-MM-DD HH:mm:ss') },
    { title: '事件', render: (_, record) => <Space direction="vertical" size={0}><Typography.Text strong>{record.eventType}</Typography.Text><Typography.Text type="secondary">{record.templateKey}</Typography.Text></Space> },
    { title: '渠道', dataIndex: 'channel', width: 90 },
    { title: '商家 / 资源', render: (_, record) => <Space direction="vertical" size={0}><Typography.Text>{shortId(record.merchantId)}</Typography.Text><Typography.Text type="secondary">{record.resourceType || '-'} · {shortId(record.resourceId)}</Typography.Text></Space> },
    { title: '状态', dataIndex: 'status', width: 100, render: (value: NotificationStatus) => <Tag color={statusColor[value]}>{statusLabel[value]}</Tag> },
    { title: '尝试', dataIndex: 'attemptCount', width: 70 },
    { title: '下次执行', dataIndex: 'nextAttemptAt', width: 160, render: (value) => dayjs(value).format('YYYY-MM-DD HH:mm:ss') },
    { title: '失败原因', dataIndex: 'lastError', render: (value) => value ? <Typography.Text type="danger" ellipsis={{ tooltip: value }} style={{ maxWidth: 260 }}>{value}</Typography.Text> : '-' },
    { title: '操作', fixed: 'right', width: 110, render: (_, record) => record.status === 'FAILED' ? <Button size="small" icon={<RedoOutlined />} loading={retryingId === record.id} onClick={() => void retry(record)}>重试</Button> : <Typography.Text type="secondary">{record.status === 'SENT' ? '已完成' : '等待执行'}</Typography.Text> },
  ];

  return <Card className="data-panel" variant="borderless" title={<Space size={10}><span>通知投递队列</span><Tag color={records.some((record) => record.status === 'FAILED') ? 'red' : 'green'}>{records.length} 条</Tag></Space>} extra={<Space><Select aria-label="通知状态" value={status} options={statusOptions} onChange={setStatus} style={{ width: 120 }} /><Button aria-label="刷新通知队列" icon={<ReloadOutlined />} loading={loading} onClick={() => void load()}>刷新</Button></Space>}>
    <Alert type="info" showIcon message="仅显示事件元数据和载荷字段名。收件人地址、通知正文及加密密文不会返回到管理端。终态失败通知的重试会记录审计事件。" style={{ marginBottom: 16 }} />
    {records.length ? <Table rowKey="id" columns={columns} dataSource={records} loading={loading} pagination={{ pageSize: 20, showSizeChanger: false }} scroll={{ x: 1280 }} /> : <Empty description={loading ? '正在加载通知队列' : '暂无通知记录'} />}
  </Card>;
}
