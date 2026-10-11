import {
  AppstoreOutlined, BarcodeOutlined, BuildOutlined, FileTextOutlined,
  PoweroffOutlined, SafetyCertificateOutlined, SettingOutlined, ShopOutlined,
  TeamOutlined, TransactionOutlined, WalletOutlined,
} from '@ant-design/icons';
import type { ReactNode } from 'react';
import { platformCan, platformProfile } from './workspace-model';
import type { Merchant, Role, User } from './workspace-model';

const workspaceByRole: Record<Role, string> = {
  PLATFORM_ADMIN: '平台运营',
  AGENCY_ADMIN: '商家运营',
  MERCHANT_ADMIN: '商家经营',
  STORE_STAFF: '门店核销',
};

export type WorkspaceNavigationGroup = {
  key: string;
  label: string;
  icon: ReactNode;
  items: WorkspaceNavigationItem[];
};

export type WorkspaceNavigationItem = { key: string; label: string };

const item = (key: string, label: string): WorkspaceNavigationItem => ({ key, label });
const group = (key: string, label: string, icon: ReactNode, items: WorkspaceNavigationItem[]): WorkspaceNavigationGroup => ({ key, label, icon, items });

export function operatorWorkspaceName(role?: Role) {
  return workspaceByRole[role || 'STORE_STAFF'];
}

export function buildWorkspaceMenu(user: User | null): WorkspaceNavigationGroup[] {
  const role = user?.role;
  const overviewLabel = role === 'PLATFORM_ADMIN' ? '平台概览' : role === 'AGENCY_ADMIN' ? '代理概览' : role === 'STORE_STAFF' ? '核销概览' : '经营概览';
  if (role === 'PLATFORM_ADMIN' && platformProfile(user) === 'SYSTEM_ADMIN') return [
    group('overview', '概览', <BuildOutlined />, [item('overview', overviewLabel)]),
    group('merchants', '商家', <TeamOutlined />, [item('agencies', '代理商'), item('merchants', '商家列表'), item('registration', '商家开通'), item('profile', '商家资料'), item('wechatPlatform', '小程序')]),
    group('transactions', '交易', <TransactionOutlined />, [item('orders', '订单'), item('vouchers', '核销记录'), item('support', '售后退款')]),
    group('finance', '财务', <WalletOutlined />, [item('reports', '经营报表'), item('bills', '月结账单')]),
    group('system', '系统', <PoweroffOutlined />, [item('runtimeControls', '销售控制'), item('notifications', '通知记录'), item('exit', '商家退出'), item('audits', '业务审计'), item('platformAudits', '安全审计'), item('sessions', '登录设备')]),
  ];
  if (role === 'PLATFORM_ADMIN') return [
    ...(platformCan(user, 'OPERATIONS', 'FINANCE', 'COMPLIANCE') ? [group('overview', '概览', <BuildOutlined />, [item('overview', overviewLabel)])] : []),
    ...(platformCan(user, 'OPERATIONS') ? [group('operations', '经营', <ShopOutlined />, [item('agencies', '代理商管理'), item('merchants', '商家管理'), item('wechatPlatform', '微信小程序'), item('profile', '商家资料'), item('stores', '门店管理'), item('packages', '套餐管理'), item('template', '品牌主页'), item('staff', '核销员工'), item('orders', '订单列表'), item('vouchers', '券与核销'), item('support', '售后工单')])] : []),
    ...(platformCan(user, 'FINANCE') ? [group('finance', '财务', <WalletOutlined />, [item('support', '异常退款审批'), item('reports', '经营报表'), item('bills', '月结账单')])] : []),
    ...(platformCan(user, 'COMPLIANCE') ? [group('compliance', '合规', <SafetyCertificateOutlined />, [item('merchants', '商家主体'), item('wechatPlatform', '微信小程序'), item('profile', '商家资料'), item('registration', '开户与授权'), item('exit', '离场案件'), item('audits', '商家审计')])] : []),
    ...(platformCan(user, 'OPERATIONS', 'SECURITY') ? [group('runtime', '运维', <PoweroffOutlined />, [item('runtimeControls', '全局销售控制'), item('notifications', '通知队列')])] : []),
    group('settings', '设置', <SettingOutlined />, [item('sessions', '登录设备'), ...(platformCan(user, 'SECURITY') ? [item('platformAudits', '平台安全审计')] : [])]),
  ];
  if (role === 'AGENCY_ADMIN') return [
    group('overview', '概览', <BuildOutlined />, [item('overview', overviewLabel)]),
    group('merchants', '商家开通', <TeamOutlined />, [item('merchants', '商家列表'), item('profile', '商家资料'), item('wechatPlatform', '小程序'), item('agencyCooperation', '开通额度')]),
    group('operations', '经营配置', <ShopOutlined />, [item('stores', '门店'), item('packages', '商品'), item('template', '品牌主页'), item('staff', '核销员工')]),
    group('transactions', '交易数据', <FileTextOutlined />, [item('orders', '订单'), item('vouchers', '核销记录'), item('support', '售后退款'), item('reports', '经营报表'), item('bills', '月结账单')]),
    group('settings', '账号', <SettingOutlined />, [item('sessions', '登录设备')]),
  ];
  if (role === 'MERCHANT_ADMIN') return [
    group('overview', '概览', <BuildOutlined />, [item('overview', overviewLabel)]),
    group('operations', '经营', <ShopOutlined />, [item('packages', '商品/套餐'), item('stores', '门店'), item('reservations', '预约管理'), item('template', '品牌主页'), item('staff', '核销员工')]),
    group('transactions', '交易', <FileTextOutlined />, [item('orders', '订单'), item('support', '售后处理'), item('paymentTransactions', '收款流水'), item('refundTransactions', '退款流水'), item('vouchers', '核销记录')]),
    group('reports', '数据', <WalletOutlined />, [item('financeStatement', '收支统计'), item('reports', '经营报表'), item('bills', '月结账单')]),
    // FIX(B)：商家端隐藏「页面装修」入口（装修由平台/代理商代运营）；平台/代理商本来就没有该入口，不受影响
    group('miniprogram', '小程序', <AppstoreOutlined />, [item('onboardingProgress', '开通进度'), item('wechatServerDomain', '服务器域名'), item('wechatTesters', '体验成员')]),
    group('settings', '账号', <SettingOutlined />, [item('sessions', '登录设备'), item('exit', '退出经营')]),
  ];
  return [
    group('overview', '概览', <BuildOutlined />, [item('overview', overviewLabel)]),
    group('verification', '核销', <BarcodeOutlined />, [item('stores', '授权门店'), item('verifications', '我的核销记录')]),
    group('settings', '设置', <SettingOutlined />, [item('sessions', '登录设备')]),
  ];
}

export function workspacePageTitle(page: string, user: User, readOnly: boolean, workspace: string) {
  if (page === 'onboardingProgress') return '小程序开通进度';
  const merchantFeatureTitle = ({
    memberMarketing: '会员营销', presales: '商品预售', smsPlatform: '短信服务配置', smsTemplates: '短信模板',
    smsRecords: '短信发送记录', smsProviderRules: '短信发送规则', groupBuys: '拼团活动', groupInstances: '拼团实例',
    pointsExchanges: '积分兑换记录', marketingMaterials: '内容素材', marketingPublish: '内容投放', periodicCoupons: '周期券',
    couponStats: '优惠券统计', couponDistributionRecords: '领券与核销记录',
    systemMessages: '系统消息', deliveryPlans: '门店配送方案', logisticsPlatform: '同城与快递授权', freightRules: '运费规则', expressRules: '快递100配置',
    mallSystemPages: '商城系统页面', mallMemberCenter: '个人中心装修', mallCategoryLayout: '商城分类布局', mallRoles: '商城角色权限',
    afterSales: '售后订单', paymentTransactions: '支付流水', refundTransactions: '退款流水',
    productGroups: '组合套餐', productReviews: '商品评价', productReviewSettings: '评价设置',
    financeStatement: '账单统计', balanceStatistics: '储值统计', financeCommissionWithdrawals: '佣金提现', financeDataReports: '数据报表',
    distributionRecommendationRewards: '推荐奖励', wechatServerDomain: '服务器域名', wechatTesters: '体验成员',
  } as Record<string, string>)[page];
  if (merchantFeatureTitle) return merchantFeatureTitle;
  return ({ overview: workspace, agencies: '代理商管理', agencyCooperation: '小程序开通授权', merchants: user.role === 'AGENCY_ADMIN' ? '名下商家' : '商家管理', profile: '商家资料', onboardingProgress: '小程序开通进度', stores: readOnly ? '授权门店' : '门店管理', reservations: '预约管理', packages: '商品库', productPrices: '商品改价', productCategories: '分类管理', productSpecs: '规格管理', productTags: '商品标签', productGuarantees: '商品保障', productParameters: '参数管理', template: '品牌主页', staff: '核销员工', orders: '订单', vouchers: '支付与核销', verifications: '我的核销记录', bills: '历史月结账单', reports: '经营报表', support: '售后工单', registration: '开户与授权', exit: '离场案件', audits: '审计记录', platformAudits: '平台安全审计', notifications: '通知队列', runtimeControls: '全局销售控制', sessions: '登录设备', inventoryBatches: '批次查询', inventoryStock: '库存查询', inventoryRecords: '库存记录', inventoryAlerts: '库存预警', inventoryExpiryAlerts: '保质期预警', inventoryPurchase: '采购单', inventoryRequisition: '门店要货', inventoryInbound: '入库单', inventoryOutbound: '出库单', inventoryLoss: '报损单', inventoryCount: '库存盘点', inventoryTransfer: '库存调拨', inventoryTransferDisputes: '调拨争议', inventorySuppliers: '供应商管理', inventoryExpirySettings: '保质期设置', inventoryOutboundRules: '出库规则', memberOverview: '会员统计', members: '会员列表', memberPaidPlans: '付费会员', memberLevels: '等级管理', memberTags: '标签管理', memberRecharge: '储值记录', memberRechargeRules: '储值规则', promoters: '一级分销员', promoterApplications: '待审核列表', distributionLevels: '等级配置', commissions: '佣金列表', withdrawals: '提现申请', distributionRewards: '奖励任务', distributionRecruitment: '招募设置', distributionWithdrawalSettings: '提现设置', marketingRules: '优惠规则', campaigns: '活动列表', coupons: '优惠券', pointsMall: '积分商品', mallPages: '页面装修', mallMaterials: '素材库', mallThemes: '主题换肤', wechatPlatform: user.role === 'PLATFORM_ADMIN' ? '微信小程序' : '小程序注册/授权' } as Record<string, string>)[page];
}

export function workspacePageDescription(page: string, selectedMerchant?: Merchant) {
  if (page === 'exit') return '退出不会删除订单、券或审计；请按停售、履约、数据交付、授权撤销和留存复核的顺序完成。';
  if (page === 'registration') return '管理商户资料、小程序注册、第三方平台授权、服务类目、微信认证与备案进度。';
  if (page === 'agencyCooperation') return '合作费用在线下对公结算；本系统只管理代理可提交的新商家小程序开通额度，不处理收款或结算，也不影响既有商家。';
  if (page === 'template') return '配置顾客端首页标题、介绍与主推套餐。';
  if (page === 'platformAudits') return '查看不归属单一商家的平台级账号与安全事件。';
  if (page === 'notifications') return '仅展示事件类型、状态和载荷字段名；收件人地址及通知正文不会进入管理端。';
  if (page === 'runtimeControls') return '平台级紧急止售只关闭新订单，不影响已支付券履约；恢复销售必须经过独立运营账号复核。';
  if (page === 'sessions') return '查看并管理当前账号的活动设备';
  if (page.startsWith('inventory')) return '按门店、商品、批次和效期管理实际库存与预警状态';
  if (['packages', 'productPrices', 'productCategories', 'productSpecs', 'productGroups', 'productReviews', 'productReviewSettings', 'productTags', 'productGuarantees', 'productParameters'].includes(page)) return '管理商品建档、价格、分类、规格、组合套餐、评价、保障、参数、履约方式和顾客端展示内容';
  if (['memberOverview', 'members', 'memberPaidPlans', 'memberLevels', 'memberTags', 'memberRecharge', 'memberRechargeRules'].includes(page)) return '管理会员档案、付费套餐、等级、标签、储值余额、充值规则和积分';
  if (['promoters', 'promoterApplications', 'distributionLevels', 'commissions', 'withdrawals', 'distributionRewards', 'distributionRecommendationRewards', 'distributionRecruitment', 'distributionWithdrawalSettings'].includes(page)) return '仅支持一级分销员、直接推荐奖励、审核、等级、佣金和提现，不建立二级分销关系';
  if (['marketingRules', 'campaigns', 'memberMarketing', 'presales', 'smsPlatform', 'smsTemplates', 'smsRecords', 'smsProviderRules', 'groupBuys', 'groupInstances', 'pointsMall', 'pointsExchanges', 'marketingMaterials', 'marketingPublish', 'coupons', 'periodicCoupons', 'couponStats', 'couponDistributionRecords'].includes(page)) return '统一管理优惠、会员营销、预售、拼团、短信、积分、内容投放与优惠券';
  if (['financeStatement', 'balanceStatistics', 'financeCommissionWithdrawals', 'financeDataReports'].includes(page)) return '按门店和时间汇总交易、储值、佣金提现，并提供业务报表预览和导出';
  if (['afterSales', 'paymentTransactions', 'refundTransactions'].includes(page)) return '按订单、申请、支付和退款状态核对商户交易履约流水';
  if (['systemMessages', 'deliveryPlans', 'logisticsPlatform', 'freightRules', 'expressRules'].includes(page)) return '管理门店消息、配送范围、运费规则及顺丰同城和快递100服务端授权状态';
  if (['mallPages', 'mallSystemPages', 'mallMemberCenter', 'mallCategoryLayout', 'mallMaterials', 'mallThemes', 'mallRoles'].includes(page)) return '配置小程序页面、个人中心、分类布局、素材、主题和角色权限，发布前保留可回退版本';
  if (page === 'wechatServerDomain') return '配置顾客端小程序可访问的服务器域名（request/upload/download），保存后即时生效';
  if (page === 'wechatTesters') return '管理可扫码进入体验版的成员白名单，只有列表中的微信号能打开体验版';
  if (page === 'onboardingProgress') return '查看代理处理的小程序开通进度';
  if (page === 'wechatPlatform') return '查看第三方平台配置、小程序授权、认证与备案进度';
  return selectedMerchant?.brandName || (page === 'agencies' ? '平台代理商及管理员账号' : '权限范围内全部商家');
}
