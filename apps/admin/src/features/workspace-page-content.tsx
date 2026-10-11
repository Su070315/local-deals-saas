import { Card, Spin } from 'antd';
import React from 'react';
import type {
  AuditIntegrity, AuditRecord, DashboardSummary, Deal, Merchant, MerchantExitCase, MerchantReadiness,
  MerchantRegistration, MerchantTemplateConfig, ModalKind, MonthlyBill, ReportAnalytics, Store,
  TransactionPage, TransferVoucher, User, WorkQueue, LoginSession,
} from './workspace-model';
import { money, platformCan, statusColor, statusText } from './workspace-model';
import { MerchantExitCasePanel, MerchantProfilePanel, RegistrationPanel, TemplateConfigPanel } from './merchant-operation-panels';
import type { WorkspaceDataPageActions } from './workspace-data-page';
const AppConfigEditor = React.lazy(() => import('./app-config-editor'));
const MerchantOnboardingProgressPage = React.lazy(() => import('./merchant-onboarding-progress-page'));
const WechatServerDomainPage = React.lazy(() => import('./wechat-server-domain-page'));
const WechatTestersPage = React.lazy(() => import('./wechat-testers-page'));
const ReservationManagement = React.lazy(() => import('./reservation-management').then((module) => ({ default: module.ReservationManagement })));

const OverviewPage = React.lazy(() => import('./overview-page'));
const AccountSecurityPage = React.lazy(() => import('./account-security-page'));
const BillingPage = React.lazy(() => import('./billing-page'));
const WorkspaceDataPage = React.lazy(() => import('./workspace-data-page'));
const NotificationOperationsPage = React.lazy(() => import('./notification-operations-page'));
const RuntimeControlsPage = React.lazy(() => import('./runtime-controls-page'));
const AgencyCooperationPage = React.lazy(() => import('./agency-cooperation-page').then((module) => ({ default: module.AgencyCooperationPage })));
const MerchantOperationsPage = React.lazy(() => import('./merchant-operations-page'));
const WechatPlatformPage = React.lazy(() => import('./wechat-platform-page'));
const PlatformWechatPage = React.lazy(() => import('./platform-wechat-page'));
const MerchantSettingsPage = React.lazy(() => import('./merchant-settings-page'));
const MerchantOrdersPage = React.lazy(() => import('./merchant-orders-page'));
const InventoryDocumentsPage = React.lazy(() => import('./inventory-documents-page'));
const OperationalLedgerPage = React.lazy(() => import('./operational-ledger-page'));
const ProductPriceAdjustmentPage = React.lazy(() => import('./product-price-adjustment-page'));
const SmsPlatformPage = React.lazy(() => import('./sms-platform-page'));
const LogisticsPlatformPage = React.lazy(() => import('./logistics-platform-page'));
const MerchantFinanceFlowPage = React.lazy(() => import('./merchant-finance-flow-page'));
const MerchantFinanceDashboardPage = React.lazy(() => import('./merchant-finance-dashboard-page'));
const FinanceDataReportsPage = React.lazy(() => import('./finance-data-reports-page'));

const merchantOperationPages = new Set(['inventoryBatches', 'inventoryStock', 'inventoryAlerts', 'inventoryExpiryAlerts', 'memberOverview', 'members', 'promoters', 'promoterApplications', 'campaigns', 'memberMarketing', 'presales', 'groupBuys', 'coupons', 'periodicCoupons', 'couponStats']);
const merchantSettingPages = new Set(['productCategories', 'productSpecs', 'productTags', 'productGuarantees', 'productParameters', 'productGroups', 'productReviews', 'productReviewSettings', 'inventorySuppliers', 'inventoryExpirySettings', 'inventoryOutboundRules', 'inventoryTransferDisputes', 'memberLevels', 'memberTags', 'memberPaidPlans', 'memberRechargeRules', 'distributionLevels', 'distributionRewards', 'distributionRecommendationRewards', 'distributionRecruitment', 'distributionWithdrawalSettings', 'marketingRules', 'smsTemplates', 'smsProviderRules', 'smsRecords', 'marketingMaterials', 'marketingPublish', 'groupInstances', 'pointsExchanges', 'couponDistributionRecords', 'systemMessages', 'deliveryPlans', 'freightRules', 'expressRules', 'pointsMall', 'mallPages', 'mallSystemPages', 'mallMemberCenter', 'mallCategoryLayout', 'mallRoles', 'mallMaterials', 'mallThemes']);
const inventoryDocumentPages = new Set(['inventoryRecords', 'inventoryPurchase', 'inventoryRequisition', 'inventoryInbound', 'inventoryOutbound', 'inventoryLoss', 'inventoryCount', 'inventoryTransfer']);
const operationalLedgerPages = new Set(['memberRecharge', 'commissions', 'withdrawals', 'financeCommissionWithdrawals']);
const merchantFinancePages = new Set(['paymentTransactions', 'refundTransactions']);

type Request = <T>(path: string, init?: RequestInit) => Promise<T>;
type ExitModalKind = Extract<ModalKind, 'exitRequest' | 'exitFulfillment' | 'exitPrepareExport' | 'exitDataConfirm' | 'exitAuthorizationConfirm'>;

export type WorkspacePageContentProps = {
  page: string;
  data: unknown[];
  filteredData: unknown[];
  summary: DashboardSummary | ReportAnalytics | null;
  user: User;
  workQueue: WorkQueue | null;
  merchantReadiness: MerchantReadiness | null;
  auditIntegrity: AuditIntegrity | null;
  transactionPage: TransactionPage;
  stores: Store[];
  selectedMerchant?: Merchant;
  isReadOnly: boolean;
  templatePackages: Deal[];
  profileRegistration?: MerchantRegistration;
  merchantExitCase?: MerchantExitCase | null;
  request: Request;
  open: (kind: ModalKind) => void;
  onRequireStepUp: () => void;
  onRetryRefund: (voucherId: string) => void;
  onTransferVoucher: (record: TransferVoucher) => void;
  onStoreClosureRefund: (voucherId: string) => void;
  onNavigate: (page: string) => void;
  onOpenExitAction: (kind: ExitModalKind) => void;
  onChangeTransactionPage: (current: number, pageSize: number) => void;
  onRevokeSession: (sessionId: string) => void;
  onRefreshAudit: () => void;
  workspaceDataActions: WorkspaceDataPageActions;
};

export function WorkspacePageContent(props: WorkspacePageContentProps) {
  const workspaceData = Array.isArray(props.data) ? props.data : [];
  const filteredData = Array.isArray(props.filteredData) ? props.filteredData : [];
  const templateConfig = workspaceData[0] as MerchantTemplateConfig | undefined;
  const content = props.page === 'productPrices' && props.selectedMerchant
    ? <React.Suspense fallback={<Card className="data-panel" variant="borderless"><Spin /></Card>}><ProductPriceAdjustmentPage merchantId={props.selectedMerchant.id} request={props.request} /></React.Suspense>
    : props.page === 'smsPlatform' && props.selectedMerchant
    ? <React.Suspense fallback={<Card className="data-panel" variant="borderless"><Spin /></Card>}><SmsPlatformPage merchantId={props.selectedMerchant.id} request={props.request} onNavigate={props.onNavigate} /></React.Suspense>
    : props.page === 'logisticsPlatform' && props.selectedMerchant
    ? <React.Suspense fallback={<Card className="data-panel" variant="borderless"><Spin /></Card>}><LogisticsPlatformPage merchantId={props.selectedMerchant.id} request={props.request} onNavigate={props.onNavigate} /></React.Suspense>
    : merchantFinancePages.has(props.page) && props.selectedMerchant
    ? <React.Suspense fallback={<Card className="data-panel" variant="borderless"><Spin /></Card>}><MerchantFinanceFlowPage page={props.page as 'paymentTransactions' | 'refundTransactions'} merchantId={props.selectedMerchant.id} request={props.request} /></React.Suspense>
    : ['financeStatement', 'balanceStatistics'].includes(props.page) && props.selectedMerchant
    ? <React.Suspense fallback={<Card className="data-panel" variant="borderless"><Spin /></Card>}><MerchantFinanceDashboardPage page={props.page as 'financeStatement' | 'balanceStatistics'} merchantId={props.selectedMerchant.id} request={props.request} /></React.Suspense>
    : props.page === 'financeDataReports'
    ? <React.Suspense fallback={<Card className="data-panel" variant="borderless"><Spin /></Card>}><FinanceDataReportsPage onNavigate={props.onNavigate} /></React.Suspense>
    : props.page === 'mallPages' && props.selectedMerchant
    ? <React.Suspense fallback={<Card className="data-panel" variant="borderless"><Spin /></Card>}><AppConfigEditor merchantId={props.selectedMerchant.id} request={props.request} merchantName={props.selectedMerchant.brandName} role={props.user.role} /></React.Suspense>
    : props.page === 'wechatServerDomain' && props.selectedMerchant
    ? <React.Suspense fallback={<Card className="data-panel" variant="borderless"><Spin /></Card>}><WechatServerDomainPage merchantId={props.selectedMerchant.id} request={props.request} /></React.Suspense>
    : props.page === 'wechatTesters' && props.selectedMerchant
    ? <React.Suspense fallback={<Card className="data-panel" variant="borderless"><Spin /></Card>}><WechatTestersPage merchantId={props.selectedMerchant.id} request={props.request} /></React.Suspense>
    : props.page === 'onboardingProgress' && props.selectedMerchant
    ? <React.Suspense fallback={<Card className="data-panel" variant="borderless"><Spin /></Card>}><MerchantOnboardingProgressPage merchantId={props.selectedMerchant.id} request={props.request} role={props.user.role} /></React.Suspense>
    : props.page === 'reservations' && props.selectedMerchant
    ? <React.Suspense fallback={<Card className="data-panel" variant="borderless"><Spin /></Card>}><ReservationManagement merchantId={props.selectedMerchant.id} request={props.request} /></React.Suspense>
    : merchantSettingPages.has(props.page) && props.selectedMerchant
    ? <React.Suspense fallback={<Card className="data-panel" variant="borderless"><Spin /></Card>}><MerchantSettingsPage page={props.page} merchantId={props.selectedMerchant.id} request={props.request} /></React.Suspense>
    : props.page === 'wechatPlatform' && props.user.role === 'PLATFORM_ADMIN'
    ? <React.Suspense fallback={<Card className="data-panel" variant="borderless"><Spin /></Card>}><PlatformWechatPage request={props.request} onRequireStepUp={props.onRequireStepUp} /></React.Suspense>
    : props.page === 'wechatPlatform' && props.selectedMerchant
    ? <React.Suspense fallback={<Card className="data-panel" variant="borderless"><Spin /></Card>}><WechatPlatformPage merchantId={props.selectedMerchant.id} request={props.request} onNavigate={props.onNavigate} role={props.user.role} onRequireStepUp={props.onRequireStepUp} /></React.Suspense>
    : inventoryDocumentPages.has(props.page) && props.selectedMerchant
    ? <React.Suspense fallback={<Card className="data-panel" variant="borderless"><Spin /></Card>}><InventoryDocumentsPage page={props.page} merchantId={props.selectedMerchant.id} request={props.request} stores={props.stores} /></React.Suspense>
    : operationalLedgerPages.has(props.page) && props.selectedMerchant
    ? <React.Suspense fallback={<Card className="data-panel" variant="borderless"><Spin /></Card>}><OperationalLedgerPage page={props.page} merchantId={props.selectedMerchant.id} request={props.request} /></React.Suspense>
    : merchantOperationPages.has(props.page) && props.selectedMerchant
    ? <React.Suspense fallback={<Card className="data-panel" variant="borderless"><Spin /></Card>}><MerchantOperationsPage page={props.page} merchantId={props.selectedMerchant.id} request={props.request} /></React.Suspense>
    : props.page === 'orders' && props.selectedMerchant && props.user.role === 'MERCHANT_ADMIN'
    ? <React.Suspense fallback={<Card className="data-panel" variant="borderless"><Spin /></Card>}><MerchantOrdersPage merchantId={props.selectedMerchant.id} request={props.request} stores={props.stores} /></React.Suspense>
    : props.page === 'overview'
    ? <React.Suspense fallback={<Card className="data-panel" variant="borderless"><Spin /></Card>}><OverviewPage summary={props.summary as DashboardSummary | null} user={props.user} workQueue={props.workQueue} merchantReadiness={props.merchantReadiness} formatMoney={money} statusColor={statusColor} statusText={statusText} canPlatform={platformCan} onRetryRefund={props.onRetryRefund} onTransferVoucher={props.onTransferVoucher} onStoreClosureRefund={props.onStoreClosureRefund} onNavigate={props.onNavigate} merchantId={props.selectedMerchant?.id} request={props.request} /></React.Suspense>
    : props.page === 'notifications'
    ? <React.Suspense fallback={<Card className="data-panel" variant="borderless"><Spin /></Card>}><NotificationOperationsPage request={props.request} onRequireStepUp={props.onRequireStepUp} /></React.Suspense>
    : props.page === 'runtimeControls'
    ? <React.Suspense fallback={<Card className="data-panel" variant="borderless"><Spin /></Card>}><RuntimeControlsPage user={props.user} request={props.request} onRequireStepUp={props.onRequireStepUp} /></React.Suspense>
    : props.page === 'agencyCooperation'
    ? <React.Suspense fallback={<Card className="data-panel" variant="borderless"><Spin /></Card>}><AgencyCooperationPage request={props.request} /></React.Suspense>
    : props.page === 'sessions' || props.page === 'platformAudits'
    ? <React.Suspense fallback={<Card className="data-panel" variant="borderless"><Spin /></Card>}><AccountSecurityPage page={props.page as 'sessions' | 'platformAudits'} sessions={props.data as LoginSession[]} auditRecords={props.data as AuditRecord[]} integrity={props.auditIntegrity} transactionPage={props.transactionPage} onChangeTransactionPage={props.onChangeTransactionPage} onRevokeSession={props.onRevokeSession} onRefreshAudit={props.onRefreshAudit} /></React.Suspense>
    : props.page === 'profile'
      ? <MerchantProfilePanel merchant={props.selectedMerchant} registration={props.profileRegistration} platformView={platformCan(props.user, 'FINANCE')} />
    : props.page === 'registration'
      ? <RegistrationPanel registration={workspaceData[0] as MerchantRegistration | undefined} />
      : props.page === 'exit'
        ? <MerchantExitCasePanel exitCase={props.merchantExitCase || null} merchant={props.selectedMerchant} user={props.user} onAction={props.onOpenExitAction} />
      : props.page === 'template'
        ? <TemplateConfigPanel config={templateConfig} packages={props.templatePackages} />
    : props.page === 'bills'
      ? <React.Suspense fallback={<Card className="data-panel" variant="borderless"><Spin /></Card>}><BillingPage data={props.filteredData as MonthlyBill[]} /></React.Suspense>
      : <React.Suspense fallback={<Card className="data-panel" variant="borderless"><Spin /></Card>}><WorkspaceDataPage page={props.page} data={filteredData} report={props.summary as ReportAnalytics | null} stores={props.stores} user={props.user} readOnly={props.isReadOnly} transactionPage={props.transactionPage} actions={props.workspaceDataActions} /></React.Suspense>;
  return content;
}
