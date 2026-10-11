import { access, readFile, stat } from 'node:fs/promises';

const budgets = [
  // These ceilings lock in the first extraction. Reduce them as each domain
  // moves out; increasing them requires an explicit architecture review.
  // The core service is still in a compatibility window, but it must keep
  // shrinking as domain services take ownership of their invariants.
  ['apps/api/src/customer-commerce.service.ts', 240],
  ['apps/api/src/merchant-exit.service.ts', 280],
  ['apps/api/src/merchant-template.service.ts', 130],
  ['apps/api/src/registration-workflow.service.ts', 160],
  ['apps/api/src/tenant-administration.service.ts', 430],
  ['apps/api/src/commission-rate.service.ts', 190],
  ['apps/api/src/platform-work-queue.service.ts', 130],
  ['apps/api/src/transaction-read.service.ts', 125],
  ['apps/api/src/audit-read.service.ts', 90],
  ['apps/api/src/lifecycle-orchestration.service.ts', 150],
  ['apps/api/src/merchant-overview.service.ts', 150],
  ['apps/api/src/merchant-query-scope.service.ts', 100],
  ['apps/api/src/voucher-fulfillment.service.ts', 80],
  ['apps/api/src/package.service.ts', 260],
  ['apps/api/src/store.service.ts', 240],
  ['apps/api/src/staff.service.ts', 190],
  ['apps/api/src/staff-batch-operation.service.ts', 180],
  ['apps/api/src/voucher-batch-operation.service.ts', 130],
  ['apps/api/src/refund-batch-operation.service.ts', 130],
  ['apps/api/src/support-ticket.service.ts', 380],
  ['apps/api/src/accounting-adjustment.service.ts', 240],
  ['apps/api/src/billing.service.ts', 360],
  ['apps/api/src/bill-payment-confirmation.service.ts', 190],
  ['apps/api/src/billing-policy.ts', 120],
  ['apps/api/src/batch-operation.service.ts', 150],
  ['apps/api/src/batch-operation-processor.service.ts', 140],
  ['apps/api/src/merchant-import.service.ts', 220],
  ['apps/api/src/merchant-admin-invite.service.ts', 280],
  ['apps/api/src/reporting.service.ts', 190],
  ['apps/api/src/export.service.ts', 400],
  ['apps/api/src/refund.service.ts', 260],
  ['apps/api/src/verification.service.ts', 180],
  ['apps/api/src/payment-processing.service.ts', 340],
  ['apps/api/src/notifications/notification-outbox.service.ts', 230],
  ['apps/api/src/platform-runtime-control.service.ts', 240],
  ['apps/api/src/openapi.ts', 260],
  ['apps/api/src/openapi-response.ts', 220],
  ['apps/api/src/merchant-access.service.ts', 90],
  ['apps/api/src/audit-writer.service.ts', 90],
  ['apps/api/src/demo-fixture.service.ts', 70],
  ['apps/api/src/demo-identity-fixture.service.ts', 55],
  ['apps/api/src/demo.controller.ts', 65],
  ['apps/admin/src/workspace-app.tsx', 470],
  ['apps/admin/src/features/workspace-shell.tsx', 200],
  ['apps/admin/src/features/workspace-page-action.tsx', 150],
  ['apps/admin/src/features/workspace-page-content.tsx', 120],
  ['apps/admin/src/features/runtime-controls-page.tsx', 140],
  ['apps/admin/src/features/workspace-navigation.tsx', 100],
  ['apps/admin/src/features/use-export-operations.ts', 140],
  ['apps/admin/src/features/operator-issue.ts', 120],
  ['apps/admin/src/features/operator-issue-panel.tsx', 60],
  ['apps/admin/src/features/workspace-runtime.ts', 100],
  ['apps/admin/src/features/use-finance-exit-operations.tsx', 100],
  ['apps/admin/src/features/use-version-history-operations.ts', 115],
  ['apps/admin/src/features/use-support-refund-operations.ts', 100],
  ['apps/admin/src/features/use-session-operations.ts', 55],
  ['apps/admin/src/features/use-catalog-staff-operations.ts', 120],
  ['apps/admin/src/features/workspace-command-feedback.ts', 50],
  ['apps/admin/src/features/workspace-widgets.tsx', 90],
  ['apps/admin/src/features/merchant-operation-panels.tsx', 90],
  ['apps/admin/src/features/version-history-modals.tsx', 90],
  ['apps/admin/src/features/workspace-editor.tsx', 90],
  ['apps/admin/src/features/workspace-data-page.tsx', 90],
  ['apps/admin/src/features/data-table-shell.tsx', 40],
  ['apps/admin/src/features/agency-merchant-data-page.tsx', 80],
  ['apps/admin/src/features/catalog-data-page.tsx', 80],
  ['apps/admin/src/features/staff-data-page.tsx', 50],
  ['apps/admin/src/features/transaction-data-page.tsx', 75],
  ['apps/admin/src/features/support-data-page.tsx', 70],
  ['apps/admin/src/features/audit-data-page.tsx', 40],
  ['apps/admin/src/features/billing-page.tsx', 100],
  ['apps/admin/src/features/package-editor-fields.tsx', 80],
  ['apps/admin/src/features/store-editor-fields.tsx', 80],
  ['apps/admin/src/features/staff-editor-fields.tsx', 60],
  ['apps/admin/src/features/support-editor-fields.tsx', 100],
  ['apps/admin/src/features/password-policy.ts', 40],
  ['apps/admin/src/features/reporting-page.tsx', 100],
  ['apps/admin/src/features/workspace-commands.ts', 240],
  ['apps/admin/src/features/merchant-import-panel.tsx', 160],
  ['apps/admin/src/features/merchant-import-csv.ts', 100],
  ['apps/admin/src/features/merchant-admin-invite-panel.tsx', 120],
  ['apps/admin/src/features/merchant-invite-acceptance.tsx', 100],
];
const byteBudgets = [
  ['apps/api/src/notifications/notification-outbox.service.ts', 13_000],
  ['apps/api/src/platform-runtime-control.service.ts', 15_000],
  ['apps/api/src/billing-policy.ts', 8_000],
  ['apps/api/src/billing.service.ts', 23_000],
  ['apps/api/src/bill-payment-confirmation.service.ts', 14_000],
  ['apps/admin/src/workspace-app.tsx', 40_000],
  ['apps/admin/src/features/workspace-shell.tsx', 8_000],
  ['apps/admin/src/features/workspace-page-action.tsx', 7_000],
  ['apps/admin/src/features/workspace-page-content.tsx', 9_000],
  ['apps/admin/src/features/runtime-controls-page.tsx', 11_000],
  ['apps/admin/src/features/workspace-navigation.tsx', 10_000],
  ['apps/admin/src/features/use-export-operations.ts', 8_000],
  ['apps/admin/src/features/operator-issue.ts', 7_000],
  ['apps/admin/src/features/operator-issue-panel.tsx', 4_000],
  ['apps/admin/src/features/workspace-runtime.ts', 5_500],
  ['apps/admin/src/features/use-finance-exit-operations.tsx', 6_500],
  ['apps/admin/src/features/use-version-history-operations.ts', 5_000],
  ['apps/admin/src/features/use-support-refund-operations.ts', 5_500],
  ['apps/admin/src/features/use-session-operations.ts', 3_000],
  ['apps/admin/src/features/use-catalog-staff-operations.ts', 6_000],
  ['apps/admin/src/features/workspace-command-feedback.ts', 2_500],
  ['apps/admin/src/features/workspace-editor.tsx', 22_000],
  ['apps/admin/src/features/workspace-data-page.tsx', 6_000],
  ['apps/admin/src/features/agency-merchant-data-page.tsx', 5_500],
  ['apps/admin/src/features/catalog-data-page.tsx', 5_500],
  ['apps/admin/src/features/staff-data-page.tsx', 2_500],
  ['apps/admin/src/features/transaction-data-page.tsx', 5_000],
  ['apps/admin/src/features/support-data-page.tsx', 5_500],
  ['apps/admin/src/features/audit-data-page.tsx', 2_000],
  ['apps/admin/src/features/billing-page.tsx', 6_500],
  ['apps/admin/src/features/package-editor-fields.tsx', 4_000],
  ['apps/admin/src/features/store-editor-fields.tsx', 4_000],
  ['apps/admin/src/features/staff-editor-fields.tsx', 2_000],
  ['apps/admin/src/features/support-editor-fields.tsx', 6_500],
  ['apps/admin/src/features/password-policy.ts', 1_500],
  ['apps/admin/src/features/reporting-page.tsx', 12_000],
  ['apps/admin/src/features/workspace-commands.ts', 11_000],
  ['apps/admin/src/features/merchant-import-panel.tsx', 12_000],
  ['apps/admin/src/features/merchant-import-csv.ts', 6_000],
  ['apps/admin/src/features/merchant-admin-invite-panel.tsx', 8_000],
  ['apps/admin/src/features/merchant-invite-acceptance.tsx', 6_000],
];

const failures = [];
for (const [path, maximumLines] of budgets) {
  const source = await readFile(path, 'utf8');
  const lines = source.split(/\r?\n/).length;
  if (lines > maximumLines) failures.push(`${path} 为 ${lines} 行，超过渐进拆分预算 ${maximumLines} 行`);
  else console.log(`PASS ${path} ${lines}/${maximumLines} 行`);
}
for (const [path, maximumBytes] of byteBudgets) {
  const { size } = await stat(path);
  if (size > maximumBytes) failures.push(`${path} 为 ${size} 字节，超过模块体积预算 ${maximumBytes} 字节`);
  else console.log(`PASS ${path} ${size}/${maximumBytes} 字节`);
}

const workspace = await readFile('apps/admin/src/workspace-app.tsx', 'utf8');
const workspacePageContentSource = await readFile('apps/admin/src/features/workspace-page-content.tsx', 'utf8');
const workspacePageActionSource = await readFile('apps/admin/src/features/workspace-page-action.tsx', 'utf8');
const versionHistoryOperationsSource = await readFile('apps/admin/src/features/use-version-history-operations.ts', 'utf8');
const supportRefundOperationsSource = await readFile('apps/admin/src/features/use-support-refund-operations.ts', 'utf8');
const sessionOperationsSource = await readFile('apps/admin/src/features/use-session-operations.ts', 'utf8');
const catalogStaffOperationsSource = await readFile('apps/admin/src/features/use-catalog-staff-operations.ts', 'utf8');
const notificationOutboxSource = await readFile('apps/api/src/notifications/notification-outbox.service.ts', 'utf8');
const runtimeControlSource = await readFile('apps/api/src/platform-runtime-control.service.ts', 'utf8');
const billingServiceSource = await readFile('apps/api/src/billing.service.ts', 'utf8');
const supportTicketSource = await readFile('apps/api/src/support-ticket.service.ts', 'utf8');
const billPaymentConfirmationSource = await readFile('apps/api/src/bill-payment-confirmation.service.ts', 'utf8');
const billingControllerSource = await readFile('apps/api/src/app.controller.ts', 'utf8');
const billingModuleSource = await readFile('apps/api/src/app.module.ts', 'utf8');
if (!workspace.includes("from './features/workspace-model'")) failures.push('工作台共享模型未保持独立模块');
else console.log('PASS 工作台共享模型保持独立');
if (!workspace.includes("from './features/workspace-navigation'") || workspace.includes("group('工作台'")) failures.push('角色菜单和页面元数据未保持独立模块');
else console.log('PASS 角色菜单和页面元数据保持独立');
if (!workspace.includes("React.lazy(() => import('./features/workspace-page-content')")) failures.push('工作台页面渲染未保持按需模块边界');
else console.log('PASS 工作台页面渲染保持独立按需模块');
if (!workspace.includes("from './features/use-export-operations'") || workspace.includes('async function exportData')) failures.push('导出任务交互编排未保持独立模块');
else console.log('PASS 导出任务交互编排保持独立');
if (!workspace.includes("from './features/use-finance-exit-operations'") || workspace.includes('async function generateBill') || workspace.includes('openExitReadiness(merchant')) failures.push('账务与离场命令编排未保持独立模块');
else console.log('PASS 账务与离场命令编排保持独立模块');
if (!workspace.includes("from './features/use-version-history-operations'") || workspace.includes('async function restorePackageVersion') || workspace.includes('async function restoreStoreVersion') || workspace.includes('async function restoreTemplateVersion') || !['openPackageVersions', 'restorePackageVersion', 'openStoreVersions', 'restoreStoreVersion', 'openTemplateVersions', 'restoreTemplateVersion'].every((method) => versionHistoryOperationsSource.includes(`function ${method}`))) failures.push('套餐、门店和品牌主页版本恢复编排未保持独立模块');
else console.log('PASS 版本历史与恢复编排保持独立');
if (!workspace.includes("from './features/use-support-refund-operations'") || workspace.includes('async function retryVoucherRefund') || workspace.includes('async function openSupportTicketModal') || !['openExceptionRefund', 'retryVoucherRefund', 'refundClosedStoreVoucher', 'openSupportTicketModal'].every((method) => supportRefundOperationsSource.includes(`function ${method}`))) failures.push('售后与退款交互编排未保持独立模块');
else console.log('PASS 售后与退款交互编排保持独立');
if (!workspace.includes("from './features/use-session-operations'") || workspace.includes('async function revokeSession') || workspace.includes('async function logoutOthers') || !['logout', 'revokeSession', 'logoutOthers'].every((method) => sessionOperationsSource.includes(`function ${method}`))) failures.push('设备会话退出与撤销编排未保持独立模块');
else console.log('PASS 设备会话操作保持独立');
if (!workspace.includes("from './features/use-catalog-staff-operations'") || ['function editStore', 'async function changeStoreSale', 'function editPackage', 'async function changePackageStatus', 'function editStaff', 'async function disableStaff'].some((method) => workspace.includes(method)) || !['editStore', 'changeStoreSale', 'editPackage', 'changePackageStatus', 'editStaff', 'changeStaffActive'].every((method) => catalogStaffOperationsSource.includes(`function ${method}`)) || !catalogStaffOperationsSource.includes("'Idempotency-Key'")) failures.push('门店、套餐和核销员编辑与状态操作未保持独立领域边界或丢失幂等保护');
else console.log('PASS 门店、套餐和核销员操作保持独立领域边界与幂等保护');
if (!workspace.includes("from './features/workspace-command-feedback'") || workspace.includes("modal === 'billPaymentApprove'")) failures.push('工作台命令成功反馈未保持独立模块');
else console.log('PASS 工作台命令成功反馈保持独立模块');
if (!billingServiceSource.includes("throw new GoneException('本地服务费月结账单已停用") || !billPaymentConfirmationSource.includes("throw new GoneException('本地人工收款确认已停用") || !billingControllerSource.includes('this.billPaymentConfirmations.request(user, billId, body, idempotencyKey)') || !billingModuleSource.includes('BillPaymentConfirmationService')) failures.push('线下合作费的本地收款入口没有保持安全下线');
else console.log('PASS 本地月结与人工收款入口已安全下线，历史记录仍可读取');
if (!billingServiceSource.includes('merchantScope.resolve') || !billingServiceSource.includes('merchantScope.apply')) failures.push('月结账单列表未在数据库查询中复用租户范围');
if (!workspace.includes("from './features/operator-issue'") || !workspace.includes("React.lazy(() => import('./features/operator-issue-panel')") || !workspace.includes('<OperatorIssuePanel')) failures.push('运营问题诊断未保持统一按需入口');
else console.log('PASS 运营问题诊断保持统一入口');
if (!workspacePageContentSource.includes("React.lazy(() => import('./workspace-data-page'))")) failures.push('运营列表入口未保持路由级惰性加载');
else console.log('PASS 运营列表入口保持惰性加载');
if (!workspacePageContentSource.includes("React.lazy(() => import('./runtime-controls-page'))")) failures.push('全局销售控制未保持路由级惰性加载');
else console.log('PASS 全局销售控制保持惰性加载');
if (!workspace.includes("React.lazy(() => import('./features/workspace-editor')") || !workspace.includes('modal && <React.Suspense')) failures.push('低频编辑器未保持打开时按需加载');
else console.log('PASS 低频编辑器仅在打开时按需加载');
if (!workspace.includes("React.lazy(() => import('./features/version-history-modals')") || !workspace.includes('versionedPackage && <React.Suspense')) failures.push('版本恢复弹窗未保持按需加载');
else console.log('PASS 版本恢复弹窗保持按需加载');
if (!workspacePageActionSource.includes("React.lazy(() => import('./merchant-import-panel'))")) failures.push('商家批量导入界面未保持按需加载');
else console.log('PASS 商家批量导入界面保持按需加载');
if (!workspace.includes("React.lazy(() => import('./features/merchant-admin-invite-panel'))") || !workspace.includes('merchantAdminInviteTarget')) failures.push('管理员邀请界面未保持按需加载或未保持单目标边界');
else console.log('PASS 管理员邀请界面保持按需加载');

const [merchantImportPanelSource, merchantImportCsvSource] = await Promise.all([
  readFile('apps/admin/src/features/merchant-import-panel.tsx', 'utf8'),
  readFile('apps/admin/src/features/merchant-import-csv.ts', 'utf8'),
]);
for (const invariant of ['/agencies/${agencyId}/merchants/batch-import', "'Idempotency-Key'", 'crypto.randomUUID()', '/merchant-import-operations/${operation.id}', "user.role === 'PLATFORM_ADMIN'"]) {
  if (!merchantImportPanelSource.includes(invariant)) failures.push(`商家批量导入界面缺少关键不变量：${invariant}`);
}
for (const invariant of ['externalRef', 'legalName', 'brandName', 'servicePhone', 'items.length > 100', 'allowFinancialTerms', 'allowedHeaders']) {
  if (!merchantImportCsvSource.includes(invariant)) failures.push(`商家批量导入 CSV 校验缺少关键不变量：${invariant}`);
}
if (/adminPassword|password/i.test(merchantImportPanelSource + merchantImportCsvSource)) failures.push('商家批量导入界面不得处理管理员密码');
else console.log('PASS 商家批量导入界面不接触管理员密码');
const [merchantAdminInviteSource, merchantAdminInviteMigrationSource, authInviteAcceptanceSource] = await Promise.all([
  readFile('apps/api/src/merchant-admin-invite.service.ts', 'utf8'),
  readFile('apps/api/src/migrations/1784335500000-MerchantAdminInvites.ts', 'utf8'),
  readFile('apps/admin/src/features/merchant-invite-acceptance.tsx', 'utf8'),
]);
for (const invariant of ['tokenHash', 'tokenCiphertext', 'randomBytes(32)', 'pessimistic_write', 'expiresAt', 'revokedAt', 'consumedAt', 'bcrypt.hash', 'MERCHANT_ADMIN_INVITE_CREATED', 'MERCHANT_ADMIN_INVITE_ACCEPTED', 'idempotencyKey']) {
  if (!merchantAdminInviteSource.includes(invariant)) failures.push(`管理员邀请服务缺少关键不变量：${invariant}`);
}
if (!authInviteAcceptanceSource.includes('/auth/merchant-admin-invites/accept') || !authInviteAcceptanceSource.includes('token')) failures.push('商家管理员首登页面未调用公开接受接口');
else console.log('PASS 管理员邀请令牌、接受和首登页面安全边界保持');

const dataPagePaths = [
  'apps/admin/src/features/workspace-data-page.tsx',
  'apps/admin/src/features/agency-merchant-data-page.tsx',
  'apps/admin/src/features/catalog-data-page.tsx',
  'apps/admin/src/features/staff-data-page.tsx',
  'apps/admin/src/features/transaction-data-page.tsx',
  'apps/admin/src/features/support-data-page.tsx',
  'apps/admin/src/features/audit-data-page.tsx',
];
const dataPageSources = await Promise.all(dataPagePaths.map((path) => readFile(path, 'utf8')));
if (dataPageSources.some((source) => /ColumnsType\s*<\s*any\s*>/.test(source))) failures.push('运营列表重新引入 ColumnsType<any>');
else console.log('PASS 运营列表列定义保持领域类型安全');
for (const moduleName of ['agency-merchant-data-page', 'catalog-data-page', 'staff-data-page', 'transaction-data-page', 'support-data-page', 'audit-data-page']) {
  if (!dataPageSources[0].includes(`import('./${moduleName}')`)) failures.push(`运营列表入口未惰性加载 ${moduleName}`);
}

try {
  await access('apps/api/src/app.service.ts');
  failures.push('遗留 AppService 文件重新出现，应继续使用明确领域服务');
} catch {
  console.log('PASS 遗留 AppService 已删除');
}
const appServiceSource = '';
const [merchantImportDtoSource, migrationIndexSource] = await Promise.all([
  readFile('apps/api/src/request.dto.ts', 'utf8'),
  readFile('apps/api/src/migrations/index.ts', 'utf8'),
]);
const [customerCommerceSource, merchantExitSource, merchantTemplateSource, registrationWorkflowSource, tenantAdministrationSource, commissionRateSource, platformWorkQueueSource, transactionReadSource, auditReadSource, lifecycleOrchestrationSource, merchantOverviewSource, merchantQueryScopeSource, voucherFulfillmentSource, lifecycleWorkerSource, appControllerSource, paymentProcessingSource, refundServiceSource, storeServiceSource, staffServiceSource, batchOperationSource, batchOperationProcessorSource, staffBatchOperationSource, voucherBatchOperationSource, refundBatchOperationSource, merchantImportSource, appModuleSource, demoControllerSource, demoFixtureSource, demoIdentityFixtureSource] = await Promise.all([
  readFile('apps/api/src/customer-commerce.service.ts', 'utf8'),
  readFile('apps/api/src/merchant-exit.service.ts', 'utf8'),
  readFile('apps/api/src/merchant-template.service.ts', 'utf8'),
  readFile('apps/api/src/registration-workflow.service.ts', 'utf8'),
  readFile('apps/api/src/tenant-administration.service.ts', 'utf8'),
  readFile('apps/api/src/commission-rate.service.ts', 'utf8'),
  readFile('apps/api/src/platform-work-queue.service.ts', 'utf8'),
  readFile('apps/api/src/transaction-read.service.ts', 'utf8'),
  readFile('apps/api/src/audit-read.service.ts', 'utf8'),
  readFile('apps/api/src/lifecycle-orchestration.service.ts', 'utf8'),
  readFile('apps/api/src/merchant-overview.service.ts', 'utf8'),
  readFile('apps/api/src/merchant-query-scope.service.ts', 'utf8'),
  readFile('apps/api/src/voucher-fulfillment.service.ts', 'utf8'),
  readFile('apps/api/src/lifecycle.service.ts', 'utf8'),
  readFile('apps/api/src/app.controller.ts', 'utf8'),
  readFile('apps/api/src/payment-processing.service.ts', 'utf8'),
  readFile('apps/api/src/refund.service.ts', 'utf8'),
  readFile('apps/api/src/store.service.ts', 'utf8'),
  readFile('apps/api/src/staff.service.ts', 'utf8'),
  readFile('apps/api/src/batch-operation.service.ts', 'utf8'),
  readFile('apps/api/src/batch-operation-processor.service.ts', 'utf8'),
  readFile('apps/api/src/staff-batch-operation.service.ts', 'utf8'),
  readFile('apps/api/src/voucher-batch-operation.service.ts', 'utf8'),
  readFile('apps/api/src/refund-batch-operation.service.ts', 'utf8'),
  readFile('apps/api/src/merchant-import.service.ts', 'utf8'),
  readFile('apps/api/src/app.module.ts', 'utf8'),
  readFile('apps/api/src/demo.controller.ts', 'utf8'),
  readFile('apps/api/src/demo-fixture.service.ts', 'utf8'),
  readFile('apps/api/src/demo-identity-fixture.service.ts', 'utf8'),
]);
if (!appControllerSource.includes('MerchantAdminInviteService') || !appModuleSource.includes('MerchantAdminInviteService') || !appControllerSource.includes("merchant-admin-invites/accept")) failures.push('管理员邀请路由或服务未保持独立注册边界');
if (!merchantAdminInviteMigrationSource.includes('UQ_merchant_admin_invites_token') || !migrationIndexSource.includes('MerchantAdminInvites1784335500000')) failures.push('管理员邀请迁移未保持令牌唯一索引或迁移注册');
if (!appModuleSource.includes('const localOnlyControllers = isLocalOrTestEnvironment() ? [DemoController] : []') || !appModuleSource.includes('const localOnlyProviders = isLocalOrTestEnvironment() ? [DemoFixtureService, DemoIdentityFixtureService] : []')) failures.push('演示夹具未保持仅本地/测试环境注册');
else console.log('PASS 演示夹具只在本地或测试环境注册');
if (!demoControllerSource.includes('@ApiExcludeController()') || !demoControllerSource.includes('@Roles(UserRole.PLATFORM_ADMIN)')) failures.push('演示夹具路由未从生产契约排除或未限制平台账号');
else console.log('PASS 演示夹具从 OpenAPI 排除并限制平台账号');
for (const invariant of ['PlatformAccessProfile.FINANCE', 'BillStatus.DISPUTE_WINDOW', 'DEMO_MONTHLY_BILL_CREATED', 'existsBy({ merchantId, period: input.period })']) {
  if (!demoFixtureSource.includes(invariant)) failures.push(`演示账单夹具缺少安全不变量：${invariant}`);
}
for (const invariant of ['PlatformAccessProfile.SYSTEM_ADMIN', 'PlatformAccessProfile.FINANCE', 'assertPasswordPolicy', 'bcrypt.hash', 'DEMO_PLATFORM_FINANCE_CREATED']) {
  if (!demoIdentityFixtureSource.includes(invariant)) failures.push(`演示财务账号夹具缺少安全不变量：${invariant}`);
}
if (/PAYMENT_PROVIDER|paymentEventApplyLocks|persistPaymentEvent|claimPaymentOutbox/.test(appServiceSource)) failures.push('AppService 重新吸收了支付适配器或支付状态机职责');
else console.log('PASS AppService 不再承载支付适配器与支付状态机');
for (const invariant of ['setOnLocked(\'skip_locked\')', 'PAYMENT_EVENT_REQUIRES_RECONCILIATION', 'ORDER_PAYMENT_EXPIRED', 'normalizedHash', 'confirmDemoPayment']) {
  if (!paymentProcessingSource.includes(invariant)) failures.push(`支付处理服务缺少关键不变量：${invariant}`);
}
if (/listStores\(|saveStore\(|listStoreVersions\(|restoreStoreVersion\(|storeMutationLocks/.test(appServiceSource)) failures.push('AppService 重新吸收了门店配置或版本职责');
else console.log('PASS AppService 不再承载门店配置与版本状态机');
for (const invariant of ['pessimistic_write', 'mutationLocks', 'STORE_UPDATED', 'STORE_VERSION_RESTORED', 'openForVerification']) {
  if (!storeServiceSource.includes(invariant)) failures.push(`门店服务缺少关键不变量：${invariant}`);
}
if (/listUsers\(|saveStaff\(|setStaffActive\(|staffActiveCommand/.test(appServiceSource)) failures.push('AppService 重新吸收了员工账号或启停命令职责');
else console.log('PASS AppService 不再承载员工账号与启停命令');
for (const invariant of ['pessimistic_write', 'StaffActiveCommand', 'sessionVersion += 1', 'STAFF_DISABLED', 'requestHash']) {
  if (!staffServiceSource.includes(invariant)) failures.push(`员工服务缺少关键不变量：${invariant}`);
}
if (!appControllerSource.includes('private readonly staffBatchOperations: StaffBatchOperationService') || !appModuleSource.includes('StaffBatchOperationService')) failures.push('员工批量授权未通过独立领域服务注册和控制器边界');
for (const invariant of ['BatchOperationKind.STAFF_STORE_ACCESS', 'pessimistic_write', 'expectedStoreIds', 'sessionVersion += 1', 'STAFF_STORE_ACCESS_BATCH_CHANGED', 'requestHash']) {
  if (!staffBatchOperationSource.includes(invariant)) failures.push(`员工批量授权服务缺少关键不变量：${invariant}`);
}
if (!appControllerSource.includes('private readonly voucherBatchOperations: VoucherBatchOperationService') || !appModuleSource.includes('VoucherBatchOperationService')) failures.push('批量转店未通过独立领域服务注册和控制器边界');
if (!/@UseGuards\(StepUpAuthGuard\)\s+@Post\('merchants\/:merchantId\/vouchers\/batch-transfer-store'\)/.test(appControllerSource)) failures.push('批量转店路由未保持身份复验保护');
for (const invariant of ['UserRole.PLATFORM_ADMIN', 'PlatformAccessProfile.OPERATIONS', 'BatchOperationKind.VOUCHER_STORE_TRANSFER', 'requestHash', 'idempotencyKey', 'In(voucherIds)', 'In(targetStoreIds)', 'expectedStoreId', 'targetStoreId', 'voucherFulfillment.transferStoreWithManager', 'BATCH_OPERATION_REQUESTED']) {
  if (!voucherBatchOperationSource.includes(invariant)) failures.push(`批量转店服务缺少关键不变量：${invariant}`);
}
if (!appControllerSource.includes('private readonly refundBatchOperations: RefundBatchOperationService') || !appModuleSource.includes('RefundBatchOperationService')) failures.push('批量补偿退款未通过独立领域服务注册和控制器边界');
if (!/@UseGuards\(StepUpAuthGuard\)\s+@Post\('merchants\/:merchantId\/vouchers\/batch-compensation-refund'\)/.test(appControllerSource)) failures.push('批量补偿退款路由未保持身份复验保护');
for (const invariant of ['UserRole.PLATFORM_ADMIN', 'PlatformAccessProfile.FINANCE', 'BatchOperationKind.VOUCHER_COMPENSATION_REFUND', 'requestHash', 'idempotencyKey', 'In(voucherIds)', 'In(storeIds)', 'expectedStoreId', 'openForVerification', 'refunds.executeStoreClosureCompensationFromBatch', 'BATCH_OPERATION_REQUESTED']) {
  if (!refundBatchOperationSource.includes(invariant)) failures.push(`批量补偿退款服务缺少关键不变量：${invariant}`);
}
if (refundBatchOperationSource.includes('PAYMENT_PROVIDER')) failures.push('批量补偿退款任务绕过 RefundService 直接依赖支付适配器');
for (const invariant of ['STORE_CLOSURE_BATCH_COMPENSATION', 'expectedStoreId', 'requireStoreClosed: true', 'operationId', 'pessimistic_write', 'paymentProvider.refund']) {
  if (!refundServiceSource.includes(invariant)) failures.push(`退款服务缺少批量补偿安全不变量：${invariant}`);
}
if (!batchOperationSource.includes('private readonly processor: BatchOperationProcessorService') || !batchOperationSource.includes('return this.processor.processPending(limit)') || !appModuleSource.includes('BatchOperationProcessorService')) failures.push('批量任务执行器未保持独立注册和兼容委托边界');
if (/staffBatchOperations|voucherBatchOperations|refundBatchOperations|processPackageStatusItems/.test(batchOperationSource)) failures.push('批量任务请求服务重新吸收了具体任务执行职责');
for (const invariant of ['MerchantQueryScopeService', 'merchantScope.resolve', 'merchantScope.apply']) {
  if (!batchOperationSource.includes(invariant)) failures.push(`批量任务列表缺少租户 SQL 范围不变量：${invariant}`);
}
if (batchOperationSource.includes('scopedMerchantIds')) failures.push('批量任务列表重新物化全部商家 ID');
for (const invariant of ['pessimistic_write', 'BatchOperationStatus.PROCESSING', 'BatchOperationKind.STAFF_STORE_ACCESS', 'staffBatchOperations.processItems', 'BatchOperationKind.VOUCHER_STORE_TRANSFER', 'voucherBatchOperations.processItems', 'BatchOperationKind.VOUCHER_COMPENSATION_REFUND', 'refundBatchOperations.processItems(externalOperation', 'completeOperation', 'BATCH_OPERATION_FAILED']) {
  if (!batchOperationProcessorSource.includes(invariant)) failures.push(`批量任务执行器缺少关键不变量：${invariant}`);
}
for (const invariant of ['batchOperationService.processPending()']) {
  if (!lifecycleOrchestrationSource.includes(invariant)) failures.push(`批量任务编排缺少关键不变量：${invariant}`);
}
if (!appControllerSource.includes('private readonly merchantImport: MerchantImportService') || !appModuleSource.includes('MerchantImportService')) failures.push('商家批量导入未通过独立领域服务注册和控制器边界');
if (!/@UseGuards\(StepUpAuthGuard\)\s+@Post\('agencies\/:agencyId\/merchants\/batch-import'\)/.test(appControllerSource)) failures.push('商家批量导入路由未保持身份复验保护');
for (const invariant of ['CreateMerchantImportBatchDto', 'ArrayMaxSize(100)', 'externalRef']) {
  if (!merchantImportDtoSource.includes(invariant)) failures.push(`商家批量导入契约缺少字段约束：${invariant}`);
}
for (const invariant of ['UserRole.PLATFORM_ADMIN', 'UserRole.AGENCY_ADMIN', 'PlatformAccessProfile.OPERATIONS', 'agencyId', 'requestHash', 'idempotencyKey', 'pessimistic_write', 'tenantAdministration.createMerchant', 'merchant-import-${operation.id}', 'MERCHANT_IMPORT_REQUESTED', 'MERCHANT_IMPORT_COMPLETED', 'MERCHANT_IMPORT_FAILED', 'BatchOperationStatus.PARTIAL']) {
  if (!merchantImportSource.includes(invariant)) failures.push(`商家批量导入服务缺少关键不变量：${invariant}`);
}
if (/password|adminPassword/i.test(merchantImportSource)) failures.push('商家批量导入服务不得处理或保存管理员密码');
if (!lifecycleOrchestrationSource.includes('merchantImportService.processPending()')) failures.push('生命周期编排未处理商家批量导入任务');
if (!migrationIndexSource.includes('MerchantImportOperations1784335440000')) failures.push('商家批量导入迁移未注册');
if (/publicMerchant\(|publicMerchants\(|createOrder\(|customerVouchers\(|customerVoucherPage\(|dynamicCode\(/.test(appServiceSource)) failures.push('AppService 重新吸收了顾客店铺、下单或券包职责');
else console.log('PASS AppService 不再承载顾客店铺、下单和券包职责');
if (!appControllerSource.includes('private readonly customerCommerce: CustomerCommerceService')) failures.push('公开顾客控制器未直接依赖顾客交易服务');
for (const invariant of ['pessimistic_write', 'assertStoreApplies', 'commissionRateSnapshot', 'PaymentOutbox', 'dispatchPendingIntents(1)', 'idempotencyKey', 'customerVoucherPageCursor']) {
  if (!customerCommerceSource.includes(invariant)) failures.push(`顾客交易服务缺少关键不变量：${invariant}`);
}
if (/MerchantExitCase|MERCHANT_EXIT_|requestMerchantExit\(|advanceMerchantExit/.test(appServiceSource)) failures.push('AppService 重新吸收了商家离场状态机职责');
else console.log('PASS AppService 不再承载商家离场状态机');
if (!appControllerSource.includes('private readonly merchantExit: MerchantExitService')) failures.push('商家离场控制器未直接依赖离场服务');
for (const invariant of ['prepareStatusTransition', 'completeStatusTransition', 'pessimistic_write', 'EXIT_REQUESTED', 'SALE_PAUSED', 'FULFILLING', 'EXPORT_READY', 'CLOSED', 'PURGE_ELIGIBLE', 'dataExportConfirmedAt', 'authorizationRevocationAcknowledgedAt', 'pendingOrders', 'unsettledBills']) {
  if (!merchantExitSource.includes(invariant)) failures.push(`商家离场服务缺少关键不变量：${invariant}`);
}
if (/getMerchantTemplateConfig\(|saveMerchantTemplateConfig\(|listMerchantTemplateConfigVersions\(|restoreMerchantTemplateConfigVersion\(|MERCHANT_TEMPLATE_CONFIG_(SAVED|VERSION_RESTORED)/.test(appServiceSource)) failures.push('AppService 重新吸收了品牌主页版本职责');
else console.log('PASS AppService 不再承载品牌主页版本状态机');
if (!appControllerSource.includes('private readonly merchantTemplate: MerchantTemplateService')) failures.push('品牌主页控制器未直接依赖模板服务');
for (const invariant of ['pessimistic_write', 'expectedVersion', 'featuredPackageId', 'MERCHANT_TEMPLATE_CONFIG_SAVED', 'MERCHANT_TEMPLATE_CONFIG_VERSION_RESTORED', 'snapshotFromAudit']) {
  if (!merchantTemplateSource.includes(invariant)) failures.push(`品牌主页服务缺少关键不变量：${invariant}`);
}
if (/registrationTransitions|registrationForMerchant|canTransitionRegistration|getMerchantRegistration|updateMerchantRegistration/.test(appServiceSource)) failures.push('AppService 重新吸收了开户注册状态机职责');
else console.log('PASS AppService 不再承载开户注册状态机');
if (!appControllerSource.includes('private readonly registrationWorkflow: RegistrationWorkflowService')) failures.push('开户注册控制器未直接依赖开户注册服务');
for (const invariant of ['TRANSITIONS', 'pessimistic_write', 'PlatformAccessProfile.COMPLIANCE', 'failureReason', 'MERCHANT_REGISTRATION_STATUS_CHANGED', 'assertLegalNameEditable']) {
  if (!registrationWorkflowSource.includes(invariant)) failures.push(`开户注册服务缺少关键不变量：${invariant}`);
}
if (/listAgencies\(|createAgency\(|setAgencyActive\(|listMerchants\(|createMerchant\(|updateMerchant\(|resetManagedPassword\(|merchantCreationRequestHash|merchantStatusCommandRequestHash/.test(appServiceSource)) failures.push('AppService 重新吸收了代理商、商家或层级账号管理职责');
else console.log('PASS AppService 不再承载代理商、商家和层级账号管理');
if (!appControllerSource.includes('private readonly tenantAdministration: TenantAdministrationService')) failures.push('代理商与商家控制器未直接依赖租户管理服务');
if (!merchantOverviewSource.includes('merchantScope.resolve') || !merchantOverviewSource.includes('merchantScope.apply')) failures.push('商家概览跨租户读取未在数据库查询中复用租户范围');
for (const invariant of ['pessimistic_write', 'creationRequestHash', 'sameMerchantCreationRetry', 'MerchantStatusChangeCommand', 'sessionVersion += 1', 'AuthSession', 'prepareStatusTransition', 'completeStatusTransition', 'assertLegalNameEditable', 'USER_PASSWORD_RESET_BY_SUPERVISOR']) {
  if (!tenantAdministrationSource.includes(invariant)) failures.push(`租户管理服务缺少关键不变量：${invariant}`);
}
if (/addRate\(|listRates\(|listRateChangeRequests\(|listPlatformRateChangeRequests\(|reviewRateChangeRequest\(|RateChangeRequest|CommissionRateVersion/.test(appServiceSource)) failures.push('AppService 重新吸收了费率版本或双人复核职责');
else console.log('PASS AppService 不再承载费率版本与双人复核');
if (!appControllerSource.includes('private readonly commissionRate: CommissionRateService')) failures.push('费率控制器未直接依赖费率服务');
for (const invariant of ["throw new GoneException('本地人工费率已停用", "throw new GoneException('本地人工费率复核已停用", 'listVersions', 'listRequests', 'listPlatformRequests']) {
  if (!commissionRateSource.includes(invariant)) failures.push(`费率只读同步边界缺少关键约束：${invariant}`);
}
if (/platformWorkQueue\(|SupportTicketSource|closedStoreVouchersQuery|billsRequiringAttention/.test(appServiceSource)) failures.push('AppService 重新吸收了平台运营工作队列聚合职责');
else console.log('PASS AppService 不再承载平台运营工作队列聚合');
if (!appControllerSource.includes('private readonly platformWorkQueue: PlatformWorkQueueService')) failures.push('平台待办控制器未直接依赖工作队列服务');
for (const invariant of ['PlatformAccessProfile.OPERATIONS', 'PlatformAccessProfile.FINANCE', 'closedStoreVouchersQuery', 'firstResponseDueAt', 'failedRefunds', 'billsRequiringAttention']) {
  if (!platformWorkQueueSource.includes(invariant)) failures.push(`平台工作队列服务缺少关键不变量：${invariant}`);
}
if (/listOrders\(|listVouchers\(|listVerifications\(|transactionMerchantIds|orderListItem\(|verificationListItem\(/.test(appServiceSource)) failures.push('AppService 重新吸收了交易运营读取职责');
else console.log('PASS AppService 不再承载订单、券和核销运营读取');
if (!appControllerSource.includes('private readonly transactionRead: TransactionReadService')) failures.push('交易列表控制器未直接依赖交易读取服务');
for (const invariant of ['offset >= 100_000', "order.createdAt', 'DESC'", "verification.verifiedAt', 'DESC'", 'merchantScope.resolve', 'storeIds, staffId', 'refundsByVoucherId', 'paymentReference: _paymentReference', 'commissionRateSnapshot: _commissionRateSnapshot']) {
  if (!transactionReadSource.includes(invariant)) failures.push(`交易读取服务缺少关键不变量：${invariant}`);
}
for (const invariant of ['MerchantQueryScope', 'MerchantAccessService', 'scopeMerchant.agencyId', 'scopeMerchantId', 'scopeAgencyId', '1 = 0']) {
  if (!merchantQueryScopeSource.includes(invariant)) failures.push(`租户 SQL 范围服务缺少关键不变量：${invariant}`);
}
for (const invariant of ['MerchantQueryScopeService', 'merchantScope.resolve', 'merchantScope.apply', 'ticket.source = :ticketSource', 'SupportTicketType.EXCEPTION_REFUND']) {
  if (!supportTicketSource.includes(invariant)) failures.push(`售后工单服务缺少关键租户查询不变量：${invariant}`);
}
if (!migrationIndexSource.includes('ReportingScopeIndexes1784335740000')) failures.push('报表租户范围复合索引迁移未注册');
if (/createExportJob\(|listExportJobs\(|getExportJob\(|exportQueueStatus\(|processExportJobs\(|downloadExportJob\(|revokeExportJob\(|expireExportJobs\(/.test(appServiceSource)) failures.push('AppService 重新吸收了导出任务代理职责');
else console.log('PASS AppService 不再承载导出任务代理');
if (!appControllerSource.includes('private readonly exports: ExportService')) failures.push('导出控制器未直接依赖导出服务');
if (/listAudits\(|listPlatformAudits\(|auditIntegrity\(|auditListItem\(/.test(appServiceSource)) failures.push('AppService 重新吸收了审计读取或完整性检查职责');
else console.log('PASS AppService 不再承载审计读取与完整性检查');
if (!appControllerSource.includes('private readonly auditRead: AuditReadService')) failures.push('审计控制器未直接依赖审计读取服务');
for (const invariant of ['PlatformAccessProfile.SECURITY', 'UserRole.STORE_STAFF', 'offset >= 100_000', "createdAt: 'DESC', id: 'DESC'", "startsWith('customer:')", 'ipAddress: record.ipAddress', 'merchantId: IsNull()', 'auditChain.verify()', 'auditOutbox.queueStatus()']) {
  if (!auditReadSource.includes(invariant)) failures.push(`审计读取服务缺少关键不变量：${invariant}`);
}
if (/runLifecycleSweep\(|processExpiryQueues\(|expirePendingOrders\(|suspendExpiredContracts\(|dispatchPendingPaymentIntents\(|reconcileDispatchedPaymentIntents\(|VOUCHER_EXPIRED|MERCHANT_CONTRACT_EXPIRED/.test(appServiceSource)) failures.push('AppService 重新吸收了生命周期编排或过期处理职责');
else console.log('PASS AppService 不再承载生命周期编排与过期处理');
if (!lifecycleWorkerSource.includes('private readonly lifecycle: LifecycleOrchestrationService')) failures.push('生命周期 Worker 未直接依赖生命周期编排服务');
if (!appControllerSource.includes('private readonly payments: PaymentProcessingService')) failures.push('支付 webhook 控制器未直接依赖支付处理服务');
if (!appControllerSource.includes('private readonly refunds: RefundService')) failures.push('退款控制器未直接依赖退款服务');
if (!appControllerSource.includes('private readonly verification: VerificationService')) failures.push('核销控制器未直接依赖核销服务');
for (const invariant of ['paymentProcessing.dispatchPendingIntents', 'paymentProcessing.reconcileDispatchedIntents', 'paymentProcessing.expirePendingOrders', 'pessimistic_write', 'VOUCHER_EXPIRED', 'billingService.advanceBills()', 'suspendedForOverdueBills: 0', 'merchantExitService.advanceRetention()', 'batchOperationService.processPending()', 'refundService.recoverStale()', 'exportService.process(exportWorkerBatchSize())', 'auditOutbox.process(auditOutboxBatchSize())', "paymentExpiresAt: 'ASC', id: 'ASC'", "validTo: 'ASC', id: 'ASC'"]) {
  if (!lifecycleOrchestrationSource.includes(invariant)) failures.push(`生命周期编排服务缺少关键不变量：${invariant}`);
}
if (lifecycleOrchestrationSource.includes('MERCHANT_CONTRACT_EXPIRED') || lifecycleOrchestrationSource.includes('suspendExpiredContracts')) failures.push('生命周期编排不得因合同到期自动停售商家');
if (!appControllerSource.includes('private readonly overview: MerchantOverviewService')) failures.push('经营看板控制器未直接依赖商家概览服务');
if (!appControllerSource.includes('private readonly voucherFulfillment: VoucherFulfillmentService')) failures.push('券转店控制器未直接依赖券履约服务');
for (const invariant of ['PlatformAccessProfile.OPERATIONS', 'PlatformAccessProfile.FINANCE', 'PlatformAccessProfile.COMPLIANCE', 'UserRole.STORE_STAFF', 'merchantScope.resolve', 'merchantScope.apply', 'COALESCE(SUM(entry.verifiedAmountFen)', 'registrationWorkflow.isPublishable', "key: 'sales'", "key: 'registration'"]) {
  if (!merchantOverviewSource.includes(invariant)) failures.push(`商家概览服务缺少关键不变量：${invariant}`);
}
for (const invariant of ['PlatformAccessProfile.OPERATIONS', 'pessimistic_write', 'VoucherStatus.UNUSED', 'targetStoreId', 'merchantId: voucher.merchantId', 'openForSale', 'openForVerification', 'packageService.assertStoreApplies', 'VOUCHER_STORE_TRANSFERRED', 'customerId: _customerId', 'commissionRateSnapshot: _commissionRateSnapshot']) {
  if (!voucherFulfillmentSource.includes(invariant)) failures.push(`券履约服务缺少关键不变量：${invariant}`);
}
for (const invariant of ['usesEmbeddedDatabase', "query.setOnLocked('skip_locked')", 'PROCESSING_STALE_MS', 'NotificationOutboxStatus.PROCESSING']) {
  if (!notificationOutboxSource.includes(invariant)) failures.push(`通知 outbox 缺少多实例领取不变量：${invariant}`);
}
if (notificationOutboxSource.includes("setOnLocked('skip_locked')") && notificationOutboxSource.includes('usesEmbeddedDatabase')) console.log('PASS 通知 outbox 在真实 PostgreSQL 使用 SKIP LOCKED，内嵌演示库保持兼容');
for (const invariant of ['PlatformRuntimeControlStatus.RESUME_PENDING', 'GLOBAL_SALES_PAUSED', 'GLOBAL_SALES_RESUME_REQUESTED', 'GLOBAL_SALES_RESUMED', 'PlatformRuntimeControlCommand', 'idempotencyKey', 'pessimistic_write', 'resumeRequestedBy']) {
  if (!runtimeControlSource.includes(invariant)) failures.push(`全局销售控制缺少关键不变量：${invariant}`);
}
if (runtimeControlSource.includes('assertSalesEnabled') && runtimeControlSource.includes('独立账号复核')) console.log('PASS 全局销售控制具备止售、二人恢复和事务检查');

const releaseVerifier = await readFile('scripts/release-verify.mjs', 'utf8');
if (/shell\s*:\s*true/.test(releaseVerifier)) failures.push('发布验证重新启用了 shell: true');
else console.log('PASS 发布验证不通过命令 shell 拼接参数');

if (failures.length) {
  for (const failure of failures) console.error(`FAIL ${failure}`);
  process.exitCode = 1;
} else console.log('架构维护预算通过。');
