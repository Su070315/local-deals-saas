import { DownloadOutlined, HistoryOutlined, ReloadOutlined } from '@ant-design/icons';
import { Button, Card, ConfigProvider, Form, Input, Modal, Popconfirm, Space, Statistic, Table, Tag, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import zhCN from 'antd/locale/zh_CN';
import dayjs from 'dayjs';
import type { ExportJob, PackageFormValues } from './workspace-model';
import { money } from './workspace-model';

export function Login({ onSubmit, workspaceTitle, releaseId }: { onSubmit: (values: { email: string; password: string }) => void; workspaceTitle: string; releaseId: string }) {
  const [form] = Form.useForm();
  return <ConfigProvider locale={zhCN} theme={{ token: { colorPrimary: '#006d5b', borderRadius: 6 } }}><div className="login"><Card className="login-card"><div className="login-brand"><span className="brand-mark">团</span><div><Typography.Title level={2}>{workspaceTitle}</Typography.Title><Typography.Text type="secondary">邻里券多商家团购</Typography.Text></div></div><Form form={form} layout="vertical" onFinish={onSubmit}><Form.Item name="email" label="账号" rules={[{ required: true }]}><Input autoComplete="username" /></Form.Item><Form.Item name="password" label="密码" rules={[{ required: true }]}><Input.Password autoComplete="current-password" /></Form.Item><Button htmlType="submit" type="primary" block size="large">登录</Button></Form><Typography.Paragraph type="secondary" className="login-note">演示账号见项目 README；共享环境请使用由管理员分配的独立账号。版本：{releaseId}</Typography.Paragraph></Card></div></ConfigProvider>;
}

export function ExportAction({ label, range, onRangeChange, onExport, onHistory, loading }: { label: string; range: [string, string]; onRangeChange: (range: [string, string]) => void; onExport: () => void; onHistory: () => void; loading: boolean }) {
  const today = dayjs().format('YYYY-MM-DD');
  return <Space wrap><Input aria-label="导出开始日期" disabled={loading} type="date" value={range[0]} max={range[1] || today} onChange={(event) => { if (event.target.value) onRangeChange([event.target.value, range[1]]); }} style={{ width: 148 }} /><Input aria-label="导出结束日期" disabled={loading} type="date" value={range[1]} min={range[0]} max={today} onChange={(event) => { if (event.target.value) onRangeChange([range[0], event.target.value]); }} style={{ width: 148 }} /><Button icon={<DownloadOutlined />} loading={loading} onClick={onExport}>{label}</Button><Button icon={<HistoryOutlined />} onClick={onHistory}>导出记录</Button><Typography.Text type="secondary">共享环境导出前需身份确认</Typography.Text></Space>;
}

export function ExportJobsModal({ open, jobs, downloadingExportId, onClose, onRefresh, onDownload, onRevoke }: { open: boolean; jobs: ExportJob[]; downloadingExportId: string | null; onClose: () => void; onRefresh: () => void; onDownload: (job: ExportJob) => void; onRevoke: (exportJobId: string) => void }) {
  const label = (job: ExportJob) => ({ PENDING: '等待生成', PROCESSING: '生成中', READY: '可下载', FAILED: '生成失败', EXPIRED: '已过期', REVOKED: '已撤回' } as Record<ExportJob['status'], string>)[job.status];
  const columns: ColumnsType<ExportJob> = [
    { title: '类型', dataIndex: 'kind', render: (kind) => kind === 'orders' ? '订单' : '核销明细' },
    { title: '日期范围', render: (_, job) => `${job.fromDay} 至 ${job.toDay}` },
    { title: '状态', render: (_, job) => <Tag color={job.status === 'READY' ? 'green' : job.status === 'FAILED' || job.status === 'EXPIRED' ? 'red' : job.status === 'PROCESSING' ? 'blue' : 'default'}>{label(job)}</Tag> },
    { title: '记录', dataIndex: 'recordCount' },
    { title: '下载', dataIndex: 'downloadCount', render: (count) => `${count}/3` },
    { title: '创建时间', dataIndex: 'createdAt', render: (value) => dayjs(value).format('MM-DD HH:mm') },
    { title: '操作', render: (_, job) => job.status === 'READY' ? <Space size={4}><Button type="primary" size="small" icon={<DownloadOutlined />} loading={downloadingExportId === job.id} onClick={() => onDownload(job)}>下载</Button><Popconfirm title="确认撤回并删除此导出文件？" onConfirm={() => onRevoke(job.id)}><Button danger size="small">撤回</Button></Popconfirm></Space> : ['PENDING', 'PROCESSING'].includes(job.status) ? <Popconfirm title="确认撤回并删除此导出文件？" onConfirm={() => onRevoke(job.id)}><Button danger size="small">撤回</Button></Popconfirm> : job.failureReason ? <Typography.Text type="danger" ellipsis={{ tooltip: job.failureReason }}>{job.failureReason}</Typography.Text> : '-' },
  ];
  return <Modal title="导出记录" open={open} onCancel={onClose} width={980} footer={<Space><Button icon={<ReloadOutlined />} onClick={onRefresh}>刷新</Button><Button type="primary" onClick={onClose}>关闭</Button></Space>}><Table rowKey="id" size="small" columns={columns} dataSource={jobs} pagination={false} scroll={{ x: 840 }} /></Modal>;
}

export function Metric({ label, value, suffix }: { label: string; value: string | number | null | undefined; suffix?: string }) { return <Card variant="borderless" className="metric"><Statistic title={label} value={value ?? 0} suffix={suffix} /></Card>; }
export function PackagePreview({ values }: { values: PackageFormValues }) { const priceFen = Math.round(Number(values.priceYuan || 0) * 100); const originalPriceFen = values.originalPriceYuan ? Math.round(Number(values.originalPriceYuan) * 100) : null; const tags = Array.isArray(values.tags) ? values.tags : []; return <Card size="small" title="顾客端发布预览" style={{ marginBottom: 16 }}><Space align="start" style={{ width: '100%' }}><div style={{ width: 104, height: 104, borderRadius: 8, overflow: 'hidden', background: '#e5f5ef', display: 'grid', placeItems: 'center', color: '#006d5b', fontSize: 28, fontWeight: 600 }}>{values.coverImageUrl ? <img alt="套餐封面预览" src={values.coverImageUrl} style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : '券'}</div><Space direction="vertical" size={4} style={{ minWidth: 0 }}><Typography.Text strong>{values.title || '未命名套餐'}</Typography.Text><Space size={4} wrap>{tags.map((tag) => <Tag key={tag}>{tag}</Tag>)}</Space><Space align="baseline"><Typography.Text strong style={{ color: '#c53d25', fontSize: 20 }}>{money(priceFen)}</Typography.Text>{originalPriceFen && originalPriceFen > priceFen ? <Typography.Text delete type="secondary">{money(originalPriceFen)}</Typography.Text> : null}</Space><Typography.Text type="secondary" ellipsis>{values.description || '套餐简介将在这里显示'}</Typography.Text></Space></Space></Card>; }
