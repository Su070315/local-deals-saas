import { Button, Popconfirm, Space, Tag, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import dayjs from 'dayjs';
import { DataTable } from './data-table-shell';
import type { Agency, Merchant, PasswordResetTarget, User } from './workspace-model';
import { platformCan, platformProfile, statusColor, statusText } from './workspace-model';

export type AgencyMerchantDataPageProps = {
  page: 'agencies' | 'merchants';
  data: unknown[];
  user: User;
  onAgencyActiveChange: (record: Agency, active: boolean) => void;
  onAgencyCooperationOpen: (record: Agency) => void;
  onContractOpen: (merchant: Merchant) => void;
  onExitReadinessOpen: (merchant: Merchant) => void;
  onSupervisorPasswordReset: (target: PasswordResetTarget) => void;
  onMerchantAdministratorInvite: (merchant: Merchant) => void;
  onMerchantAdministratorPasswordReset: (merchant: Merchant) => void;
  onMerchantPaymentProfile: (merchant: Merchant) => void;
};

export default function AgencyMerchantDataPage(props: AgencyMerchantDataPageProps) {
  if (props.page === 'agencies') return <DataTable data={props.data as Agency[]} columns={agencyColumns(props)} />;
  return <DataTable data={props.data as Merchant[]} columns={merchantColumns(props)} />;
}

function agencyColumns(props: AgencyMerchantDataPageProps): ColumnsType<Agency> {
  return [
    { title: '代理商', dataIndex: 'name' },
    { title: '管理员', render: (_, record) => record.managerName ? <Space direction="vertical" size={0}><span>{record.managerName}</span><Typography.Text type="secondary">{record.managerEmail}</Typography.Text></Space> : '未创建' },
    { title: '合作模式', render: (_, record) => record.cooperationPlan === 'ANNUAL_UNLIMITED' ? '年度合作（不限商家开通）' : '单商家开通（按次）' },
    { title: '小程序开通额度', render: (_, record) => record.cooperationPlan === 'ANNUAL_UNLIMITED' ? <Space direction="vertical" size={0}><span>不限量</span><Typography.Text type="secondary">{record.cooperationStartsAt ? `${String(record.cooperationStartsAt).slice(0, 10)} 至 ${String(record.cooperationEndsAt).slice(0, 10)}` : '未设置有效期'}</Typography.Text></Space> : `${record.publicationQuotaRemaining || 0} 个商家` },
    { title: '状态', dataIndex: 'active', render: (value) => <Tag color={value ? 'green' : 'default'}>{value ? '启用' : '停用'}</Tag> },
    { title: '创建时间', dataIndex: 'createdAt', render: (value) => dayjs(value).format('YYYY-MM-DD HH:mm') },
    {
      title: '操作',
      render: (_, record) => <Space size={4}>
        {platformProfile(props.user) === 'SYSTEM_ADMIN' && <><Button type="link" size="small" onClick={() => props.onAgencyCooperationOpen(record)}>维护开通授权</Button>
          {record.managerUserId && <Button type="link" size="small" disabled={!record.active} onClick={() => props.onSupervisorPasswordReset({ id: record.managerUserId!, name: record.managerName || record.name, role: '代理商管理员' })}>重置管理员密码</Button>}
          <Popconfirm title={`确认${record.active ? '停用' : '恢复'}该代理商？`} description={record.active ? '仅停止该代理继续提交新的商家小程序开通资料；名下已开通商家的小程序、销售和核销不受影响。' : '恢复后代理管理员可重新登录。'} okButtonProps={{ danger: record.active }} onConfirm={() => props.onAgencyActiveChange(record, !record.active)}>
            <Button type="link" size="small" danger={record.active}>{record.active ? '停用代理' : '恢复代理'}</Button>
          </Popconfirm></>}
      </Space>,
    },
  ];
}

function merchantColumns(props: AgencyMerchantDataPageProps): ColumnsType<Merchant> {
  return [
    { title: '品牌', dataIndex: 'brandName', render: (value, record) => <Space><span className="merchant-dot" style={{ background: record.primaryColor }} /><b>{value}</b></Space> },
    { title: '主体', dataIndex: 'legalName' },
    { title: '合同编号', dataIndex: 'contractNumber' },
    { title: '合同到期', dataIndex: 'contractEndsAt', render: (value) => value ? String(value).slice(0, 10) : '未设置' },
    { title: '状态', dataIndex: 'status', render: (value) => <Tag color={statusColor(value)}>{statusText(value)}</Tag> },
    {
      title: '操作',
      render: (_, record) => ['PLATFORM_ADMIN', 'AGENCY_ADMIN'].includes(props.user.role) ? <Space size={0}>
        {(props.user.role === 'AGENCY_ADMIN' || platformCan(props.user, 'FINANCE')) && <Button type="link" onClick={() => props.onMerchantPaymentProfile(record)}>支付通道</Button>}
        {(platformCan(props.user, 'FINANCE') || platformCan(props.user, 'OPERATIONS')) && <Button type="link" size="small" onClick={() => props.onContractOpen(record)}>{platformCan(props.user, 'FINANCE') ? '合同' : '经营状态'}</Button>}
        {platformCan(props.user, 'OPERATIONS', 'COMPLIANCE') && record.status === 'EXITING' && <Button type="link" size="small" onClick={() => props.onExitReadinessOpen(record)}>离场检查</Button>}
        {(props.user.role !== 'PLATFORM_ADMIN' || platformCan(props.user, 'OPERATIONS')) && <><Button type="link" size="small" onClick={() => props.onMerchantAdministratorInvite(record)}>邀请管理员</Button><Button type="link" size="small" onClick={() => props.onMerchantAdministratorPasswordReset(record)}>重置管理员密码</Button></>}
      </Space> : <Typography.Text type="secondary">运营范围内</Typography.Text>,
    },
  ];
}
