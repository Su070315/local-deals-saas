import { Card, Empty, Spin } from 'antd';
import React from 'react';
import type { RequestBody } from '../api-contract';
import type {
  Agency, Deal, Merchant, PasswordResetTarget, ReportAnalytics, Store, SupportTicket,
  TransactionPage, TransferVoucher, User,
} from './workspace-model';

const AgencyMerchantDataPage = React.lazy(() => import('./agency-merchant-data-page'));
const CatalogDataPage = React.lazy(() => import('./catalog-data-page'));
const StaffDataPage = React.lazy(() => import('./staff-data-page'));
const TransactionDataPage = React.lazy(() => import('./transaction-data-page'));
const SupportDataPage = React.lazy(() => import('./support-data-page'));
const MerchantAfterSalesPage = React.lazy(() => import('./merchant-after-sales-page'));
const AuditDataPage = React.lazy(() => import('./audit-data-page'));
const ReportingPage = React.lazy(() => import('./reporting-page').then((module) => ({ default: module.ReportingPage })));

export type WorkspaceDataPageProps = {
  page: string;
  data: unknown[];
  report: ReportAnalytics | null;
  stores: Store[];
  user: User;
  readOnly: boolean;
  transactionPage: TransactionPage;
  actions: WorkspaceDataPageActions;
};

export type WorkspaceDataPageActions = {
  changePage: (current: number, pageSize: number) => void;
  agency: {
    changeActive: (record: Agency, active: boolean) => void; openContract: (merchant: Merchant) => void; openExitReadiness: (merchant: Merchant) => void;
    openCooperation: (record: Agency) => void;
    resetSupervisorPassword: (target: PasswordResetTarget) => void; inviteMerchantAdministrator: (merchant: Merchant) => void; resetMerchantAdministratorPassword: (merchant: Merchant) => void; openPaymentProfile: (merchant: Merchant) => void;
  };
  catalog: {
    editStore: (record: Store) => void; changeStoreSale: (record: Store, openForSale: boolean) => void; openStoreVersions: (record: Store) => void;
    editPackage: (record: Deal) => void; changePackageStatus: (record: Deal, status: RequestBody<'AppController_packageStatus'>['status']) => void; openPackageVersions: (record: Deal) => void;
  };
  staff: { edit: (record: User) => void; changeActive: (id: string, active: boolean) => void; unbind: (id: string) => void; wechatBind: (id: string) => Promise<{ bindToken: string; expiresInSeconds: number; qrDataUrl?: string } | null> };
  support: { reply: (ticket: SupportTicket) => void; resolve: (ticket: SupportTicket) => void; reviewRefund: (ticket: SupportTicket, approved: boolean) => void; executeRefund: (ticket: SupportTicket) => void };
  transaction: { transferVoucher: (record: TransferVoucher) => void; retryRefund: (voucherId: string) => void };
};

export default function WorkspaceDataPage(props: WorkspaceDataPageProps) {
  const paging = { transactionPage: props.transactionPage, onChange: props.actions.changePage };
  let content: React.ReactNode;
  if (props.page === 'reports') content = <ReportingPage report={props.report} />;
  else if (props.page === 'agencies' || props.page === 'merchants') content = <AgencyMerchantDataPage
    page={props.page}
    data={props.data}
    user={props.user}
    onAgencyActiveChange={props.actions.agency.changeActive}
    onAgencyCooperationOpen={props.actions.agency.openCooperation}
    onContractOpen={props.actions.agency.openContract}
    onExitReadinessOpen={props.actions.agency.openExitReadiness}
    onSupervisorPasswordReset={props.actions.agency.resetSupervisorPassword}
    onMerchantAdministratorInvite={props.actions.agency.inviteMerchantAdministrator}
    onMerchantAdministratorPasswordReset={props.actions.agency.resetMerchantAdministratorPassword}
    onMerchantPaymentProfile={props.actions.agency.openPaymentProfile}
  />;
  else if (props.page === 'stores' || props.page === 'packages') content = <CatalogDataPage
    page={props.page}
    data={props.data}
    readOnly={props.readOnly}
    onStoreEdit={props.actions.catalog.editStore}
    onStoreSaleChange={props.actions.catalog.changeStoreSale}
    onStoreVersionsOpen={props.actions.catalog.openStoreVersions}
    onPackageEdit={props.actions.catalog.editPackage}
    onPackageStatusChange={props.actions.catalog.changePackageStatus}
    onPackageVersionsOpen={props.actions.catalog.openPackageVersions}
  />;
  else if (props.page === 'staff') content = <StaffDataPage data={props.data} stores={props.stores} onEdit={props.actions.staff.edit} onActiveChange={props.actions.staff.changeActive} onUnbind={props.actions.staff.unbind} onWechatBind={props.actions.staff.wechatBind} />;
  else if (props.page === 'orders' || props.page === 'vouchers' || props.page === 'verifications') content = <TransactionDataPage page={props.page} data={props.data} stores={props.stores} user={props.user} paging={paging} onVoucherTransfer={props.actions.transaction.transferVoucher} onRefundRetry={props.actions.transaction.retryRefund} />;
  else if (props.page === 'afterSales') content = <MerchantAfterSalesPage data={props.data as SupportTicket[]} user={props.user} paging={paging} onReply={props.actions.support.reply} onResolve={props.actions.support.resolve} onExceptionRefundReview={props.actions.support.reviewRefund} onExceptionRefundExecute={props.actions.support.executeRefund} />;
  else if (props.page === 'support') content = <SupportDataPage data={props.data} user={props.user} paging={paging} onReply={props.actions.support.reply} onResolve={props.actions.support.resolve} onExceptionRefundReview={props.actions.support.reviewRefund} onExceptionRefundExecute={props.actions.support.executeRefund} />;
  else if (props.page === 'audits') content = <AuditDataPage data={props.data} paging={paging} />;
  else content = <Card className="data-panel" variant="borderless"><Empty description="暂无数据" /></Card>;
  return <React.Suspense fallback={<Card className="data-panel" variant="borderless"><Spin /></Card>}>{content}</React.Suspense>;
}
