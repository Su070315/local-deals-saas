import type {
  EditorFormValues,
  ModalKind,
  PasswordResetTarget,
  SupportTicket,
  TransferVoucher,
} from './workspace-model';

export type WorkspaceCommandContext = {
  modal: ModalKind;
  merchantId: string;
  merchantCreationIdempotencyKey: string;
  merchantProfileSubjectLocked: boolean;
  contractMerchantId: string;
  canPlatformOperate: boolean;
  canPlatformFinance: boolean;
  merchantStatusIdempotencyKey: string;
  transferVoucher: TransferVoucher | null;
  supportTicketToResolve: SupportTicket | null;
  exitCaseMerchantId: string;
  passwordResetTarget: PasswordResetTarget | null;
};

export type WorkspaceCommand = { path: string; method: 'POST' | 'PATCH'; headers?: HeadersInit; body: Record<string, unknown> };

/** Converts a typed editor intent into one auditable API command without touching React state. */
export function buildWorkspaceCommand(values: EditorFormValues, context: WorkspaceCommandContext): WorkspaceCommand {
  const {
    modal, merchantId, merchantCreationIdempotencyKey, merchantProfileSubjectLocked, contractMerchantId, canPlatformOperate, canPlatformFinance, merchantStatusIdempotencyKey,
    transferVoucher, supportTicketToResolve, exitCaseMerchantId, passwordResetTarget,
  } = context;
  let path = '';
  let method: 'POST' | 'PATCH' = 'POST';
  let headers: HeadersInit | undefined;
  let body: Record<string, unknown> = { ...values };

  if (modal === 'agency') path = '/agencies';
  if (modal === 'merchant') {
    if (!merchantCreationIdempotencyKey) throw new Error('商家创建请求标识丢失，请重新打开表单');
    path = '/merchants';
    headers = { 'Idempotency-Key': merchantCreationIdempotencyKey };
  }
  if (modal === 'merchantProfile') {
    path = `/merchants/${merchantId}`;
    method = 'PATCH';
    body = { brandName: values.brandName, servicePhone: values.servicePhone || '', primaryColor: values.primaryColor, ...(merchantProfileSubjectLocked ? {} : { legalName: values.legalName }) };
  }
  if (modal === 'contract') {
    if (canPlatformOperate && !merchantStatusIdempotencyKey) throw new Error('商家经营状态请求标识丢失，请重新打开表单');
    path = `/merchants/${contractMerchantId}`;
    method = 'PATCH';
    headers = canPlatformOperate ? { 'Idempotency-Key': merchantStatusIdempotencyKey } : undefined;
    body = {
      ...(canPlatformFinance ? { contractNumber: values.contractNumber || '', contractEndsAt: values.contractEndsAt || null } : {}),
      ...(canPlatformOperate ? { status: values.status, expectedStatus: values.expectedStatus, ...(values.statusReason ? { statusReason: values.statusReason } : {}) } : {}),
    };
  }
  if (modal === 'template') {
    path = `/merchants/${merchantId}/template-config`;
    method = 'PATCH';
    body = { expectedVersion: Number(values.expectedVersion), homeTitle: values.homeTitle || '', homeSubtitle: values.homeSubtitle || '', featuredPackageId: values.featuredPackageId || null };
  }
  if (modal === 'store') {
    path = `/merchants/${merchantId}/stores`;
    body = { ...values };
    delete body.initialOpenForVerification;
  }
  if (modal === 'package') {
    path = `/merchants/${merchantId}/packages`;
    body = {
      ...values,
      priceFen: Math.round(Number(values.priceYuan) * 100),
      originalPriceFen: values.originalPriceYuan ? Math.round(Number(values.originalPriceYuan) * 100) : null,
      memberPriceFen: values.memberPriceYuan ? Math.round(Number(values.memberPriceYuan) * 100) : null,
      purchasePriceFen: values.purchasePriceYuan ? Math.round(Number(values.purchasePriceYuan) * 100) : null,
      saleLimit: Number(values.saleLimit || 0),
      perCustomerLimit: Number(values.perCustomerLimit || 0),
      minPurchaseQuantity: Number(values.minPurchaseQuantity || 1),
      virtualSales: Number(values.virtualSales || 0),
      inventoryWarningThreshold: Number(values.inventoryWarningThreshold || 0),
      storeIds: values.storeIds,
      tags: Array.isArray(values.tags) ? values.tags : [],
      galleryUrls: Array.isArray(values.galleryUrls) ? values.galleryUrls.filter(Boolean) : [],
      fulfillmentMethods: Array.isArray(values.fulfillmentMethods) ? values.fulfillmentMethods : ['STORE_PICKUP'],
      salesChannels: Array.isArray(values.salesChannels) ? values.salesChannels : ['ONLINE', 'OFFLINE'],
      guaranteeLabels: Array.isArray(values.guaranteeLabels) ? values.guaranteeLabels : [],
      parameterValues: Array.isArray(values.parameterValues) ? values.parameterValues : [],
      validityMode: values.validityMode || 'ABSOLUTE',
      validityDurationDays: values.validityMode === 'PURCHASE_RELATIVE' ? Number(values.validityDurationDays) : null,
      status: values.status || 'DRAFT',
    };
    delete body.priceYuan;
    delete body.originalPriceYuan;
    delete body.memberPriceYuan;
    delete body.purchasePriceYuan;
  }
  if (modal === 'staff') path = `/merchants/${merchantId}/staff`;
  if (modal === 'exceptionRefund') {
    path = `/merchants/${merchantId}/exception-refund-requests`;
    body = { voucherId: values.voucherId, content: values.content };
  }
  if (modal === 'voucherTransfer' && transferVoucher) {
    path = `/vouchers/${transferVoucher.id}/transfer-store`;
    body = { targetStoreId: values.targetStoreId };
  }
  if (modal === 'supportResolution' && supportTicketToResolve) {
    path = `/support-tickets/${supportTicketToResolve.id}/resolve`;
    body = { note: values.note };
  }
  if (modal === 'supportReply' && supportTicketToResolve) {
    path = `/support-tickets/${supportTicketToResolve.id}/replies`;
    body = { content: values.content };
  }
  if (modal === 'exceptionRefundExecution' && supportTicketToResolve) {
    path = `/support-tickets/${supportTicketToResolve.id}/execute-exception-refund`;
    body = { note: values.note };
  }
  if ((modal === 'exceptionRefundApprove' || modal === 'exceptionRefundReject') && supportTicketToResolve) {
    path = `/support-tickets/${supportTicketToResolve.id}/${modal === 'exceptionRefundApprove' ? 'approve' : 'reject'}-exception-refund`;
    body = { note: values.note };
  }
  if (['exitRequest', 'exitFulfillment', 'exitPrepareExport', 'exitDataConfirm', 'exitAuthorizationConfirm'].includes(String(modal))) {
    if (!exitCaseMerchantId) throw new Error('未选择离场商家');
    const suffix = ({ exitRequest: '', exitFulfillment: '/start-fulfillment', exitPrepareExport: '/prepare-export', exitDataConfirm: '/confirm-data-export', exitAuthorizationConfirm: '/acknowledge-authorization-revocation' } as Record<string, string>)[String(modal)];
    path = `/merchants/${exitCaseMerchantId}/exit-case${suffix}`;
    body = { note: values.note };
  }
  if (modal === 'password') {
    path = '/auth/password';
    body = { currentPassword: values.currentPassword, newPassword: values.newPassword };
  }
  if (modal === 'stepUp') {
    path = '/auth/sensitive-action/verify';
    body = { currentPassword: values.currentPassword };
  }
  if (modal === 'supervisorPassword') {
    if (!passwordResetTarget) throw new Error('未选择要重置密码的账号');
    path = `/auth/users/${passwordResetTarget.id}/password-reset`;
    body = { newPassword: values.newPassword };
  }
  if (!path) throw new Error('当前操作未配置请求路径，请刷新后重试');
  return { path, method, headers, body };
}
