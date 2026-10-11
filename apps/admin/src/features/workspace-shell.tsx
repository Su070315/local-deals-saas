import {
  ExclamationCircleOutlined,
  LogoutOutlined,
  ReloadOutlined,
  SafetyCertificateOutlined,
  SearchOutlined,
} from '@ant-design/icons';
import {
  App as AntApp,
  Button,
  Card,
  ConfigProvider,
  Input,
  Layout,
  Menu,
  Select,
  Space,
  Spin,
  Tag,
  Typography,
} from 'antd';
import zhCN from 'antd/locale/zh_CN';
import type { ReactNode } from 'react';
import { roleName, type Merchant, type User } from './workspace-model';
import type { OperatorIssue } from './operator-issue';
import { workspacePageDescription, workspacePageTitle, type WorkspaceNavigationGroup } from './workspace-navigation';
import { workspaceReleaseId } from './workspace-runtime';

interface WorkspaceShellProps {
  action?: ReactNode;
  canPlatformComply: boolean;
  canPlatformFinance: boolean;
  canPlatformSecure: boolean;
  canSwitchMerchant: boolean;
  children: ReactNode;
  keyword: string;
  lastIssue: OperatorIssue | null;
  loading: boolean;
  menu: WorkspaceNavigationGroup[];
  merchantId: string;
  merchants: Merchant[];
  overlays: ReactNode;
  page: string;
  selectedMerchant?: Merchant;
  user: User;
  workspace: string;
  onClearKeyword: () => void;
  onKeywordChange: (value: string) => void;
  onLogout: () => void | Promise<void>;
  onNavigate: (page: string) => void;
  onOpenIssue: () => void;
  onOpenStepUp: () => void;
  onSwitchMerchant: (merchantId: string) => void;
}

export function WorkspaceShell({
  action,
  canPlatformComply,
  canPlatformFinance,
  canPlatformSecure,
  canSwitchMerchant,
  children,
  keyword,
  lastIssue,
  loading,
  menu,
  merchantId,
  merchants,
  overlays,
  page,
  selectedMerchant,
  user,
  workspace,
  onClearKeyword,
  onKeywordChange,
  onLogout,
  onNavigate,
  onOpenIssue,
  onOpenStepUp,
  onSwitchMerchant,
}: WorkspaceShellProps) {
  const showsListFilter = page === 'agencies' || page === 'merchants';
  const platformProfileColor = canPlatformSecure ? 'blue' : canPlatformFinance ? 'green' : canPlatformComply ? 'purple' : 'cyan';
  const activeNavigationGroup = menu.find((group) => group.items.some((entry) => entry.key === page)) || menu[0];
  const pageTitle = workspacePageTitle(page, user, user.role === 'STORE_STAFF', workspace);
  const primaryMenuItems = menu.map((group) => ({ key: group.key, icon: group.icon, label: group.label }));
  const secondaryMenuItems = activeNavigationGroup?.items.map((entry) => ({ key: entry.key, label: entry.label })) || [];
  const mobilePageOptions = activeNavigationGroup?.items.map((entry) => ({ value: entry.key, label: entry.label })) || [];

  function navigateGroup(groupKey: string) {
    const target = menu.find((group) => group.key === groupKey)?.items[0];
    if (target) onNavigate(target.key);
  }

  return (
    <ConfigProvider locale={zhCN} theme={{ token: { colorPrimary: '#1554d1', borderRadius: 4, fontFamily: 'Microsoft YaHei, Arial, sans-serif' } }}>
      <AntApp>
        <Layout className="shell">
          <Layout.Sider width={184} className="sider primary-sider">
            <div className="brand">
              <span className="brand-mark">示</span>
              <div>示例商城<small>{workspace}</small></div>
            </div>
            <Menu theme="dark" mode="inline" selectedKeys={activeNavigationGroup ? [activeNavigationGroup.key] : []} items={primaryMenuItems} onClick={({ key }) => navigateGroup(String(key))} />
          </Layout.Sider>
          <Layout.Sider width={164} theme="light" className="secondary-sider">
            <div className="secondary-heading">{activeNavigationGroup?.label || '工作台'}</div>
            <Menu mode="inline" selectedKeys={[page]} items={secondaryMenuItems} onClick={({ key }) => onNavigate(String(key))} />
          </Layout.Sider>
          <Layout>
            <Layout.Header className="topbar">
              <div className="topbar-context">
                <Button className="topbar-refresh" aria-label="刷新当前页面" type="text" icon={<ReloadOutlined />} onClick={() => window.location.reload()} />
                <div className="workspace-breadcrumb" aria-label="当前位置">
                  <span>{workspace}</span><i>/</i><span>{activeNavigationGroup?.label}</span><i>/</i><strong>{pageTitle}</strong>
                </div>
                <Select className="mobile-page-select" aria-label="当前栏目页面" value={page} options={mobilePageOptions} onChange={onNavigate} />
                {canSwitchMerchant && (
                  <Select
                    className="merchant-switcher"
                    aria-label="当前商家"
                    value={merchantId || undefined}
                    onChange={onSwitchMerchant}
                    options={merchants.map((merchant) => ({ value: merchant.id, label: merchant.brandName }))}
                  />
                )}
              </div>
              <Space className="topbar-actions">
                {user.role === 'PLATFORM_ADMIN' && (
                  <Tag className="workspace-profile-tag" color={platformProfileColor}>
                    {roleName(user.role, user.platformAccessProfile)}
                  </Tag>
                )}
                {user.role !== 'PLATFORM_ADMIN' && <Tag className="workspace-role-tag" color="blue">{roleName(user.role, user.platformAccessProfile)}</Tag>}
                <span className="user-name">您好，{user.name}</span>
                {lastIssue && (
                  <Button aria-label={`问题诊断 ${lastIssue.problemId}`} danger type="text" icon={<ExclamationCircleOutlined />} onClick={onOpenIssue}>
                    <span className="action-label">问题诊断</span>
                  </Button>
                )}
                <Button aria-label="身份确认" type="text" icon={<SafetyCertificateOutlined />} onClick={onOpenStepUp}>
                  <span className="action-label">身份确认</span>
                </Button>
                <Button aria-label="退出" type="text" icon={<LogoutOutlined />} onClick={() => void onLogout()}>
                  <span className="action-label">退出</span>
                </Button>
                <Tag className="workspace-version-tag">{workspaceReleaseId}</Tag>
              </Space>
            </Layout.Header>
            <Layout.Content className="content">
              <div className="page-heading">
                <div>
                  <Typography.Title level={3}>{pageTitle}</Typography.Title>
                  <Typography.Text type="secondary">{workspacePageDescription(page, selectedMerchant)}</Typography.Text>
                </div>
                {action}
              </div>
              {showsListFilter && (
                <Card className="filter-bar" variant="borderless">
                  <Space wrap>
                    <Input
                      aria-label="筛选当前列表"
                      value={keyword}
                      onChange={(event) => onKeywordChange(event.target.value)}
                      prefix={<SearchOutlined />}
                      placeholder={page === 'merchants' ? '搜索品牌、主体或合同编号' : '搜索当前列表'}
                      style={{ width: 280 }}
                    />
                    <Button icon={<ReloadOutlined />} onClick={onClearKeyword}>重置</Button>
                  </Space>
                </Card>
              )}
              <Spin spinning={loading} tip="正在加载当前工作区">{children}</Spin>
            </Layout.Content>
          </Layout>
          {overlays}
        </Layout>
      </AntApp>
    </ConfigProvider>
  );
}
