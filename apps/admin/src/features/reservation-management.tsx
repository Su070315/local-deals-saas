import { Button, Card, DatePicker, message, Popconfirm, Select, Space, Table, Tag } from 'antd';
import { useCallback, useEffect, useState } from 'react';
import type { ColumnsType } from 'antd/es/table';
import dayjs from 'dayjs';

type Request = <T>(path: string, init?: RequestInit) => Promise<T>;

type Reservation = {
  id: string;
  customerName: string;
  customerPhone: string;
  storeName: string;
  date: string;
  timeSlot: string;
  peopleCount: number;
  remark: string;
  status: 'PENDING' | 'CONFIRMED' | 'IN_PROGRESS' | 'CANCELLED' | 'COMPLETED';
  handledNote: string;
  createdAt: string;
};

const STATUS_META: Record<string, { label: string; color: string }> = {
  PENDING: { label: '待处理', color: 'gold' },
  CONFIRMED: { label: '已确认', color: 'green' },
  IN_PROGRESS: { label: '进行中', color: 'processing' },
  CANCELLED: { label: '已取消', color: 'default' },
  COMPLETED: { label: '已完成', color: 'blue' },
};

/** 商家预约管理（2026-08-10 预约真实闭环）：列表/筛选/状态处理 */
export function ReservationManagement({ merchantId, request }: { merchantId: string; request: Request }) {
  const [items, setItems] = useState<Reservation[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState('');
  const [status, setStatus] = useState<string>('');
  const [date, setDate] = useState<string>('');
  const [page, setPage] = useState(1);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ page: String(page), pageSize: '20' });
      if (status) params.set('status', status);
      if (date) params.set('date', date);
      const result = await request<{ items: Reservation[]; total: number }>(`/merchants/${merchantId}/reservations?${params.toString()}`);
      setItems(result.items || []);
      setTotal(result.total || 0);
    } catch (error) {
      message.error((error as Error).message);
    } finally {
      setLoading(false);
    }
  }, [merchantId, request, status, date, page]);

  useEffect(() => { void load(); }, [load]);

  const updateStatus = useCallback(async (id: string, nextStatus: string, note: string) => {
    setBusy(id);
    try {
      await request(`/merchants/${merchantId}/reservations/${id}/status`, { method: 'POST', body: JSON.stringify({ status: nextStatus, note }) });
      message.success('预约状态已更新');
      void load();
    } catch (error) {
      message.error((error as Error).message);
    } finally {
      setBusy('');
    }
  }, [merchantId, request, load]);

  const columns: ColumnsType<Reservation> = [
    { title: '状态', dataIndex: 'status', width: 90, render: (value: string) => { const meta = STATUS_META[value] || STATUS_META.PENDING; return <Tag color={meta.color}>{meta.label}</Tag>; } },
    { title: '顾客', dataIndex: 'customerName', width: 90 },
    { title: '手机号', dataIndex: 'customerPhone', width: 110 },
    { title: '门店', dataIndex: 'storeName', ellipsis: true },
    { title: '日期', dataIndex: 'date', width: 110 },
    { title: '时段', dataIndex: 'timeSlot', width: 70 },
    { title: '人数', dataIndex: 'peopleCount', width: 60 },
    { title: '备注', dataIndex: 'remark', ellipsis: true },
    { title: '提交时间', dataIndex: 'createdAt', width: 150, render: (value: string) => dayjs(value).format('MM-DD HH:mm') },
    {
      title: '操作', width: 170, render: (_, record) => (
        <Space size={4}>
          {record.status === 'PENDING' && <Button size="small" type="primary" loading={busy === record.id} onClick={() => void updateStatus(record.id, 'CONFIRMED', '')}>确认</Button>}
          {(record.status === 'PENDING' || record.status === 'CONFIRMED') && (
            <Popconfirm title="取消该预约？" onConfirm={() => void updateStatus(record.id, 'CANCELLED', '商家取消')}>
              <Button size="small" danger loading={busy === record.id}>取消</Button>
            </Popconfirm>
          )}
          {record.status === 'CONFIRMED' && <Button size="small" type="primary" loading={busy === record.id} onClick={() => void updateStatus(record.id, 'IN_PROGRESS', '已到店，开始服务')}>开始服务</Button>}
          {record.status === 'IN_PROGRESS' && <Button size="small" loading={busy === record.id} onClick={() => void updateStatus(record.id, 'COMPLETED', '服务完成')}>完成</Button>}
        </Space>
      ),
    },
  ];

  return (
    <Card title="预约管理" variant="borderless" extra={
      <Space>
        <Select allowClear placeholder="全部状态" style={{ width: 120 }} value={status || undefined} onChange={(value) => { setStatus(value || ''); setPage(1); }} options={Object.entries(STATUS_META).map(([key, meta]) => ({ value: key, label: meta.label }))} />
        <DatePicker placeholder="按日期筛选" value={date ? dayjs(date) : null} onChange={(value) => { setDate(value ? value.format('YYYY-MM-DD') : ''); setPage(1); }} />
      </Space>
    }>
      <Table rowKey="id" loading={loading} dataSource={items} columns={columns} size="small" pagination={{ current: page, pageSize: 20, total, showTotal: (t) => `共 ${t} 条`, onChange: setPage }} />
    </Card>
  );
}
