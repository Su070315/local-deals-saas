import { Button, Empty, Modal, Popconfirm, Space, Table, Tag, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import dayjs from 'dayjs';
import type { Deal, MerchantTemplateConfig, MerchantTemplateConfigVersion, PackageVersion, Store, StoreVersion } from './workspace-model';
import { money, statusColor, statusText } from './workspace-model';

export function TemplateConfigVersionModal({ config, versions, packages, onClose, onRestore }: { config: MerchantTemplateConfig | null; versions: MerchantTemplateConfigVersion[]; packages: Deal[]; onClose: () => void; onRestore: (auditId: string) => void }) {
  const actionText: Record<string, string> = { MERCHANT_TEMPLATE_CONFIG_SAVED: '发布主页', MERCHANT_TEMPLATE_CONFIG_VERSION_RESTORED: '恢复版本' };
  const columns: ColumnsType<MerchantTemplateConfigVersion> = [
    { title: '版本', dataIndex: 'version', width: 72 },
    { title: '主页标题', dataIndex: 'homeTitle', render: (value) => value || '使用品牌名称' },
    { title: '主页介绍', dataIndex: 'homeSubtitle', render: (value) => <Typography.Text ellipsis={{ tooltip: value || '使用默认团购服务介绍' }} style={{ maxWidth: 240 }}>{value || '使用默认团购服务介绍'}</Typography.Text> },
    { title: '主推套餐', render: (_, item) => item.featuredPackageId ? packages.find((deal) => deal.id === item.featuredPackageId)?.title || '套餐已移除' : '未设置' },
    { title: '记录', render: (_, item) => <Space direction="vertical" size={0}><span>{actionText[item.action] || item.action}</span><Typography.Text type="secondary">{dayjs(item.createdAt).format('YYYY-MM-DD HH:mm')}</Typography.Text></Space> },
    { title: '操作', render: (_, item) => <Popconfirm title={`恢复到版本 ${item.version}？`} description="将发布为一个新版本，顾客端会立即使用恢复后的主页。" onConfirm={() => onRestore(item.auditId)}><Button size="small">恢复</Button></Popconfirm> },
  ];
  return <Modal open={!!config} title="品牌主页 · 历史版本" onCancel={onClose} footer={<Button onClick={onClose}>关闭</Button>} width={1080} destroyOnClose>{versions.length ? <Table rowKey="auditId" columns={columns} dataSource={versions} pagination={{ pageSize: 8, showSizeChanger: false }} scroll={{ x: 920 }} /> : <Empty description="暂无可恢复的主页版本" />}</Modal>;
}

export function PackageVersionModal({ deal, versions, onClose, onRestore }: { deal: Deal | null; versions: PackageVersion[]; onClose: () => void; onRestore: (auditId: string) => void }) {
  const actionText: Record<string, string> = { PACKAGE_CREATED: '创建套餐', PACKAGE_UPDATED: '编辑套餐', PACKAGE_STATUS_CHANGED: '上下架', PACKAGE_VERSION_RESTORED: '恢复版本' };
  const columns: ColumnsType<PackageVersion> = [
    { title: '版本', dataIndex: 'version', width: 72 },
    { title: '配置', render: (_, item) => <Space direction="vertical" size={0}><b>{item.title}</b><Typography.Text type="secondary">{money(item.priceFen)} · {item.validityMode === 'PURCHASE_RELATIVE' ? `购买后 ${item.validityDurationDays || '-'} 天内有效` : `${String(item.validFrom).slice(0, 10)} 至 ${String(item.validTo).slice(0, 10)}`}</Typography.Text></Space> },
    { title: '状态', dataIndex: 'status', render: (value) => <Tag color={statusColor(value)}>{statusText(value)}</Tag> },
    { title: '记录', render: (_, item) => <Space direction="vertical" size={0}><span>{actionText[item.action] || item.action}</span><Typography.Text type="secondary">{dayjs(item.createdAt).format('YYYY-MM-DD HH:mm')}</Typography.Text></Space> },
    { title: '操作', render: (_, item) => <Popconfirm title={`恢复到版本 ${item.version}？`} description="将生成一个新版本；已售数量和已购券不会变化。" onConfirm={() => onRestore(item.auditId)}><Button size="small">恢复</Button></Popconfirm> },
  ];
  return <Modal open={!!deal} title={deal ? `${deal.title} · 历史版本` : ''} onCancel={onClose} footer={<Button onClick={onClose}>关闭</Button>} width={920} destroyOnClose>{versions.length ? <Table rowKey="auditId" columns={columns} dataSource={versions} pagination={{ pageSize: 8, showSizeChanger: false }} scroll={{ x: 760 }} /> : <Empty description="该套餐暂无可恢复版本" />}</Modal>;
}

export function StoreVersionModal({ store, versions, onClose, onRestore }: { store: Store | null; versions: StoreVersion[]; onClose: () => void; onRestore: (auditId: string) => void }) {
  const actionText: Record<string, string> = { STORE_CREATED: '创建门店', STORE_UPDATED: '编辑门店', STORE_VERSION_RESTORED: '恢复版本' };
  const columns: ColumnsType<StoreVersion> = [
    { title: '版本', dataIndex: 'version', width: 72 },
    { title: '配置', render: (_, item) => <Space direction="vertical" size={0}><b>{item.name}</b><Typography.Text type="secondary">{item.address} · {item.businessHours}</Typography.Text><Typography.Text type="secondary">{item.openForSale ? '接受新订单' : '暂停新售'} · {item.openForVerification ? '继续履约' : '停止履约'} · {item.latitude !== null && item.longitude !== null ? '已配置导航' : '未配置导航'}</Typography.Text></Space> },
    { title: '记录', render: (_, item) => <Space direction="vertical" size={0}><span>{actionText[item.action] || item.action}</span><Typography.Text type="secondary">{dayjs(item.createdAt).format('YYYY-MM-DD HH:mm')}</Typography.Text></Space> },
    { title: '操作', render: (_, item) => <Popconfirm title={`恢复到版本 ${item.version}？`} description="将生成一个新版本；已售券的履约状态不会变化。" onConfirm={() => onRestore(item.auditId)}><Button size="small">恢复</Button></Popconfirm> },
  ];
  return <Modal open={!!store} title={store ? `${store.name} · 历史版本` : ''} onCancel={onClose} footer={<Button onClick={onClose}>关闭</Button>} width={960} destroyOnClose>{versions.length ? <Table rowKey="auditId" columns={columns} dataSource={versions} pagination={{ pageSize: 8, showSizeChanger: false }} scroll={{ x: 760 }} /> : <Empty description="该门店暂无可恢复版本" />}</Modal>;
}
