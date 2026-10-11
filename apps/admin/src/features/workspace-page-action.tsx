import { PlusOutlined } from '@ant-design/icons';
import { Button, Popconfirm, Space } from 'antd';
import React from 'react';
import { ExportAction } from './workspace-widgets';
import type {
  Agency,
  Merchant,
  MerchantTemplateConfig,
  ModalKind,
  User,
} from './workspace-model';
import { platformProfile } from './workspace-model';

const MerchantImportPanel = React.lazy(() => import('./merchant-import-panel'));

type WorkspaceRequest = <T>(path: string, init?: RequestInit) => Promise<T>;

interface WorkspacePageActionProps {
  agencies: Agency[];
  canPlatformOperate: boolean;
  exporting: boolean;
  exportRange: [string, string];
  isReadOnly: boolean;
  page: string;
  profileSubjectLocked: boolean;
  request: WorkspaceRequest;
  selectedMerchant?: Merchant;
  templateConfig?: MerchantTemplateConfig;
  user: User;
  onExport: (kind: 'orders' | 'verifications') => void | Promise<void>;
  onLogoutOthers: () => void | Promise<void>;
  onMerchantImported: () => void;
  onOpen: (kind: ModalKind) => void;
  onOpenExceptionRefund: () => void | Promise<void>;
  onOpenExportJobs: () => void | Promise<void>;
  onOpenMerchantProfile: (merchant: Merchant, subjectLocked: boolean) => void;
  onOpenTemplateConfig: (config: MerchantTemplateConfig) => void | Promise<void>;
  onOpenTemplateVersions: (config: MerchantTemplateConfig) => void | Promise<void>;
  onSetExportRange: (range: [string, string]) => void;
}

export function WorkspacePageAction({
  agencies,
  canPlatformOperate,
  exporting,
  exportRange,
  isReadOnly,
  page,
  profileSubjectLocked,
  request,
  selectedMerchant,
  templateConfig,
  user,
  onExport,
  onLogoutOthers,
  onMerchantImported,
  onOpen,
  onOpenExceptionRefund,
  onOpenExportJobs,
  onOpenMerchantProfile,
  onOpenTemplateConfig,
  onOpenTemplateVersions,
  onSetExportRange,
}: WorkspacePageActionProps) {
  if (page === 'agencies' && platformProfile(user) === 'SYSTEM_ADMIN') {
    return <Button type="primary" icon={<PlusOutlined />} onClick={() => onOpen('agency')}>新建代理商</Button>;
  }
  if (page === 'merchants' && !isReadOnly && (user.role !== 'PLATFORM_ADMIN' || canPlatformOperate)) {
    return (
      <Space>
        <React.Suspense fallback={null}>
          <MerchantImportPanel user={user} agencies={agencies} request={request} onImported={onMerchantImported} onRequireStepUp={() => onOpen('stepUp')} />
        </React.Suspense>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => onOpen('merchant')}>新建商家</Button>
      </Space>
    );
  }
  if (page === 'profile' && !isReadOnly && selectedMerchant) {
    return <Button type="primary" onClick={() => onOpenMerchantProfile(selectedMerchant, profileSubjectLocked)}>编辑商家资料</Button>;
  }
  if (page === 'stores' && !isReadOnly) {
    return <Button type="primary" icon={<PlusOutlined />} onClick={() => onOpen('store')}>新建门店</Button>;
  }
  if (page === 'packages' && !isReadOnly) {
    return <Button type="primary" icon={<PlusOutlined />} onClick={() => onOpen('package')}>{user.role === 'MERCHANT_ADMIN' ? '添加商品' : '新建套餐'}</Button>;
  }
  if (page === 'template' && !isReadOnly) {
    return (
      <Space>
        <Button type="primary" disabled={!templateConfig} onClick={() => templateConfig && void onOpenTemplateConfig(templateConfig)}>编辑品牌主页</Button>
        <Button disabled={!templateConfig?.id} onClick={() => templateConfig && void onOpenTemplateVersions(templateConfig)}>历史版本</Button>
      </Space>
    );
  }
  if (page === 'staff' && !isReadOnly) {
    return <Button type="primary" icon={<PlusOutlined />} onClick={() => onOpen('staff')}>添加核销员</Button>;
  }
  if (page === 'orders' && !isReadOnly) {
    return <ExportAction label="导出订单" range={exportRange} onRangeChange={onSetExportRange} onExport={() => void onExport('orders')} onHistory={() => void onOpenExportJobs()} loading={exporting} />;
  }
  if (page === 'vouchers' && !isReadOnly) {
    return <ExportAction label="导出核销明细" range={exportRange} onRangeChange={onSetExportRange} onExport={() => void onExport('verifications')} onHistory={() => void onOpenExportJobs()} loading={exporting} />;
  }
  if (page === 'support' && user.role === 'MERCHANT_ADMIN') {
    return <Button type="primary" onClick={() => void onOpenExceptionRefund()}>异常退款申请</Button>;
  }
  if (page === 'sessions') {
    return (
      <Space>
        <Button onClick={() => onOpen('stepUp')}>身份确认</Button>
        <Button onClick={() => onOpen('password')}>修改密码</Button>
        <Popconfirm title="确认退出其他所有登录设备？" onConfirm={() => void onLogoutOthers()}><Button danger>退出其他设备</Button></Popconfirm>
      </Space>
    );
  }
  return null;
}
