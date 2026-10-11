import { Card, Form, Spin, message } from 'antd';
import dayjs from 'dayjs';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { platformCan, platformProfile, roleName } from './features/workspace-model';
import type {
  Agency, AuditIntegrity, DashboardSummary, Deal, EditorFormValues, Merchant,
  MerchantExitCase, MerchantReadiness, MerchantRegistration, MerchantTemplateConfig,
  ModalKind, Paginated,
  PasswordResetTarget, ReportAnalytics, Role,
  Store, TransactionPage, TransferVoucher, User,
  WorkQueue,
} from './features/workspace-model';
import { ExportJobsModal, Login } from './features/workspace-widgets';
import { contractQuery } from './api-contract';
import { buildWorkspaceCommand } from './features/workspace-commands';
import {
  buildWorkspaceMenu, operatorWorkspaceName,
} from './features/workspace-navigation';
import { useExportOperations } from './features/use-export-operations';
import { useFinanceExitOperations } from './features/use-finance-exit-operations';
import { useVersionHistoryOperations } from './features/use-version-history-operations';
import { useSupportRefundOperations } from './features/use-support-refund-operations';
import { useSessionOperations } from './features/use-session-operations';
import { useCatalogStaffOperations } from './features/use-catalog-staff-operations';
import { workspaceCommandSuccess } from './features/workspace-command-feedback';
import { httpOperatorIssue, networkOperatorIssue, OperatorRequestError } from './features/operator-issue';
import type { OperatorIssue } from './features/operator-issue';
import type { WorkspaceDataPageActions } from './features/workspace-data-page';
import { WorkspacePageAction } from './features/workspace-page-action';
import { WorkspaceShell } from './features/workspace-shell';
import {
  API, MERCHANT_SCOPE_CACHE_MAX_AGE_MS, PAGES_REQUIRING_STORE_CONTEXT,
  clearStoredOperatorSession, loadStoredUser, localWorkspaceOriginHint,
  persistOperatorSession, readOperatorToken, retryAfterHint,
  workspaceAllows, workspaceName, workspaceReleaseId, workspaceRole,
} from './features/workspace-runtime';

const MerchantAdminInvitePanel = React.lazy(() => import('./features/merchant-admin-invite-panel'));
const MerchantPaymentProfilePanel = React.lazy(() => import('./features/merchant-payment-profile-panel'));
const AgencyCooperationPanel = React.lazy(() => import('./features/agency-cooperation-panel').then((module) => ({ default: module.AgencyCooperationPanel })));
const OperatorIssuePanel = React.lazy(() => import('./features/operator-issue-panel').then((module) => ({ default: module.OperatorIssuePanel })));
const WorkspacePageContent = React.lazy(() => import('./features/workspace-page-content').then((module) => ({ default: module.WorkspacePageContent })));
const Editor = React.lazy(() => import('./features/workspace-editor').then((module) => ({ default: module.Editor })));
const PackageVersionModal = React.lazy(() => import('./features/version-history-modals').then((module) => ({ default: module.PackageVersionModal })));
const StoreVersionModal = React.lazy(() => import('./features/version-history-modals').then((module) => ({ default: module.StoreVersionModal })));
const TemplateConfigVersionModal = React.lazy(() => import('./features/version-history-modals').then((module) => ({ default: module.TemplateConfigVersionModal })));

function App() {
  const [token, setToken] = useState(() => readOperatorToken() || '');
  const activeTokenRef = useRef(token);
  const refreshEpochRef = useRef(0);
  const exportRequestKeysRef = useRef(new Map<string, string>());
  const resetExportUiRef = useRef<() => void>(() => undefined);
  const resetFinanceExitOperationsRef = useRef<() => void>(() => undefined);
  const resetSupportRefundOperationsRef = useRef<() => void>(() => undefined);
  const resetCatalogStaffOperationsRef = useRef<() => void>(() => undefined);
  const merchantScopeCacheRef = useRef<{ token: string; userId: string; items: Merchant[]; agencies: Agency[] | null; fetchedAt: number } | null>(null);
  const merchantScopeDirtyRef = useRef(true);
  const [user, setUser] = useState<User | null>(() => loadStoredUser());
  const [page, setPage] = useState('overview');
  const [merchants, setMerchants] = useState<Merchant[]>([]);
  const [agencies, setAgencies] = useState<Agency[]>([]);
  const [merchantId, setMerchantId] = useState(localStorage.getItem('deals_merchant') || '');
  const [data, setData] = useState<unknown[]>([]);
  const [transactionPage, setTransactionPage] = useState<TransactionPage>({ current: 1, pageSize: 25, total: 0 });
  const [summary, setSummary] = useState<DashboardSummary | ReportAnalytics | null>(null);
  const [workQueue, setWorkQueue] = useState<WorkQueue | null>(null);
  const [auditIntegrity, setAuditIntegrity] = useState<AuditIntegrity | null>(null);
  const [merchantReadiness, setMerchantReadiness] = useState<MerchantReadiness | null>(null);
  const [agencyCooperationTarget, setAgencyCooperationTarget] = useState<Agency | null>(null);
  const [modal, setModal] = useState<ModalKind>(null);
  const [stores, setStores] = useState<Store[]>([]);
  const [keyword, setKeyword] = useState('');
  const [merchantCreationIdempotencyKey, setMerchantCreationIdempotencyKey] = useState('');
  const [merchantStatusIdempotencyKey, setMerchantStatusIdempotencyKey] = useState('');
  const [contractMerchantId, setContractMerchantId] = useState('');
  const [transferVoucher, setTransferVoucher] = useState<TransferVoucher | null>(null);
  const [transferStores, setTransferStores] = useState<Store[]>([]);
  const [passwordResetTarget, setPasswordResetTarget] = useState<PasswordResetTarget | null>(null);
  const [merchantAdminInviteTarget, setMerchantAdminInviteTarget] = useState<Merchant | null>(null);
  const [merchantPaymentProfileTarget, setMerchantPaymentProfileTarget] = useState<Merchant | null>(null);
  const [templatePackages, setTemplatePackages] = useState<Deal[]>([]);
  const [merchantProfileSubjectLocked, setMerchantProfileSubjectLocked] = useState(true);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [lastIssue, setLastIssue] = useState<OperatorIssue | null>(null);
  const [issueDrawerOpen, setIssueDrawerOpen] = useState(false);
  const submittingRef = useRef(false);
  const [form] = Form.useForm<EditorFormValues>();

  const clearLocalSession = useCallback(() => {
    activeTokenRef.current = '';
    refreshEpochRef.current += 1;
    exportRequestKeysRef.current.clear();
    merchantScopeCacheRef.current = null;
    merchantScopeDirtyRef.current = true;
    clearStoredOperatorSession();
    localStorage.removeItem('deals_merchant');
    setMerchantId(''); setToken(''); setUser(null); setPage('overview'); setData([]); setSummary(null); setWorkQueue(null); setAuditIntegrity(null); setMerchantReadiness(null); setStores([]);
    submittingRef.current = false;
    setModal(null); resetSupportRefundOperationsRef.current(); setMerchantProfileSubjectLocked(true); setMerchantAdminInviteTarget(null); setMerchantPaymentProfileTarget(null); resetExportUiRef.current(); resetFinanceExitOperationsRef.current(); resetCatalogStaffOperationsRef.current(); setLastIssue(null); setIssueDrawerOpen(false); setLoading(false); setSubmitting(false); setMerchantCreationIdempotencyKey(''); setMerchantStatusIdempotencyKey(''); setTransactionPage({ current: 1, pageSize: 25, total: 0 });
  }, []);

  const reportOperatorIssue = useCallback((issue: OperatorIssue) => { setLastIssue(issue); setIssueDrawerOpen(true); }, []);

  const request = useCallback(async <T,>(path: string, init: RequestInit = {}): Promise<T> => {
    const requestToken = token;
    const method = String(init.method || 'GET');
    // FormData（文件上传）时不要手动设置 Content-Type，交给浏览器自动带 multipart boundary
    const isFormData = typeof FormData !== 'undefined' && init.body instanceof FormData;
    const headers: Record<string, string> = { Authorization: `Bearer ${token}`, ...(init.headers as Record<string, string> | undefined) };
    if (!isFormData && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
    let response: Response;
    try { response = await fetch(`${API}${path}`, { ...init, headers }); }
    catch { const issue = networkOperatorIssue(path, method); reportOperatorIssue(issue); throw new OperatorRequestError(issue); }
    if (!response.ok) {
      if (response.status === 401) {
        // A late failure from an old session must not erase a newly signed-in session.
        if (activeTokenRef.current === requestToken) clearLocalSession();
        throw new Error('登录状态已失效，请重新登录');
      }
      const body = await response.json().catch(() => ({}));
      const issue = httpOperatorIssue(response, body, path, method);
      // 业务侧主动处理的请求可带 X-Silent-Errors 跳过"问题诊断"弹窗（如敏感操作触发身份确认时）
      const silent = Boolean((init.headers as Record<string, string> | undefined)?.['X-Silent-Errors'] === '1');
      if (!silent) reportOperatorIssue(issue);
      throw new OperatorRequestError(issue);
    }
    return response.headers.get('content-type')?.includes('application/json') ? response.json() as Promise<T> : response.text() as Promise<T>;
  }, [clearLocalSession, reportOperatorIssue, token]);

  const {
    exportRange, setExportRange, exporting, downloadingExportId, exportJobs, exportJobsOpen,
    closeExportJobs, resetExportState, refreshExportJobs, openExportJobs, revokeExportJob, downloadExportJob, exportData,
  } = useExportOperations({ request, token, merchantId, requestKeysRef: exportRequestKeysRef, onRequireStepUp: () => open('stepUp'), onIssue: reportOperatorIssue });
  resetExportUiRef.current = resetExportState;

  const loadMerchants = useCallback(async () => {
    if (!token) return { items: [] as Merchant[], agencies: null as Agency[] | null, activeMerchantId: '' };
    // Security-only accounts never fetch tenant business records just to
    // initialize the workspace; their landing page is platform audit instead.
    if (platformProfile(user) === 'SECURITY') return { items: [] as Merchant[], agencies: null as Agency[] | null, activeMerchantId: '' };
    const cached = merchantScopeCacheRef.current;
    const cacheIsCurrent = cached && !merchantScopeDirtyRef.current && cached.token === token && cached.userId === user?.id && Date.now() - cached.fetchedAt < MERCHANT_SCOPE_CACHE_MAX_AGE_MS;
    if (cacheIsCurrent) {
      const storedMerchantIsVisible = cached.items.some((item) => item.id === merchantId);
      const accountMerchantIsVisible = !!user?.merchantId && cached.items.some((item) => item.id === user.merchantId);
      return { items: cached.items, agencies: cached.agencies, activeMerchantId: storedMerchantIsVisible ? merchantId : accountMerchantIsVisible ? user!.merchantId! : cached.items.length === 1 ? cached.items[0].id : '' };
    }
    const [items, nextAgencies] = await Promise.all([
      request<Merchant[]>('/merchants'),
      platformCan(user, 'OPERATIONS') ? request<Agency[]>('/agencies') : Promise.resolve(null),
    ]);
    merchantScopeCacheRef.current = { token, userId: user?.id || '', items, agencies: nextAgencies, fetchedAt: Date.now() };
    merchantScopeDirtyRef.current = false;
    const storedMerchantIsVisible = items.some((item) => item.id === merchantId);
    const accountMerchantIsVisible = !!user?.merchantId && items.some((item) => item.id === user.merchantId);
    return { items, agencies: nextAgencies, activeMerchantId: storedMerchantIsVisible ? merchantId : accountMerchantIsVisible ? user!.merchantId! : items.length === 1 ? items[0].id : '' };
  }, [request, token, merchantId, user]);

  const transactionPageCurrent = transactionPage.current;
  const transactionPageSize = transactionPage.pageSize;
  const refresh = useCallback(async () => {
    if (!token) return;
    const refreshEpoch = ++refreshEpochRef.current;
    const isCurrentRefresh = () => refreshEpochRef.current === refreshEpoch && activeTokenRef.current === token;
    setLoading(true);
    try {
      const merchantLoad = await loadMerchants();
      if (!isCurrentRefresh()) return;
      const { items, agencies: nextAgencies, activeMerchantId } = merchantLoad;
      setMerchants(items);
      if (nextAgencies) setAgencies(nextAgencies);
      if (activeMerchantId !== merchantId) setMerchantId(activeMerchantId);
      if (page === 'overview') {
        if (platformProfile(user) === 'SECURITY') {
          setSummary(null); setWorkQueue(null); setMerchantReadiness(null);
          return;
        }
        const [nextSummary, nextWorkQueue, nextMerchantReadiness] = await Promise.all([
          request<DashboardSummary>(activeMerchantId ? `/dashboard?merchantId=${activeMerchantId}` : '/dashboard'),
          platformCan(user, 'OPERATIONS', 'FINANCE') ? request<WorkQueue>('/platform/work-queue') : Promise.resolve(null),
          (user?.role === 'AGENCY_ADMIN' || (user?.role === 'PLATFORM_ADMIN' && platformCan(user, 'OPERATIONS'))) && activeMerchantId ? request<MerchantReadiness>(`/merchants/${activeMerchantId}/readiness`) : Promise.resolve(null),
        ]);
        if (!isCurrentRefresh()) return;
        setSummary(nextSummary);
        setWorkQueue(nextWorkQueue);
        setMerchantReadiness(nextMerchantReadiness);
        return;
      }
      const merchantQuery = activeMerchantId ? `?merchantId=${activeMerchantId}` : '';
      const transactionQuery = `?${contractQuery('AppController_orders', { page: transactionPageCurrent, pageSize: transactionPageSize, merchantId: activeMerchantId || undefined })}`;
      const auditQuery = `?${contractQuery('AppController_platformAudits', { page: transactionPageCurrent, pageSize: transactionPageSize })}`;
      const reportQuery = contractQuery('AppController_reportAnalytics', { merchantId: activeMerchantId || undefined });
      const paths: Record<string, string> = {
        agencies: '/agencies', merchants: '/merchants', stores: `/merchants/${activeMerchantId}/stores`, packages: `/merchants/${activeMerchantId}/packages`, template: `/merchants/${activeMerchantId}/template-config`, exit: `/merchants/${activeMerchantId}/exit-case`,
        staff: `/merchants/${activeMerchantId}/users`, orders: `/orders${transactionQuery}`, afterSales: `/support-tickets${transactionQuery}`, vouchers: `/vouchers${transactionQuery}`, verifications: `/verifications${transactionQuery}`,
        bills: `/bills${merchantQuery}`, support: `/support-tickets${transactionQuery}`, profile: `/merchants/${activeMerchantId}/registration`, registration: `/merchants/${activeMerchantId}/registration`, audits: `/merchants/${activeMerchantId}/audits${auditQuery}`, platformAudits: `/platform/audits${auditQuery}`, reports: `/reports/analytics${reportQuery ? `?${reportQuery}` : ''}`, sessions: '/auth/sessions',
      };
      if (page !== 'reports' && paths[page] && (page === 'agencies' || page === 'merchants' || page === 'sessions' || page === 'platformAudits' || activeMerchantId)) {
        const [result, nextStores] = await Promise.all([
          request<unknown>(paths[page]),
          activeMerchantId && PAGES_REQUIRING_STORE_CONTEXT.has(page) ? request<Store[]>(`/merchants/${activeMerchantId}/stores`) : Promise.resolve(null),
        ]);
        if (!isCurrentRefresh()) return;
        if (['orders', 'vouchers', 'verifications', 'support', 'afterSales', 'audits', 'platformAudits'].includes(page)) {
          const paginated = result as Paginated<unknown>;
          setData(paginated.items);
          setTransactionPage({ current: paginated.page, pageSize: paginated.pageSize, total: paginated.total });
        } else if (page === 'profile' || page === 'registration' || page === 'template' || page === 'exit') {
          setData([result]);
          if (page === 'template' && activeMerchantId) {
            const packages = await request<Deal[]>(`/merchants/${activeMerchantId}/packages`);
            if (!isCurrentRefresh()) return;
            setTemplatePackages(packages);
          }
        }
        else {
          if (!Array.isArray(result)) throw new Error('接口返回数据格式异常，未展示不完整数据');
          setData(result);
        }
        if (nextStores) setStores(nextStores);
        if (page === 'platformAudits') {
          const integrity = await request<AuditIntegrity>('/platform/audits/integrity');
          if (!isCurrentRefresh()) return;
          setAuditIntegrity(integrity);
        }
      }
      if (page === 'reports') {
        const report = await request<ReportAnalytics>(paths.reports);
        if (!isCurrentRefresh()) return;
        setSummary(report);
      }
      if (activeMerchantId && PAGES_REQUIRING_STORE_CONTEXT.has(page) && !paths[page]) {
        const nextStores = await request<Store[]>(`/merchants/${activeMerchantId}/stores`);
        if (!isCurrentRefresh()) return;
        setStores(nextStores);
      }
    } catch (error) {
      if (isCurrentRefresh()) message.error((error as Error).message);
    } finally {
      if (isCurrentRefresh()) setLoading(false);
    }
  }, [loadMerchants, merchantId, page, request, token, transactionPageCurrent, transactionPageSize, user]);

  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => {
    if (token && user && merchantId) localStorage.setItem('deals_merchant', merchantId);
    else localStorage.removeItem('deals_merchant');
  }, [merchantId, token, user]);
  useEffect(() => {
    if (user && !workspaceAllows(user.role)) clearLocalSession();
  }, [clearLocalSession, user]);
  useEffect(() => {
    if (platformProfile(user) === 'SECURITY' && page !== 'platformAudits' && page !== 'runtimeControls') setPage('platformAudits');
  }, [page, user]);

  const {
    exitCaseMerchantId, resetFinanceExitOperations, openExitAction, openExitReadiness,
  } = useFinanceExitOperations({ form, merchantId, request, refresh, setModal });
  resetFinanceExitOperationsRef.current = resetFinanceExitOperations;
  const {
    versionedPackage, packageVersions, versionedStore, storeVersions, versionedTemplateConfig, templateVersions,
    openPackageVersions, restorePackageVersion, closePackageVersions,
    openStoreVersions, restoreStoreVersion, closeStoreVersions,
    openTemplateVersions, restoreTemplateVersion, closeTemplateVersions,
  } = useVersionHistoryOperations({ merchantId, request, refresh, setTemplatePackages });
  const {
    refundVoucherOptions, supportTicketToResolve, supportReplies, resetSupportRefundOperations,
    openExceptionRefund, retryVoucherRefund, refundClosedStoreVoucher,
    openSupportResolution, openSupportReply, openExceptionRefundReview, openExceptionRefundExecution,
  } = useSupportRefundOperations({ form, merchantId, request, refresh, setModal });
  resetSupportRefundOperationsRef.current = resetSupportRefundOperations;
  const { logout, revokeSession, logoutOthers } = useSessionOperations({ request, refresh, clearLocalSession });
  const {
    editingPackageId, editingStoreId, editingStaffId, resetCatalogStaffEditing, resetCatalogStaffOperations,
    editStore, changeStoreSale, editPackage, changePackageStatus, editStaff, changeStaffActive, unbindVerifier, createWechatBindToken,
  } = useCatalogStaffOperations({ form, merchantId, user, request, refresh, setModal });
  resetCatalogStaffOperationsRef.current = resetCatalogStaffOperations;

  const resetWorkspaceData = useCallback(() => {
    refreshEpochRef.current += 1;
    setLoading(true); setData([]); setSummary(null); setWorkQueue(null); setAuditIntegrity(null); setMerchantReadiness(null); setStores([]); setTemplatePackages([]);
  }, []);
  const switchMerchant = useCallback((nextMerchantId: string) => {
    if (nextMerchantId === merchantId) return;
    resetWorkspaceData();
    setMerchantId(nextMerchantId);
    setTransactionPage((previous) => ({ ...previous, current: 1 }));
  }, [merchantId, resetWorkspaceData]);
  const navigatePage = useCallback((nextPage: string) => {
    if (nextPage === page) return;
    resetWorkspaceData();
    setPage(nextPage);
    setTransactionPage((previous) => ({ ...previous, current: 1 }));
  }, [page, resetWorkspaceData]);

  const isReadOnly = user?.role === 'STORE_STAFF';
  const canPlatformOperate = platformCan(user, 'OPERATIONS');
  const canPlatformFinance = platformCan(user, 'FINANCE');
  const canPlatformComply = platformCan(user, 'COMPLIANCE');
  const canPlatformSecure = platformCan(user, 'SECURITY');
  const selectedMerchant = merchants.find((item) => item.id === merchantId);
  const canSwitchMerchant = !isReadOnly && merchants.length > 1;
  const workspace = operatorWorkspaceName(user?.role);
  const menu = useMemo(() => buildWorkspaceMenu(user), [user]);

  async function signIn(values: { email: string; password: string }) {
    try {
      const response = await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(values) });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        const messageText = Array.isArray(result.message) ? result.message.join('；') : typeof result.message === 'string' ? result.message : '登录失败';
        throw new Error(`${messageText}${localWorkspaceOriginHint(messageText)}${retryAfterHint(result, response.headers.get('retry-after'))}`);
      }
      if (!workspaceAllows(result.user.role as Role)) {
        void fetch(`${API}/auth/logout`, { method: 'POST', headers: { Authorization: `Bearer ${result.token}` } });
        throw new Error(`该账号不适用于${workspaceName[workspaceRole]}`);
      }
      activeTokenRef.current = result.token;
      refreshEpochRef.current += 1;
      merchantScopeCacheRef.current = null;
      merchantScopeDirtyRef.current = true;
      persistOperatorSession(result.token, result.user);
      localStorage.removeItem('deals_merchant');
      setMerchantId(''); setPage(result.user.role === 'PLATFORM_ADMIN' && (result.user.platformAccessProfile || 'SYSTEM_ADMIN') === 'SECURITY' ? 'platformAudits' : 'overview'); setToken(result.token); setUser(result.user); message.success('已进入运营台');
    } catch (error) { message.error((error as Error).message); }
  }

  async function submit(values: EditorFormValues) {
    if (submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    try {
      const command = buildWorkspaceCommand(values, {
        modal, merchantId, merchantCreationIdempotencyKey, merchantProfileSubjectLocked, contractMerchantId, canPlatformOperate, canPlatformFinance, merchantStatusIdempotencyKey,
        transferVoucher, supportTicketToResolve, exitCaseMerchantId, passwordResetTarget,
      });
      const result = await request(command.path, { method: command.method, headers: command.headers, body: JSON.stringify(command.body) });
      if (modal === 'password') {
        message.success('密码已更新，请使用新密码重新登录');
        setModal(null); form.resetFields(); clearLocalSession();
        return;
      }
      message.success(workspaceCommandSuccess(modal, result)); setModal(null); resetCatalogStaffEditing(); setTransferVoucher(null); resetSupportRefundOperations(); resetFinanceExitOperations(); setPasswordResetTarget(null); setTemplatePackages([]); setMerchantCreationIdempotencyKey(''); setMerchantStatusIdempotencyKey(''); form.resetFields(); merchantScopeDirtyRef.current = true; refresh();
    } catch (error) { message.error((error as Error).message); }
    finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  function open(kind: ModalKind) { form.resetFields(); resetCatalogStaffEditing(); setMerchantCreationIdempotencyKey(kind === 'merchant' ? crypto.randomUUID().replaceAll('-', '') : ''); if (kind === 'package') form.setFieldsValue({ productType: 'GROUP_BUY', unit: '份', minPurchaseQuantity: 1, virtualSales: 0, fulfillmentMethods: ['STORE_PICKUP'], pointsEnabled: true, inventoryEnabled: true, inventoryWarningThreshold: 0, salesChannels: ['ONLINE', 'OFFLINE'], distributionEnabled: false, batchManaged: false, galleryUrls: [], guaranteeLabels: [], parameterValues: [], status: 'DRAFT', validFrom: dayjs().format('YYYY-MM-DD'), validTo: dayjs().add(90, 'day').format('YYYY-MM-DD') }); if (kind === 'store') form.setFieldsValue({ openForSale: true, ...(user?.role === 'PLATFORM_ADMIN' ? { openForVerification: true, initialOpenForVerification: true } : {}) }); setModal(kind); }
  function openMerchantProfile(merchant: Merchant, subjectLocked = true) { form.resetFields(); setMerchantProfileSubjectLocked(subjectLocked); form.setFieldsValue({ brandName: merchant.brandName, legalName: merchant.legalName, servicePhone: merchant.servicePhone, primaryColor: merchant.primaryColor }); setModal('merchantProfile'); }
  function openContract(merchant: Merchant) { setContractMerchantId(merchant.id); setMerchantStatusIdempotencyKey(canPlatformOperate ? crypto.randomUUID().replaceAll('-', '') : ''); form.resetFields(); form.setFieldsValue({ merchant: merchant.brandName, contractNumber: merchant.contractNumber, contractEndsAt: merchant.contractEndsAt ? String(merchant.contractEndsAt).slice(0, 10) : '', status: merchant.status, expectedStatus: merchant.status, statusReason: '' }); setModal('contract'); }
  async function openTemplateConfig(config: MerchantTemplateConfig) {
    try {
      const packages = await request(`/merchants/${merchantId}/packages`) as Deal[];
      setTemplatePackages(packages); form.resetFields();
      form.setFieldsValue({ expectedVersion: config.version, homeTitle: config.homeTitle, homeSubtitle: config.homeSubtitle, featuredPackageId: config.featuredPackageId || undefined });
      setModal('template');
    } catch (error) { message.error((error as Error).message); }
  }
  function openSupervisorPasswordReset(target: PasswordResetTarget) { form.resetFields(); setPasswordResetTarget(target); setModal('supervisorPassword'); }
  async function openMerchantAdministratorPasswordReset(merchant: Merchant) {
    try {
      const users = await request(`/merchants/${merchant.id}/users`) as User[];
      const administrator = users.find((record) => record.role === 'MERCHANT_ADMIN');
      if (!administrator) { message.error('该商家尚未创建管理员账号'); return; }
      openSupervisorPasswordReset({ id: administrator.id, name: administrator.name, role: roleName(administrator.role) });
    } catch (error) { message.error((error as Error).message); }
  }
  function openMerchantAdministratorInvite(merchant: Merchant) { setMerchantAdminInviteTarget(merchant); }
  async function openVoucherTransfer(record: TransferVoucher) {
    try {
      const targetStores = record.merchantId === merchantId ? stores : await request(`/merchants/${record.merchantId}/stores`) as Store[];
      form.resetFields(); setTransferStores(targetStores); setTransferVoucher(record); setModal('voucherTransfer');
    } catch (error) { message.error((error as Error).message); }
  }
  async function changeAgencyActive(record: Agency, active: boolean) { try { await request(`/agencies/${record.id}/active`, { method: 'POST', body: JSON.stringify({ active }) }); message.success(active ? '已恢复代理商' : '已停用代理商并退出其管理设备'); merchantScopeDirtyRef.current = true; refresh(); } catch (e) { message.error((e as Error).message); } }
  function changeTransactionPage(current: number, pageSize: number) { setTransactionPage((previous) => ({ current: pageSize === previous.pageSize ? current : 1, pageSize, total: previous.total })); }
  if (!token || !user || !workspaceAllows(user.role)) return <Login onSubmit={signIn} workspaceTitle={workspaceName[workspaceRole]} releaseId={workspaceReleaseId} />;
  const workspaceData = Array.isArray(data) ? data : [];
  const filteredData = ['orders', 'vouchers', 'verifications', 'support', 'afterSales', 'paymentTransactions', 'refundTransactions', 'audits', 'platformAudits'].includes(page) || !keyword.trim() ? workspaceData : workspaceData.filter((record) => record !== null && typeof record === 'object' && Object.values(record).some((value) => String(value ?? '').toLowerCase().includes(keyword.trim().toLowerCase())));
  const templateConfig = workspaceData[0] as MerchantTemplateConfig | undefined;
  const merchantExitCase = page === 'exit' ? workspaceData[0] as MerchantExitCase | null | undefined : undefined;
  const profileRegistration = page === 'profile' ? workspaceData[0] as MerchantRegistration | undefined : undefined;
  const profileSubjectLocked = !profileRegistration || !['DRAFT', 'PENDING_MATERIALS', 'FAILED'].includes(profileRegistration.status);
  const action = <WorkspacePageAction
    agencies={agencies} canPlatformOperate={canPlatformOperate}
    exporting={exporting} exportRange={exportRange} isReadOnly={isReadOnly} page={page}
    profileSubjectLocked={profileSubjectLocked} request={request} selectedMerchant={selectedMerchant}
    templateConfig={templateConfig} user={user} onExport={exportData}
    onLogoutOthers={logoutOthers} onMerchantImported={() => { merchantScopeDirtyRef.current = true; void refresh(); }}
    onOpen={open} onOpenExceptionRefund={openExceptionRefund} onOpenExportJobs={openExportJobs}
    onOpenMerchantProfile={openMerchantProfile} onOpenTemplateConfig={openTemplateConfig}
    onOpenTemplateVersions={openTemplateVersions} onSetExportRange={setExportRange}
  />;
  const workspaceDataActions: WorkspaceDataPageActions = {
    changePage: changeTransactionPage,
    agency: { changeActive: changeAgencyActive, openCooperation: setAgencyCooperationTarget, openContract, openExitReadiness, resetSupervisorPassword: openSupervisorPasswordReset, inviteMerchantAdministrator: openMerchantAdministratorInvite, resetMerchantAdministratorPassword: openMerchantAdministratorPasswordReset, openPaymentProfile: setMerchantPaymentProfileTarget },
    catalog: { editStore, changeStoreSale, openStoreVersions, editPackage, changePackageStatus, openPackageVersions },
    staff: { edit: editStaff, changeActive: changeStaffActive, unbind: unbindVerifier, wechatBind: createWechatBindToken },
    support: { reply: openSupportReply, resolve: openSupportResolution, reviewRefund: openExceptionRefundReview, executeRefund: openExceptionRefundExecution },
    transaction: { transferVoucher: openVoucherTransfer, retryRefund: retryVoucherRefund },
  };
  const pageContent = <React.Suspense fallback={<Card className="data-panel" variant="borderless"><Spin /></Card>}><WorkspacePageContent
    page={page} data={workspaceData} filteredData={filteredData} summary={summary} user={user} workQueue={workQueue}
    merchantReadiness={merchantReadiness} auditIntegrity={auditIntegrity} transactionPage={transactionPage} stores={stores}
    selectedMerchant={selectedMerchant} isReadOnly={isReadOnly} templatePackages={templatePackages}
    profileRegistration={profileRegistration} merchantExitCase={merchantExitCase} request={request} open={open}
    onRequireStepUp={() => open('stepUp')} onRetryRefund={retryVoucherRefund} onTransferVoucher={openVoucherTransfer}
    onStoreClosureRefund={refundClosedStoreVoucher} onNavigate={navigatePage}
    onOpenExitAction={openExitAction} onChangeTransactionPage={changeTransactionPage} onRevokeSession={revokeSession}
    onRefreshAudit={() => void refresh()}
    workspaceDataActions={workspaceDataActions}
  /></React.Suspense>;

  return <WorkspaceShell
    action={action} canPlatformComply={canPlatformComply} canPlatformFinance={canPlatformFinance}
    canPlatformSecure={canPlatformSecure} canSwitchMerchant={canSwitchMerchant} keyword={keyword} lastIssue={lastIssue}
    loading={loading} menu={menu} merchantId={merchantId} merchants={merchants} page={page} selectedMerchant={selectedMerchant}
    user={user} workspace={workspace} onClearKeyword={() => setKeyword('')} onKeywordChange={setKeyword} onLogout={logout}
    onNavigate={navigatePage} onOpenIssue={() => setIssueDrawerOpen(true)} onOpenStepUp={() => open('stepUp')}
    onSwitchMerchant={switchMerchant}
    overlays={<>
        {modal && <React.Suspense fallback={null}><Editor kind={modal} form={form} stores={stores} transferStores={transferStores} agencies={agencies} refundVoucherOptions={refundVoucherOptions} transferVoucher={transferVoucher} supportTicketToResolve={supportTicketToResolve} supportReplies={supportReplies} profileSubjectLocked={merchantProfileSubjectLocked} passwordResetTarget={passwordResetTarget} templatePackages={templatePackages} showAgency={user.role === 'PLATFORM_ADMIN'} canManageContract={canPlatformFinance} canManageMerchantStatus={canPlatformOperate} editingPackage={!!editingPackageId} editingStore={!!editingStoreId} editingStaff={!!editingStaffId} submitting={submitting} merchantId={merchantId} request={request} onCancel={() => { if (submitting) return; setModal(null); resetCatalogStaffEditing(); setTransferVoucher(null); setTransferStores([]); resetSupportRefundOperations(); resetFinanceExitOperations(); setMerchantProfileSubjectLocked(true); setPasswordResetTarget(null); setMerchantCreationIdempotencyKey(''); setMerchantStatusIdempotencyKey(''); }} onSubmit={submit} /></React.Suspense>}
        <ExportJobsModal open={exportJobsOpen} jobs={exportJobs} downloadingExportId={downloadingExportId} onClose={closeExportJobs} onRefresh={() => void refreshExportJobs()} onDownload={(job) => void downloadExportJob(job)} onRevoke={(exportJobId) => void revokeExportJob(exportJobId)} />
        {merchantAdminInviteTarget && <React.Suspense fallback={null}><MerchantAdminInvitePanel merchant={merchantAdminInviteTarget} request={request} onRequireStepUp={() => open('stepUp')} onClose={() => setMerchantAdminInviteTarget(null)} /></React.Suspense>}
        {merchantPaymentProfileTarget && <React.Suspense fallback={null}><MerchantPaymentProfilePanel merchant={merchantPaymentProfileTarget} request={request} canActivate={canPlatformFinance || user.role === 'AGENCY_ADMIN'} onRequireStepUp={() => open('stepUp')} onClose={() => setMerchantPaymentProfileTarget(null)} /></React.Suspense>}
        {agencyCooperationTarget && <React.Suspense fallback={null}><AgencyCooperationPanel agency={agencyCooperationTarget} request={request} onClose={() => setAgencyCooperationTarget(null)} onSaved={() => { merchantScopeDirtyRef.current = true; void refresh(); }} /></React.Suspense>}
        {lastIssue && <React.Suspense fallback={null}><OperatorIssuePanel issue={lastIssue} open={issueDrawerOpen} onClose={() => setIssueDrawerOpen(false)} onRefresh={() => { setIssueDrawerOpen(false); void refresh(); }} /></React.Suspense>}
      {versionedPackage && <React.Suspense fallback={null}><PackageVersionModal deal={versionedPackage} versions={packageVersions} onClose={closePackageVersions} onRestore={restorePackageVersion} /></React.Suspense>}
      {versionedStore && <React.Suspense fallback={null}><StoreVersionModal store={versionedStore} versions={storeVersions} onClose={closeStoreVersions} onRestore={restoreStoreVersion} /></React.Suspense>}
      {versionedTemplateConfig && <React.Suspense fallback={null}><TemplateConfigVersionModal config={versionedTemplateConfig} versions={templateVersions} packages={templatePackages} onClose={closeTemplateVersions} onRestore={restoreTemplateVersion} /></React.Suspense>}
    </>}
  >
    {pageContent}
  </WorkspaceShell>;
}


export default function WorkspaceApp() {
  return <App />;
}
