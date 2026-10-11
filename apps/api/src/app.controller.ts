import {
  BadRequestException, Body, Controller, Delete, ForbiddenException, GoneException, Get, Headers, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Put, Query, Req, Res,
  UseGuards,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { AuthenticatedRequest, AuthGuard, CustomerAuthenticatedRequest, CustomerAuthGuard, CurrentUser, RoleGuard, Roles, StepUpAuthGuard } from './auth';
import { AuthService } from './auth.service';
import { CustomerAuthService } from './customer-auth.service';
import { HealthService } from './health.service';
import { PackageService } from './package.service';
import { BannerService } from './banner.service';
import { StoreService } from './store.service';
import { ReservationService } from './reservation.service';
import { StaffService } from './staff.service';
import { CustomerCommerceService } from './customer-commerce.service';
import { MerchantExitService } from './merchant-exit.service';
import { MerchantTemplateService } from './merchant-template.service';
import { RegistrationWorkflowService } from './registration-workflow.service';
import { TenantAdministrationService } from './tenant-administration.service';
import { MerchantPaymentProfileService } from './merchant-payment-profile.service';
import { AgencyCooperationService } from './agency-cooperation.service';
import { CommissionRateService } from './commission-rate.service';
import { PlatformWorkQueueService } from './platform-work-queue.service';
import { TransactionReadService } from './transaction-read.service';
import { AuditReadService } from './audit-read.service';
import { ExportService } from './export.service';
import { RefundService } from './refund.service';
import { VerificationService } from './verification.service';
import { PaymentProcessingService } from './payment-processing.service';
import { MerchantOverviewService } from './merchant-overview.service';
import { VoucherFulfillmentService } from './voucher-fulfillment.service';
import { SupportTicketService } from './support-ticket.service';
import { AccountingAdjustmentService } from './accounting-adjustment.service';
import { BillingService } from './billing.service';
import { FaceVerifyService } from './face-verify.service';
import { AppConfigService } from './app-config.service';
import { BillPaymentConfirmationService } from './bill-payment-confirmation.service';
import { BatchOperationService } from './batch-operation.service';
import { StaffBatchOperationService } from './staff-batch-operation.service';
import { VoucherBatchOperationService } from './voucher-batch-operation.service';
import { RefundBatchOperationService } from './refund-batch-operation.service';
import { MerchantImportService } from './merchant-import.service';
import { MerchantAdminInviteService } from './merchant-admin-invite.service';
import { NotificationOperationsService } from './notifications/notification-operations.service';
import { PlatformRuntimeControlService } from './platform-runtime-control.service';
import { ReportingService } from './reporting.service';
import { RequestThrottleService } from './request-throttle.service';
import { MerchantAccessService } from './merchant-access.service';
import { PlatformAccessProfile, ReservationStatus, User, UserRole } from './domain/entities';
import { isLocalOrTestEnvironment, workspaceRoleForLoginOrigin } from './runtime-config';
import { API_CONTROLLER_VERSION } from './api-versioning';
import {
  AcceptMerchantAdminInviteDto, ChangePackageStatusDto, ChangePasswordDto, CreateAgencyDto, CreateBillAdjustmentDto, CreateBillDisputeDto, CreateBillReversalDto, CreateCustomerSessionDto, CreateExceptionRefundRequestDto, CreateMerchantAdminInviteDto, CreateMerchantDto, CreateOrderDto,
  CreatePackageBatchStatusDto, CreateStaffStoreAccessBatchDto, CreateVoucherStoreTransferBatchDto, CreateVoucherCompensationRefundBatchDto, CreateMerchantImportBatchDto, CreateRateVersionDto, CreateSupportTicketDto, CreateBillPaymentConfirmationRequestDto, ExecuteExceptionRefundDto, GenerateBillsDto, LoginDto, MerchantExitNoteDto, ReplySupportTicketDto, ResolveBillDisputeDto, ResolveSupportTicketDto, ReviewBillAdjustmentDto, ReviewMerchantExitRetentionDto, ReviewRateChangeRequestDto, SavePackageDto, UpdateSoldCountDto,
  RestoreMerchantTemplateConfigVersionDto, RestorePackageVersionDto, RestoreStoreVersionDto, SaveMerchantPaymentProfileDto, SaveMerchantTemplateConfigDto, SaveStaffDto, SaveStoreDto, SetAgencyActiveDto, SetStaffActiveDto, TransferVoucherStoreDto, UpdateAgencyCooperationDto, UpdateBillInvoiceDto, UpdateMerchantDto,
  CreateExportJobDto, NotificationOutboxQueryDto, OrderListQueryDto, PaginationQueryDto, PlatformRuntimeControlActionDto, ReportAnalyticsQueryDto, ResetPasswordDto, StepUpVerificationDto, TransactionListQueryDto, VerificationConfirmDto, VerificationPreviewDto,
} from './request.dto';

@Controller({ path: 'public', version: API_CONTROLLER_VERSION })
export class PublicController {
  constructor(private readonly customerCommerce: CustomerCommerceService, private readonly packagesService: PackageService, private readonly refunds: RefundService, private readonly supportTickets: SupportTicketService, private readonly customerAuth: CustomerAuthService, private readonly healthService: HealthService, private readonly requestThrottle: RequestThrottleService, private readonly faceVerify: FaceVerifyService, private readonly appConfig: AppConfigService, private readonly verification: VerificationService, private readonly staffService: StaffService, private readonly reservations: ReservationService) {}

  @Get('health') health() { return this.healthService.publicReady(); }
  @Get('health/live') live() { return this.healthService.publicLive(); }
  @Get('health/ready') ready() { return this.healthService.publicReady(); }
  @Get('health/worker') worker() { return this.healthService.publicWorkerReady(); }
  @Get('merchants') merchants() { return this.customerCommerce.publicMerchants(); }

  @Get('miniprogram/bootstrap')
  async miniprogramBootstrap(@Query('appId') appId?: string, @Query('tenantCode') tenantCode?: string, @Query('merchantId') merchantId?: string, @Query('knownVersion') knownVersion?: string) {
    return this.appConfig.bootstrap(appId, tenantCode, merchantId, knownVersion);
  }

  /** C 端会员查询：手机号 → 会员等级 + 权益（普通会员/尊贵会员） */
  @Get('miniprogram/member')
  async miniprogramMember(@Query('appId') appId?: string, @Query('tenantCode') tenantCode?: string, @Query('merchantId') merchantId?: string, @Query('phone') phone?: string) {
    return this.appConfig.publicMember(appId, tenantCode, merchantId, phone);
  }
  @Get('merchants/:merchantId') merchant(@Param('merchantId', new ParseUUIDPipe({ version: '4' })) merchantId: string) { return this.customerCommerce.publicMerchant(merchantId); }
  @Get('merchants/:merchantId/packages') packages(@Param('merchantId', new ParseUUIDPipe({ version: '4' })) merchantId: string) { return this.packagesService.publicPackages(merchantId); }

  /** 桌面版模板：GET /public/packages 分页商品（通过 X-Tenant-Code 或 tenantCode 定位商家） */
  @Get('packages')
  async publicPackages(@Req() req: Request, @Query('tenantCode') tenantCode?: string, @Query('merchantId') merchantIdHint?: string, @Query('page') page?: string, @Query('limit') limit?: string) {
    const tenant = this.tenantFrom(req, tenantCode, merchantIdHint);
    const merchantId = await this.appConfig.resolveMerchantId(tenant.appId, tenant.tenantCode, tenant.merchantId);
    return this.packagesService.publicPackagePage(merchantId, Number(page || 1), Number(limit || 20));
  }

  /** 桌面版模板：GET /public/packages/:id 套餐详情 */
  @Get('packages/:packageId')
  async publicPackageDetail(@Req() req: Request, @Param('packageId', new ParseUUIDPipe({ version: '4' })) packageId: string, @Query('tenantCode') tenantCode?: string, @Query('merchantId') merchantIdHint?: string) {
    const tenant = this.tenantFrom(req, tenantCode, merchantIdHint);
    const merchantId = await this.appConfig.resolveMerchantId(tenant.appId, tenant.tenantCode, tenant.merchantId);
    return this.packagesService.publicPackageDetail(merchantId, packageId);
  }

  @UseGuards(CustomerAuthGuard)
  @Get('merchants/:merchantId/packages/:packageId/purchase-availability')
  async purchaseAvailability(
    @Param('merchantId', new ParseUUIDPipe({ version: '4' })) merchantId: string,
    @Param('packageId', new ParseUUIDPipe({ version: '4' })) packageId: string,
    @Req() req: CustomerAuthenticatedRequest,
  ) {
    await this.requestThrottle.consume('customer-purchase-availability', req.customerId, 120, 60_000);
    return this.packagesService.customerPurchaseAvailability(merchantId, packageId, { id: req.customerId });
  }

  @Post('demo/customer-sessions')
  async demoCustomerSession(@Req() request: Request) {
    await this.requestThrottle.consume('demo-customer-session', String(request.ip || request.socket.remoteAddress || 'unknown'), 100, 15 * 60_000);
    return this.customerAuth.createDemoSession();
  }

  @Post('customer-sessions')
  async customerSession(@Body() body: CreateCustomerSessionDto, @Req() request: Request) {
    await this.requestThrottle.consume('customer-session', String(request.ip || request.socket.remoteAddress || 'unknown'), 30, 15 * 60_000);
    // 多租户：appId 优先取请求头 X-MiniProgram-AppId（小程序端已带），body 兜底；
    // 同时按租户解析商家归属写入顾客档案，避免会话串商户
    const headerAppId = String((request.headers['x-miniprogram-appid'] as string) || '').trim();
    const effectiveAppId = headerAppId || body.appId || '';
    const tenant = this.tenantFrom(request, body.tenantCode, body.merchantId);
    const merchantId = effectiveAppId ? await this.appConfig.resolveMerchantId(tenant.appId || effectiveAppId, tenant.tenantCode, tenant.merchantId).catch(() => null) : null;
    return this.customerAuth.createWechatSession(body.code, effectiveAppId, merchantId);
  }

  @UseGuards(CustomerAuthGuard)
  @Post('customer-sessions/phone')
  async customerPhone(@Req() req: CustomerAuthenticatedRequest, @Body() body: { code?: string; appId?: string }) {
    await this.requestThrottle.consume('customer-phone', req.customerId, 10, 60 * 60_000);
    return this.customerAuth.exchangePhone(req.customerId, body.code || '', body.appId);
  }

  @UseGuards(CustomerAuthGuard)
  @Post('merchants/:merchantId/orders')
  async createOrder(@Param('merchantId', new ParseUUIDPipe({ version: '4' })) merchantId: string, @Req() req: CustomerAuthenticatedRequest, @Body() body: CreateOrderDto) {
    await this.requestThrottle.consume('customer-order', req.customerId, 30, 15 * 60_000);
    const order = await this.customerCommerce.createOrder(merchantId, { id: req.customerId }, body);
    return { id: order.id, orderNo: order.orderNo, amountFen: order.amountFen, status: order.status, paymentExpiresAt: order.paymentExpiresAt };
  }

  /** 桌面版模板：POST /public/orders 下单（返回 orderId + prepay） */
  @UseGuards(CustomerAuthGuard)
  @Post('orders')
  async publicCreateOrder(@Req() req: CustomerAuthenticatedRequest, @Headers('idempotency-key') idempotencyKey: string | undefined, @Body() body: { packageId?: string; storeId?: string; quantity?: number; remark?: string }) {
    if (!body.packageId) throw new BadRequestException('缺少套餐');
    const tenant = this.tenantFrom(req);
    const merchantId = await this.appConfig.resolveMerchantId(tenant.appId, tenant.tenantCode, tenant.merchantId);
    await this.requestThrottle.consume('customer-order', req.customerId, 30, 15 * 60_000);
    const result = await this.customerCommerce.createOrderForPublic(merchantId, { id: req.customerId }, { packageId: body.packageId, storeId: body.storeId || '', quantity: body.quantity || 1, remark: body.remark, idempotencyKey });
    return result;
  }

  /** 桌面版模板：GET /public/orders 订单列表 */
  @UseGuards(CustomerAuthGuard)
  @Get('orders')
  async publicOrders(@Req() req: CustomerAuthenticatedRequest, @Query('page') page?: string, @Query('limit') limit?: string, @Query('status') status?: string) {
    await this.requestThrottle.consume('customer-orders', req.customerId, 60, 60_000);
    const tenant = this.tenantFrom(req);
    const merchantId = await this.appConfig.resolveMerchantId(tenant.appId, tenant.tenantCode, tenant.merchantId);
    return this.customerCommerce.customerOrderPage({ id: req.customerId }, { page: Number(page || 1), limit: Number(limit || 20), status, merchantId });
  }

  /** 桌面版模板：GET /public/orders/:orderId 单订单查询（支付轮询/详情用，校验归属） */
  @UseGuards(CustomerAuthGuard)
  @Get('orders/:orderId')
  async publicOrderById(@Param('orderId', new ParseUUIDPipe({ version: '4' })) orderId: string, @Req() req: CustomerAuthenticatedRequest) {
    await this.requestThrottle.consume('customer-order-detail', req.customerId, 60, 60_000);
    const tenant = this.tenantFrom(req);
    const merchantId = await this.appConfig.resolveMerchantId(tenant.appId, tenant.tenantCode, tenant.merchantId);
    const order = await this.customerCommerce.customerOrderById(orderId, { id: req.customerId }, merchantId);
    if (!order) throw new NotFoundException('订单不存在');
    return order;
  }

  /** 桌面版模板：POST /public/orders/:id/cancel 取消订单 */
  @UseGuards(CustomerAuthGuard)
  @Post('orders/:orderId/cancel')
  async publicCancelOrder(@Param('orderId', new ParseUUIDPipe({ version: '4' })) orderId: string, @Req() req: CustomerAuthenticatedRequest) {
    await this.requestThrottle.consume('customer-order-cancel', req.customerId, 20, 60_000);
    const tenant = this.tenantFrom(req);
    const merchantId = await this.appConfig.resolveMerchantId(tenant.appId, tenant.tenantCode, tenant.merchantId);
    return this.customerCommerce.cancelOrder(orderId, { id: req.customerId }, merchantId);
  }

  @UseGuards(CustomerAuthGuard)
  @Post('orders/:orderId/mock-confirm')
  async confirm(@Param('orderId', new ParseUUIDPipe({ version: '4' })) orderId: string, @Req() req: CustomerAuthenticatedRequest) {
    if (!isLocalOrTestEnvironment()) throw new NotFoundException();
    await this.requestThrottle.consume('customer-payment-confirm', req.customerId, 20, 15 * 60_000);
    const result = await this.customerCommerce.confirmDemoPayment(orderId, { id: req.customerId });
    return {
      order: { id: result.order.id, orderNo: result.order.orderNo, amountFen: result.order.amountFen, status: result.order.status },
      vouchers: result.vouchers.map((voucher) => ({ id: voucher.id, code: voucher.code, faceValueFen: voucher.faceValueFen, status: voucher.status, validFrom: voucher.validFrom, validTo: voucher.validTo })),
    };
  }

  @UseGuards(CustomerAuthGuard)
  @Post('orders/:orderId/pay-params')
  async payParams(@Param('orderId', new ParseUUIDPipe({ version: '4' })) orderId: string, @Req() req: CustomerAuthenticatedRequest) {
    await this.requestThrottle.consume('customer-pay-params', req.customerId, 30, 15 * 60_000);
    const result = await this.customerCommerce.paymentParamsForPublic(orderId, { id: req.customerId });
    return { prepay: result.prepay, payInfo: result.payInfo, expiresAt: result.expiresAt };
  }

  /** 支付成功后请求后端尽快补偿：只唤醒 PaymentOutbox 队列，快速返回，不同步等待汇付查单。 */
  @UseGuards(CustomerAuthGuard)
  @Post('orders/:orderId/confirm-payment')
  async publicConfirmPayment(@Param('orderId', new ParseUUIDPipe({ version: '4' })) orderId: string, @Req() req: CustomerAuthenticatedRequest) {
    await this.requestThrottle.consume('customer-order-confirm', req.customerId, 30, 60_000);
    const order = await this.customerCommerce.confirmPayment(orderId, { id: req.customerId });
    if (!order) throw new NotFoundException('订单不存在');
    return { ...order, confirmationPending: order.status === 'PENDING_PAY' };
  }

  /** 桌面版模板：GET /public/subscriptions/templates 订阅消息模板（未配置时返回空，前端不报错） */
  @Get('subscriptions/templates')
  async subscriptionsTemplates() { return {}; }

  /** 桌面版模板：POST /public/analytics/events 埋点（静默忽略） */
  @Post('analytics/events')
  async analyticsEvents() { return { received: true }; }

  /** 顾客提交预约（2026-08-10 真实闭环：落库预约单，商家后台可处理） */
  @UseGuards(CustomerAuthGuard)
  @Post('reservations')
  async publicReservation(@Req() req: CustomerAuthenticatedRequest, @Headers('idempotency-key') idempotencyKey: string | undefined, @Body() body: { storeId?: string; storeName?: string; date: string; timeSlot: string; remark?: string; peopleCount?: number; customerName?: string; merchantId?: string }) {
    await this.requestThrottle.consume('customer-reservation', req.customerId, 10, 60 * 60_000);
    const tenant = this.tenantFrom(req, '', body.merchantId || '');
    const merchantId = await this.appConfig.resolveMerchantId(tenant.appId, tenant.tenantCode, tenant.merchantId);
    const phoneMasked = await this.customerAuth.cachedPhoneMasked(req.customerId);
    const reservation = await this.reservations.create(merchantId, req.customerId, body, phoneMasked, String(idempotencyKey || ''));
    return { reserved: true, id: reservation.id, status: reservation.status };
  }

  /** 顾客查询自己的预约（"我的预约"入口） */
  @UseGuards(CustomerAuthGuard)
  @Get('reservations/mine')
  async myReservations(@Req() req: CustomerAuthenticatedRequest, @Query('merchantId') merchantId?: string) {
    const tenant = this.tenantFrom(req, '', merchantId || '');
    const resolved = await this.appConfig.resolveMerchantId(tenant.appId, tenant.tenantCode, tenant.merchantId);
    return { items: await this.reservations.mine(req.customerId, resolved) };
  }

  /** 顾客查询自己的单条预约详情（含状态时间线；归属校验：仅本人可查） */
  @UseGuards(CustomerAuthGuard)
  @Get('reservations/:reservationId')
  async reservationDetail(@Req() req: CustomerAuthenticatedRequest, @Param('reservationId', new ParseUUIDPipe({ version: '4' })) reservationId: string) {
    const tenant = this.tenantFrom(req);
    const merchantId = await this.appConfig.resolveMerchantId(tenant.appId, tenant.tenantCode, tenant.merchantId);
    return this.reservations.detailForCustomer(req.customerId, reservationId, merchantId);
  }

  @UseGuards(CustomerAuthGuard)
  @Get('vouchers')
  async vouchers(@Req() req: CustomerAuthenticatedRequest) {
    await this.requestThrottle.consume('customer-voucher-legacy', req.customerId, 60, 60_000);
    const tenant = this.tenantFrom(req);
    const merchantId = await this.appConfig.resolveMerchantId(tenant.appId, tenant.tenantCode, tenant.merchantId);
    return this.customerCommerce.customerVouchers({ id: req.customerId }, merchantId);
  }
  @UseGuards(CustomerAuthGuard)
  @Get('vouchers/page')
  async voucherPage(@Req() req: CustomerAuthenticatedRequest, @Query('limit') limit?: string, @Query('cursor') cursor?: string) {
    await this.requestThrottle.consume('customer-voucher-page', req.customerId, 120, 60_000);
    const tenant = this.tenantFrom(req);
    const merchantId = await this.appConfig.resolveMerchantId(tenant.appId, tenant.tenantCode, tenant.merchantId);
    return this.customerCommerce.customerVoucherPage({ id: req.customerId }, { limit, cursor, merchantId });
  }
  @UseGuards(CustomerAuthGuard)
  @Post('vouchers/:voucherId/dynamic-code')
  async dynamicCode(@Param('voucherId', new ParseUUIDPipe({ version: '4' })) voucherId: string, @Req() req: CustomerAuthenticatedRequest) {
    await this.requestThrottle.consume('customer-dynamic-code', req.customerId, 30, 60_000);
    return this.customerCommerce.dynamicCode(voucherId, { id: req.customerId });
  }

  /** 顾客小程序：当前微信是否为已绑定核销员（「我的」页据此显示员工核销入口）。 */
  @UseGuards(CustomerAuthGuard)
  @Get('customer-sessions/verifier-status')
  async verifierStatus(@Req() req: CustomerAuthenticatedRequest) {
    const verifier = await this.verification.verifierByCustomer(req.customerId);
    return verifier ? { isVerifier: true, name: verifier.name, storeIds: verifier.storeIds || [] } : { isVerifier: false };
  }

  /** 顾客小程序：核销员（按微信 openid 识别）核销预览。 */
  @UseGuards(CustomerAuthGuard)
  @Post('verifier/preview')
  async verifierPreview(@Req() req: CustomerAuthenticatedRequest, @Body() body: { token?: string; workingStoreId?: string }) {
    await this.requestThrottle.consume('customer-verifier-preview', req.customerId, 60, 60_000);
    return this.verification.previewAsVerifier(req.customerId, { token: String(body.token || '').trim(), workingStoreId: String(body.workingStoreId || '').trim() });
  }

  /** 顾客小程序：核销员（按微信 openid 识别）核销确认。 */
  @UseGuards(CustomerAuthGuard)
  @Post('verifier/confirm')
  async verifierConfirm(@Req() req: CustomerAuthenticatedRequest, @Body() body: { token?: string; workingStoreId?: string; idempotencyKey?: string }) {
    await this.requestThrottle.consume('customer-verifier-confirm', req.customerId, 30, 60_000);
    return this.verification.confirmAsVerifier(req.customerId, { token: String(body.token || '').trim(), workingStoreId: String(body.workingStoreId || '').trim(), idempotencyKey: String(body.idempotencyKey || '').trim() });
  }
  @UseGuards(CustomerAuthGuard)
  @Post('vouchers/:voucherId/refund')
  async refund(@Param('voucherId', new ParseUUIDPipe({ version: '4' })) voucherId: string, @Req() req: CustomerAuthenticatedRequest) {
    await this.requestThrottle.consume('customer-refund', req.customerId, 10, 15 * 60_000);
    const refund = await this.refunds.refundForCustomer(voucherId, { id: req.customerId });
    return { id: refund.id, voucherId: refund.voucherId, amountFen: refund.amountFen, status: refund.status, createdAt: refund.createdAt };
  }

  /** 核销员微信扫码确认绑定：顾客小程序内确认（CustomerAuthGuard 已解析 openid），绑定令牌 + openid 写入员工档案。 */
  @UseGuards(CustomerAuthGuard)
  @Post('verifier/wechat-bind')
  async verifierWechatBind(@Req() req: CustomerAuthenticatedRequest, @Body() body: { bindToken?: string }) {
    const bindToken = String(body.bindToken || '').trim();
    if (!bindToken) throw new BadRequestException('缺少绑定令牌');
    await this.requestThrottle.consume('verifier-wechat-bind', `bind:${bindToken.slice(0, 16)}`, 10, 60_000);
    return this.staffService.confirmWechatBindByOpenid(req.customerId, bindToken);
  }
  @UseGuards(CustomerAuthGuard)
  @Get('support-tickets')
  async customerSupportTickets(@Req() req: CustomerAuthenticatedRequest) {
    await this.requestThrottle.consume('customer-support-ticket-list', req.customerId, 60, 60_000);
    return this.supportTickets.customerSupportTickets({ id: req.customerId });
  }
  @UseGuards(CustomerAuthGuard)
  @Post('support-tickets')
  async createSupportTicket(@Req() req: CustomerAuthenticatedRequest, @Body() body: CreateSupportTicketDto) {
    await this.requestThrottle.consume('customer-support-ticket', req.customerId, 5, 60 * 60_000);
    return this.supportTickets.createSupportTicket({ id: req.customerId }, body);
  }

  @UseGuards(CustomerAuthGuard)
  @Post('face-verify-params')
  async faceVerifyParams(@Req() req: CustomerAuthenticatedRequest, @Body() body: { name: string; idCardNumber: string; phone: string }) {
    // H-08：人脸核验接口必须顾客鉴权 + 限流（防匿名刷腾讯云 DetectAuth 费用与高敏信息滥用）
    await this.requestThrottle.consume('customer-face-verify', req.customerId, 10, 60 * 60_000);
    return this.faceVerify.createBizToken(body.name, body.idCardNumber);
  }

  /** R-01：小程序前端错误上报（匿名 + 限流 + 租户上下文，落审计日志，避免 404 静默丢失）。 */
  @Post('monitor/errors')
  async monitorErrors(@Body() body: Record<string, unknown>, @Req() request: Request) {
    const ip = String(request.ip || request.socket.remoteAddress || 'unknown');
    await this.requestThrottle.consume('monitor-errors', ip, 120, 60 * 60_000);
    const tenant = this.tenantFrom(request);
    // 只记录元数据与消息摘要，不落前端可能带上的任何密钥
    const payload = {
      ts: new Date().toISOString(),
      ip,
      appId: tenant.appId || '',
      tenantCode: tenant.tenantCode || '',
      message: String(body.message || '').slice(0, 500),
      page: String(body.page || '').slice(0, 200),
      stack: String(body.stack || '').slice(0, 2000),
      count: Number(body.count || 1),
    };
    if (typeof console !== 'undefined' && console.warn) console.warn('[monitor/errors]', JSON.stringify(payload));
    return { received: true };
  }

  @UseGuards(CustomerAuthGuard)
  @Post('face-verify-result')
  async faceVerifyResult(@Req() req: CustomerAuthenticatedRequest, @Body() body: { bizToken: string }) {
    await this.requestThrottle.consume('face-verify-result', req.customerId, 3, 60 * 60_000);
    return this.faceVerify.getVerifyResult(body.bizToken);
  }

  /** 从请求头（桌面版模板携带 X-Tenant-Code / X-MiniProgram-AppId）或 query 参数解析租户上下文 */
  private tenantFrom(req: Request, tenantCodeQuery?: string, merchantIdQuery?: string): { appId: string; tenantCode: string; merchantId: string } {
    const h = (name: string) => String(req.headers[name] || req.headers[name.toLowerCase()] || '').trim();
    return {
      appId: h('X-MiniProgram-AppId'),
      tenantCode: tenantCodeQuery || h('X-Tenant-Code'),
      merchantId: merchantIdQuery || tenantCodeQuery || h('X-Tenant-Code'),
    };
  }
}

@Controller('payments')
export class PaymentWebhookController {
  constructor(private readonly payments: PaymentProcessingService) {}

  /**
   * This route intentionally has no operator or customer JWT. A real adapter
   * must verify its provider signature over the unmodified raw request body
   * before the event can affect any order.
   */
  @Post('webhooks/:provider')
  @Post('webhooks/:provider/:mchid')
  async webhook(@Param('provider') provider: string, @Param('mchid') mchid: string | undefined, @Req() request: Request & { rawBody?: Buffer }) {
    const headers = Object.fromEntries(Object.entries(request.headers).map(([key, value]) => [key, Array.isArray(value) ? value[0] : value])) as Record<string, string | undefined>;
    await this.payments.receiveWebhook(provider, request.rawBody || Buffer.alloc(0), headers, mchid);
    return { accepted: true };
  }
}

@Controller({ path: 'auth', version: API_CONTROLLER_VERSION })
export class AuthController {
  constructor(private readonly auth: AuthService, private readonly requestThrottle: RequestThrottleService, private readonly tenantAdministration: TenantAdministrationService, private readonly merchantAdminInvites: MerchantAdminInviteService, private readonly verification: VerificationService) {}

  /** 网页核销台：核销员用系统账号密码登录（仅 STORE_STAFF，校验来源域名，防止任意站点调用）。 */
  @Post('verifier-web-login') verifierWebLogin(@Req() request: AuthenticatedRequest, @Body() body: LoginDto) {
    const rawOrigin = request.headers.origin;
    const origin = Array.isArray(rawOrigin) ? rawOrigin[0] : rawOrigin;
    const allowed = new Set(['https://example.com', 'http://127.0.0.1:8080', 'http://localhost:8080']);
    if (typeof origin !== 'string' || !allowed.has(origin)) throw new ForbiddenException('核销台登录入口不可用');
    return this.auth.login(body.email, body.password, {
      ipAddress: request.ip || '',
      userAgent: String(request.headers['user-agent'] || ''),
      requiredRole: UserRole.STORE_STAFF,
      // FIX: 网页核销台登录签发 30 天长期会话（配合 AuthGuard 滑窗续期），
      // 核销员扫码一次长期绑定，日常核销无需重复扫码登录。
      longLived: true,
    });
  }

  /** 网页核销台：核销员授权的工作门店列表（核销需选择工作门店）。 */
  @UseGuards(AuthGuard)
  @Roles(UserRole.STORE_STAFF)
  @Get('verifier-stores')
  verifierStores(@CurrentUser() user: User) {
    return this.verification.verifierStores(user);
  }

  @Post('login') login(@Req() request: AuthenticatedRequest, @Body() body: LoginDto) {
    const rawOrigin = request.headers.origin;
    const origin = Array.isArray(rawOrigin) ? rawOrigin[0] : rawOrigin;
    const requiredRole = workspaceRoleForLoginOrigin(origin);
    if (requiredRole === null) throw new ForbiddenException('当前来源不可登录运营工作台');
    return this.auth.login(body.email, body.password, { ipAddress: request.ip || '', userAgent: String(request.headers['user-agent'] || ''), ...(requiredRole ? { requiredRole: requiredRole as UserRole } : {}) });
  }
  /**
   * WeChat native requests do not carry a browser Origin. Keep that exception
   * in a separate, role-pinned endpoint so it can never become a bypass for
   * platform, agency or merchant browser-workspace login restrictions.
   */
  @Post('verifier-login') verifierLogin(@Req() request: AuthenticatedRequest, @Body() body: LoginDto) {
    const rawOrigin = request.headers.origin;
    const origin = Array.isArray(rawOrigin) ? rawOrigin[0] : rawOrigin;
    const rawClient = request.headers['x-operator-client'];
    const client = Array.isArray(rawClient) ? rawClient[0] : rawClient;
    if (origin || client !== 'verifier-miniprogram-v1') throw new ForbiddenException('核销助手登录入口不可用');
    return this.auth.login(body.email, body.password, { ipAddress: request.ip || '', userAgent: String(request.headers['user-agent'] || ''), requiredRole: UserRole.STORE_STAFF });
  }

  /** 核销员微信免密登录：核销小程序 wx.login 后调用（与 verifier-login 同样限定无 Origin + 专属客户端标识）。 */
  @Post('verifier-wechat-login') verifierWechatLogin(@Req() request: AuthenticatedRequest, @Headers('X-MiniProgram-AppId') appId: string | undefined, @Body() body: { code?: string }) {
    const rawOrigin = request.headers.origin;
    const origin = Array.isArray(rawOrigin) ? rawOrigin[0] : rawOrigin;
    const rawClient = request.headers['x-operator-client'];
    const client = Array.isArray(rawClient) ? rawClient[0] : rawClient;
    if (origin || client !== 'verifier-miniprogram-v1') throw new ForbiddenException('核销助手登录入口不可用');
    if (!appId) throw new BadRequestException('缺少小程序 APPID');
    const code = String(body.code || '').trim();
    if (!code) throw new BadRequestException('缺少微信登录凭证');
    return this.auth.verifierWechatLogin(code, appId, { ipAddress: request.ip || '', userAgent: String(request.headers['user-agent'] || '') });
  }
  @Post('merchant-admin-invites/accept')
  async acceptMerchantAdminInvite(@Req() request: Request, @Body() body: AcceptMerchantAdminInviteDto) {
    await this.requestThrottle.consume('merchant-admin-invite-accept', request.ip || request.socket.remoteAddress || 'unknown', 8, 15 * 60_000);
    return this.merchantAdminInvites.accept(body.token, body.password);
  }
  @UseGuards(AuthGuard)
  @Get('me') me(@CurrentUser() user: User) { return this.auth.profile(user); }
  @UseGuards(AuthGuard)
  @Get('sessions') sessions(@CurrentUser() user: User, @Req() request: AuthenticatedRequest) { return this.auth.listSessions(user.id, user.sessionVersion, request.sessionId); }
  @UseGuards(AuthGuard)
  @Delete('sessions/:sessionId') async revokeSession(@CurrentUser() user: User, @Param('sessionId') sessionId: string) { await this.auth.revokeSession(user.id, sessionId); return { ok: true }; }
  @UseGuards(AuthGuard)
  @Post('logout-others') async logoutOthers(@CurrentUser() user: User, @Req() request: AuthenticatedRequest) { await this.auth.logoutOthers(user.id, request.sessionId); return { ok: true }; }
  @UseGuards(AuthGuard)
  @Post('logout') async logout(@CurrentUser() user: User, @Req() request: AuthenticatedRequest) { await this.auth.logout(user.id, request.sessionId); return { ok: true }; }
  @UseGuards(AuthGuard)
  @Post('password') async changePassword(@CurrentUser() user: User, @Body() body: ChangePasswordDto) {
    await this.requestThrottle.consume('account-password-change', user.id, 5, 15 * 60_000);
    await this.auth.changePassword(user.id, body.currentPassword, body.newPassword);
    return { ok: true };
  }
  @UseGuards(AuthGuard)
  @Post('sensitive-action/verify') async verifySensitiveAction(@CurrentUser() user: User, @Req() request: AuthenticatedRequest, @Body() body: StepUpVerificationDto) {
    await this.requestThrottle.consume('account-sensitive-action-verify', user.id, 5, 15 * 60_000);
    const verifiedAt = await this.auth.confirmSensitiveAction(user.id, request.sessionId, body.currentPassword);
    return { verifiedAt, expiresAt: new Date(verifiedAt.getTime() + 10 * 60_000) };
  }
  @UseGuards(AuthGuard)
  @UseGuards(StepUpAuthGuard)
  @Post('users/:userId/password-reset')
  resetManagedPassword(@CurrentUser() user: User, @Param('userId', new ParseUUIDPipe({ version: '4' })) userId: string, @Body() body: ResetPasswordDto) { return this.tenantAdministration.resetManagedPassword(user, userId, body.newPassword); }
}

@Controller({ path: '', version: API_CONTROLLER_VERSION })
@UseGuards(AuthGuard, RoleGuard)
export class AppController {
  constructor(private readonly overview: MerchantOverviewService, private readonly voucherFulfillment: VoucherFulfillmentService, private readonly tenantAdministration: TenantAdministrationService, private readonly merchantPaymentProfiles: MerchantPaymentProfileService, private readonly agencyCooperation: AgencyCooperationService, private readonly merchantImport: MerchantImportService, private readonly merchantAdminInvites: MerchantAdminInviteService, private readonly notificationOperations: NotificationOperationsService, private readonly runtimeControls: PlatformRuntimeControlService, private readonly commissionRate: CommissionRateService, private readonly platformWorkQueue: PlatformWorkQueueService, private readonly transactionRead: TransactionReadService, private readonly auditRead: AuditReadService, private readonly exports: ExportService, private readonly refunds: RefundService, private readonly verification: VerificationService, private readonly merchantExit: MerchantExitService, private readonly merchantTemplate: MerchantTemplateService, private readonly registrationWorkflow: RegistrationWorkflowService, private readonly packagesService: PackageService, private readonly storesService: StoreService, private readonly reservations: ReservationService, private readonly staffService: StaffService, private readonly supportTickets: SupportTicketService, private readonly accountingAdjustments: AccountingAdjustmentService, private readonly billing: BillingService, private readonly billPaymentConfirmations: BillPaymentConfirmationService, private readonly batchOperations: BatchOperationService, private readonly staffBatchOperations: StaffBatchOperationService, private readonly voucherBatchOperations: VoucherBatchOperationService, private readonly refundBatchOperations: RefundBatchOperationService, private readonly reporting: ReportingService, private readonly requestThrottle: RequestThrottleService, private readonly healthService: HealthService, private readonly appConfig: AppConfigService, private readonly merchantAccess: MerchantAccessService, private readonly bannersService: BannerService) {}

  private assertHealthDiagnosticsAccess(user: User): void {
    const profile = user.platformAccessProfile || PlatformAccessProfile.SYSTEM_ADMIN;
    if (![PlatformAccessProfile.SYSTEM_ADMIN, PlatformAccessProfile.OPERATIONS, PlatformAccessProfile.SECURITY].includes(profile)) {
      throw new ForbiddenException('当前平台职责无权查看运行诊断');
    }
  }

  @Get('dashboard') dashboard(@CurrentUser() user: User, @Query('merchantId') merchantId?: string) { return this.overview.dashboard(user, merchantId); }
  @Get('platform/health/ready') @Roles(UserRole.PLATFORM_ADMIN)
  platformHealthReady(@CurrentUser() user: User) { this.assertHealthDiagnosticsAccess(user); return this.healthService.ready(); }
  @Get('platform/health/worker') @Roles(UserRole.PLATFORM_ADMIN)
  platformHealthWorker(@CurrentUser() user: User) { this.assertHealthDiagnosticsAccess(user); return this.healthService.workerReady(); }
  @Get('platform/notifications') @Roles(UserRole.PLATFORM_ADMIN)
  notificationList(@CurrentUser() user: User, @Query() query: NotificationOutboxQueryDto) { return this.notificationOperations.list(user, query); }
  @Get('platform/runtime-controls/sales') @Roles(UserRole.PLATFORM_ADMIN)
  salesRuntimeControl(@CurrentUser() user: User) { return this.runtimeControls.getSalesControl(user); }
  @UseGuards(StepUpAuthGuard)
  @Post('platform/runtime-controls/sales/pause') @Roles(UserRole.PLATFORM_ADMIN)
  pauseGlobalSales(@CurrentUser() user: User, @Body() body: PlatformRuntimeControlActionDto, @Headers('idempotency-key') idempotencyKey?: string) { return this.runtimeControls.pauseSales(user, body.expectedVersion, body.note, idempotencyKey); }
  @UseGuards(StepUpAuthGuard)
  @Post('platform/runtime-controls/sales/resume-request') @Roles(UserRole.PLATFORM_ADMIN)
  requestGlobalSalesResume(@CurrentUser() user: User, @Body() body: PlatformRuntimeControlActionDto, @Headers('idempotency-key') idempotencyKey?: string) { return this.runtimeControls.requestSalesResume(user, body.expectedVersion, body.note, idempotencyKey); }
  @UseGuards(StepUpAuthGuard)
  @Post('platform/runtime-controls/sales/resume-approve') @Roles(UserRole.PLATFORM_ADMIN)
  approveGlobalSalesResume(@CurrentUser() user: User, @Body() body: PlatformRuntimeControlActionDto, @Headers('idempotency-key') idempotencyKey?: string) { return this.runtimeControls.approveSalesResume(user, body.expectedVersion, body.note, idempotencyKey); }
  @UseGuards(StepUpAuthGuard)
  @Post('platform/notifications/:notificationId/retry') @Roles(UserRole.PLATFORM_ADMIN)
  notificationRetry(@CurrentUser() user: User, @Param('notificationId', new ParseUUIDPipe({ version: '4' })) notificationId: string) { return this.notificationOperations.retryFailed(user, notificationId); }
  @Get('platform/work-queue') @Roles(UserRole.PLATFORM_ADMIN)
  workQueue(@CurrentUser() user: User) { return this.platformWorkQueue.get(user); }
  @Get('platform/audits/integrity') @Roles(UserRole.PLATFORM_ADMIN)
  auditIntegrity(@CurrentUser() user: User) { return this.auditRead.integrity(user); }
  @Get('platform/audits') @Roles(UserRole.PLATFORM_ADMIN)
  platformAudits(@CurrentUser() user: User, @Query() query: PaginationQueryDto) { return this.auditRead.listForPlatform(user, query); }
  @Get('agencies') @Roles(UserRole.PLATFORM_ADMIN)
  agencies(@CurrentUser() user: User) { return this.tenantAdministration.listAgencies(user); }
  @Post('agencies') @Roles(UserRole.PLATFORM_ADMIN)
  createAgency(@CurrentUser() user: User, @Body() body: CreateAgencyDto) { return this.tenantAdministration.createAgency(user, body); }
  @Patch('agencies/:agencyId/cooperation') @Roles(UserRole.PLATFORM_ADMIN)
  updateAgencyCooperation(@CurrentUser() user: User, @Param('agencyId', new ParseUUIDPipe({ version: '4' })) agencyId: string, @Body() body: UpdateAgencyCooperationDto) { return this.agencyCooperation.update(user, agencyId, body); }
  @Get('agency/cooperation') @Roles(UserRole.AGENCY_ADMIN)
  currentAgencyCooperation(@CurrentUser() user: User) { return this.agencyCooperation.listForUser(user); }
  @Post('agencies/:agencyId/active') @Roles(UserRole.PLATFORM_ADMIN)
  setAgencyActive(@CurrentUser() user: User, @Param('agencyId', new ParseUUIDPipe({ version: '4' })) agencyId: string, @Body() body: SetAgencyActiveDto) { return this.tenantAdministration.setAgencyActive(user, agencyId, body.active); }
  @UseGuards(StepUpAuthGuard)
  @Post('agencies/:agencyId/merchants/batch-import') @Roles(UserRole.PLATFORM_ADMIN, UserRole.AGENCY_ADMIN)
  merchantBatchImport(@CurrentUser() user: User, @Param('agencyId', new ParseUUIDPipe({ version: '4' })) agencyId: string, @Body() body: CreateMerchantImportBatchDto, @Headers('idempotency-key') idempotencyKey?: string) { return this.merchantImport.request(user, agencyId, body, idempotencyKey || ''); }
  @Get('merchant-import-operations')
  merchantImportOperations(@CurrentUser() user: User) { return this.merchantImport.list(user); }
  @Get('merchant-import-operations/:operationId')
  merchantImportOperation(@CurrentUser() user: User, @Param('operationId', new ParseUUIDPipe({ version: '4' })) operationId: string) { return this.merchantImport.get(user, operationId); }
  @Get('merchants') merchants(@CurrentUser() user: User) { return this.tenantAdministration.listMerchants(user); }
  @Post('merchants') @Roles(UserRole.PLATFORM_ADMIN, UserRole.AGENCY_ADMIN)
  createMerchant(@CurrentUser() user: User, @Body() body: CreateMerchantDto, @Headers('idempotency-key') idempotencyKey?: string) { return this.tenantAdministration.createMerchant(user, { ...body, idempotencyKey }); }
    @Get('merchants/:merchantId/payment-profile') @Roles(UserRole.PLATFORM_ADMIN, UserRole.AGENCY_ADMIN)
  merchantPaymentProfile(@CurrentUser() user: User, @Param('merchantId', new ParseUUIDPipe({ version: '4' })) merchantId: string) { return this.merchantPaymentProfiles.get(user, merchantId); }
  @Get('merchants/:merchantId/payment-channels') @Roles(UserRole.PLATFORM_ADMIN, UserRole.AGENCY_ADMIN)
  merchantPaymentChannels(@CurrentUser() user: User, @Param('merchantId', new ParseUUIDPipe({ version: '4' })) merchantId: string) { return this.merchantPaymentProfiles.getChannels(user, merchantId); }
  @Get('merchants/:merchantId/huifu-bind-status') @Roles(UserRole.PLATFORM_ADMIN, UserRole.AGENCY_ADMIN)
  huifuBindStatus(@CurrentUser() user: User, @Param('merchantId', new ParseUUIDPipe({ version: '4' })) merchantId: string) { return this.merchantPaymentProfiles.huifuBindStatus(user, merchantId); }
  @UseGuards(StepUpAuthGuard)
    @Put('merchants/:merchantId/payment-profile') @Roles(UserRole.PLATFORM_ADMIN, UserRole.AGENCY_ADMIN)
  saveMerchantPaymentProfile(@CurrentUser() user: User, @Param('merchantId', new ParseUUIDPipe({ version: '4' })) merchantId: string, @Body() body: SaveMerchantPaymentProfileDto) {
    // 兼容旧前端只传 huifuId：映射为通用通道参数
    const normalized = { ...body, providerMerchantId: body.providerMerchantId ?? body.huifuId ?? undefined };
    return this.merchantPaymentProfiles.save(user, merchantId, normalized);
  }
  @UseGuards(StepUpAuthGuard)
  @Post('merchants/:merchantId/admin-invites') @Roles(UserRole.PLATFORM_ADMIN, UserRole.AGENCY_ADMIN)
  createMerchantAdminInvite(@CurrentUser() user: User, @Param('merchantId', new ParseUUIDPipe({ version: '4' })) merchantId: string, @Body() body: CreateMerchantAdminInviteDto, @Headers('idempotency-key') idempotencyKey?: string) { return this.merchantAdminInvites.create(user, merchantId, body, idempotencyKey || ''); }
  @Get('merchants/:merchantId/admin-invites') @Roles(UserRole.PLATFORM_ADMIN, UserRole.AGENCY_ADMIN)
  merchantAdminInvitesList(@CurrentUser() user: User, @Param('merchantId', new ParseUUIDPipe({ version: '4' })) merchantId: string) { return this.merchantAdminInvites.list(user, merchantId); }
  @UseGuards(StepUpAuthGuard)
  @Post('merchants/:merchantId/admin-invites/:inviteId/revoke') @Roles(UserRole.PLATFORM_ADMIN, UserRole.AGENCY_ADMIN)
  revokeMerchantAdminInvite(@CurrentUser() user: User, @Param('merchantId', new ParseUUIDPipe({ version: '4' })) merchantId: string, @Param('inviteId', new ParseUUIDPipe({ version: '4' })) inviteId: string) { return this.merchantAdminInvites.revoke(user, merchantId, inviteId); }
  @Patch('merchants/:merchantId')
  updateMerchant(@CurrentUser() user: User, @Param('merchantId', new ParseUUIDPipe({ version: '4' })) merchantId: string, @Body() body: UpdateMerchantDto, @Headers('idempotency-key') idempotencyKey?: string) { return this.tenantAdministration.updateMerchant(user, merchantId, { ...body, idempotencyKey }); }
  @Post('merchants/:merchantId/exit-case')
  requestExitCase(@CurrentUser() user: User, @Param('merchantId', new ParseUUIDPipe({ version: '4' })) merchantId: string, @Body() body: MerchantExitNoteDto) { return this.merchantExit.request(user, merchantId, body.note); }
  @Get('merchants/:merchantId/exit-case')
  exitCase(@CurrentUser() user: User, @Param('merchantId', new ParseUUIDPipe({ version: '4' })) merchantId: string) { return this.merchantExit.get(user, merchantId); }
  @Post('merchants/:merchantId/exit-case/start-fulfillment') @Roles(UserRole.PLATFORM_ADMIN)
  startExitFulfillment(@CurrentUser() user: User, @Param('merchantId', new ParseUUIDPipe({ version: '4' })) merchantId: string, @Body() body: MerchantExitNoteDto) { return this.merchantExit.startFulfillment(user, merchantId, body.note); }
  @Post('merchants/:merchantId/exit-case/prepare-export') @Roles(UserRole.PLATFORM_ADMIN)
  prepareExitExport(@CurrentUser() user: User, @Param('merchantId', new ParseUUIDPipe({ version: '4' })) merchantId: string, @Body() body: MerchantExitNoteDto) { return this.merchantExit.prepareExport(user, merchantId, body.note); }
  @Post('merchants/:merchantId/exit-case/confirm-data-export') @Roles(UserRole.MERCHANT_ADMIN)
  confirmExitDataExport(@CurrentUser() user: User, @Param('merchantId', new ParseUUIDPipe({ version: '4' })) merchantId: string, @Body() body: MerchantExitNoteDto) { return this.merchantExit.confirmDataExport(user, merchantId, body.note); }
  @Post('merchants/:merchantId/exit-case/acknowledge-authorization-revocation') @Roles(UserRole.MERCHANT_ADMIN)
  acknowledgeExitAuthorizationRevocation(@CurrentUser() user: User, @Param('merchantId', new ParseUUIDPipe({ version: '4' })) merchantId: string, @Body() body: MerchantExitNoteDto) { return this.merchantExit.acknowledgeAuthorizationRevocation(user, merchantId, body.note); }
  @Post('merchants/:merchantId/exit-case/review-retention') @Roles(UserRole.PLATFORM_ADMIN)
  reviewExitRetention(@CurrentUser() user: User, @Param('merchantId', new ParseUUIDPipe({ version: '4' })) merchantId: string, @Body() body: ReviewMerchantExitRetentionDto) { return this.merchantExit.reviewRetention(user, merchantId, body); }
  @Get('merchants/:merchantId/exit-readiness')
  exitReadiness(@CurrentUser() user: User, @Param('merchantId', new ParseUUIDPipe({ version: '4' })) merchantId: string) { return this.merchantExit.readiness(user, merchantId); }
  @Get('merchants/:merchantId/readiness')
  readiness(@CurrentUser() user: User, @Param('merchantId', new ParseUUIDPipe({ version: '4' })) merchantId: string) { return this.overview.readiness(user, merchantId); }
  @Get('merchants/:merchantId/template-config')
  templateConfig(@CurrentUser() user: User, @Param('merchantId', new ParseUUIDPipe({ version: '4' })) merchantId: string) { return this.merchantTemplate.get(user, merchantId); }
  @Patch('merchants/:merchantId/template-config')
  saveTemplateConfig(@CurrentUser() user: User, @Param('merchantId', new ParseUUIDPipe({ version: '4' })) merchantId: string, @Body() body: SaveMerchantTemplateConfigDto) { return this.merchantTemplate.save(user, merchantId, body); }
  @Get('merchants/:merchantId/template-config/versions')
  templateConfigVersions(@CurrentUser() user: User, @Param('merchantId', new ParseUUIDPipe({ version: '4' })) merchantId: string) { return this.merchantTemplate.versions(user, merchantId); }
  @Post('merchants/:merchantId/template-config/versions/:auditId/restore')
  restoreTemplateConfigVersion(@CurrentUser() user: User, @Param('merchantId', new ParseUUIDPipe({ version: '4' })) merchantId: string, @Param('auditId', new ParseUUIDPipe({ version: '4' })) auditId: string, @Body() body: RestoreMerchantTemplateConfigVersionDto) { return this.merchantTemplate.restore(user, merchantId, auditId, body.expectedVersion); }
  @Get('merchants/:merchantId/registration')
  registration(@CurrentUser() user: User, @Param('merchantId', new ParseUUIDPipe({ version: '4' })) merchantId: string) { return this.registrationWorkflow.get(user, merchantId); }
  @Get('merchants/:merchantId/app-config')
  getAppConfig(@CurrentUser() user: User, @Param('merchantId', new ParseUUIDPipe({ version: '4' })) merchantId: string) { return this.appConfig.getMerchantConfig(user, merchantId); }
  @Put('merchants/:merchantId/app-config')
  saveAppConfig(@CurrentUser() user: User, @Param('merchantId', new ParseUUIDPipe({ version: '4' })) merchantId: string, @Body() body: { config?: Record<string, unknown> }) { return this.appConfig.saveMerchantConfig(user, merchantId, body.config || {}); }
  @Post('merchants/:merchantId/app-config/upload-url')
  createAppConfigUploadUrl(@CurrentUser() user: User, @Param('merchantId', new ParseUUIDPipe({ version: '4' })) merchantId: string, @Body() body: { fileName?: string; contentType?: string; size?: number; slot?: string }) { return this.appConfig.createImageUploadUrl(user, merchantId, body || {}); }

  /** 备案敏感文件（filing）私有化：上传后调用，把对象 ACL 设为 private，不再匿名可读 */
  @Post('merchants/:merchantId/filing-files/make-private')
  async makeFilingFilePrivate(@CurrentUser() user: User, @Param('merchantId', new ParseUUIDPipe({ version: '4' })) merchantId: string, @Body() body: { key?: string }) {
    await this.merchantAccess.getForUser(user, merchantId);
    const objectKey = String(body?.key || '').trim();
    const prefix = `merchant-assets/${merchantId}/filing/`;
    if (!objectKey || !objectKey.startsWith(prefix)) throw new BadRequestException('文件路径无效');
    await this.appConfig.makeObjectPrivate(objectKey);
    return { privatized: true };
  }

  /** 备案敏感文件（filing）私有访问：登录 + 商户权限校验后返回 COS 临时签名 URL（前端换 URL 给 <Image> 加载） */
  @Get('merchants/:merchantId/filing-files')
  async privateFilingFile(@CurrentUser() user: User, @Param('merchantId', new ParseUUIDPipe({ version: '4' })) merchantId: string, @Query('key') key?: string) {
    await this.merchantAccess.getForUser(user, merchantId);
    const objectKey = String(key || '').trim();
    // 只允许访问本商户 filing 目录下的文件
    const prefix = `merchant-assets/${merchantId}/filing/`;
    if (!objectKey || !objectKey.startsWith(prefix)) throw new BadRequestException('文件路径无效');
    const url = this.appConfig.createPrivateFileAccessUrl(merchantId, objectKey);
    return { url };
  }
  /** 开户进度由微信真实事实与系统计算产生，禁止通过通用接口人工推进。 */
  @Post('merchants/:merchantId/registration') @Roles(UserRole.PLATFORM_ADMIN, UserRole.AGENCY_ADMIN)
  updateRegistration() { throw new GoneException('开户进度由微信真实状态自动同步，人工推进接口已停用'); }
  @UseGuards(StepUpAuthGuard)
  @Post('merchants/:merchantId/rates') @Roles(UserRole.PLATFORM_ADMIN)
  rate(@CurrentUser() user: User, @Param('merchantId', new ParseUUIDPipe({ version: '4' })) merchantId: string, @Body() body: CreateRateVersionDto, @Headers('idempotency-key') idempotencyKey?: string) { return this.commissionRate.requestChange(user, merchantId, body.rate, body.effectiveFrom, body.note, idempotencyKey); }
  @Get('platform/rate-change-requests') @Roles(UserRole.PLATFORM_ADMIN)
  platformRateChangeRequests(@CurrentUser() user: User) { return this.commissionRate.listPlatformRequests(user); }
  @Get('platform/bill-payment-confirmation-requests') @Roles(UserRole.PLATFORM_ADMIN)
  platformBillPaymentConfirmationRequests(@CurrentUser() user: User) { return this.billPaymentConfirmations.listPlatformQueue(user); }
  @Get('merchants/:merchantId/rates') @Roles(UserRole.PLATFORM_ADMIN)
  rates(@CurrentUser() user: User, @Param('merchantId', new ParseUUIDPipe({ version: '4' })) merchantId: string) { return this.commissionRate.listVersions(user, merchantId); }
  @Get('merchants/:merchantId/rate-change-requests') @Roles(UserRole.PLATFORM_ADMIN)
  rateChangeRequests(@CurrentUser() user: User, @Param('merchantId', new ParseUUIDPipe({ version: '4' })) merchantId: string) { return this.commissionRate.listRequests(user, merchantId); }
  @UseGuards(StepUpAuthGuard)
  @Post('merchants/:merchantId/rate-change-requests/:requestId/approve') @Roles(UserRole.PLATFORM_ADMIN)
  approveRateChangeRequest(@CurrentUser() user: User, @Param('merchantId', new ParseUUIDPipe({ version: '4' })) merchantId: string, @Param('requestId', new ParseUUIDPipe({ version: '4' })) requestId: string, @Body() body: ReviewRateChangeRequestDto) { return this.commissionRate.review(user, merchantId, requestId, true, body.note); }
  @UseGuards(StepUpAuthGuard)
  @Post('merchants/:merchantId/rate-change-requests/:requestId/reject') @Roles(UserRole.PLATFORM_ADMIN)
  rejectRateChangeRequest(@CurrentUser() user: User, @Param('merchantId', new ParseUUIDPipe({ version: '4' })) merchantId: string, @Param('requestId', new ParseUUIDPipe({ version: '4' })) requestId: string, @Body() body: ReviewRateChangeRequestDto) { return this.commissionRate.review(user, merchantId, requestId, false, body.note); }

  @Get('merchants/:merchantId/stores') stores(@CurrentUser() user: User, @Param('merchantId') merchantId: string) { return this.storesService.listStores(user, merchantId); }
  @Post('merchants/:merchantId/stores')
  saveStore(@CurrentUser() user: User, @Param('merchantId', new ParseUUIDPipe({ version: '4' })) merchantId: string, @Body() body: SaveStoreDto) { return this.storesService.saveStore(user, merchantId, body); }
  /** 商家预约管理（2026-08-10 预约真实闭环）：列表（按状态/日期筛选） */
  @Get('merchants/:merchantId/reservations')
  listMerchantReservations(@CurrentUser() user: User, @Param('merchantId', new ParseUUIDPipe({ version: '4' })) merchantId: string, @Query() query: { status?: string; date?: string; page?: string; pageSize?: string }) { return this.reservations.listForMerchant(user, merchantId, { status: query.status, date: query.date, page: Number(query.page || 1), pageSize: Number(query.pageSize || 20) }); }
  /** 商家处理预约（确认/取消/完成） */
  @Post('merchants/:merchantId/reservations/:reservationId/status')
  updateReservationStatus(@CurrentUser() user: User, @Param('merchantId', new ParseUUIDPipe({ version: '4' })) merchantId: string, @Param('reservationId', new ParseUUIDPipe({ version: '4' })) reservationId: string, @Body() body: { status: string; note?: string }) { return this.reservations.updateStatus(user, merchantId, reservationId, body.status as ReservationStatus, body.note); }
  @Get('merchants/:merchantId/stores/:storeId/versions')
  storeVersions(@CurrentUser() user: User, @Param('merchantId', new ParseUUIDPipe({ version: '4' })) merchantId: string, @Param('storeId', new ParseUUIDPipe({ version: '4' })) storeId: string) { return this.storesService.listStoreVersions(user, merchantId, storeId); }
  @Post('merchants/:merchantId/stores/:storeId/versions/:auditId/restore')
  restoreStoreVersion(@CurrentUser() user: User, @Param('merchantId', new ParseUUIDPipe({ version: '4' })) merchantId: string, @Param('storeId', new ParseUUIDPipe({ version: '4' })) storeId: string, @Param('auditId', new ParseUUIDPipe({ version: '4' })) auditId: string, @Body() body: RestoreStoreVersionDto) { return this.storesService.restoreStoreVersion(user, merchantId, storeId, auditId, body.expectedVersion); }

  @Get('merchants/:merchantId/packages') packages(@CurrentUser() user: User, @Param('merchantId') merchantId: string) { return this.packagesService.listPackages(user, merchantId); }
  @Post('merchants/:merchantId/packages')
  savePackage(@CurrentUser() user: User, @Param('merchantId', new ParseUUIDPipe({ version: '4' })) merchantId: string, @Body() body: SavePackageDto) { return this.packagesService.savePackage(user, merchantId, body); }
  @Get('merchants/:merchantId/packages/:packageId/versions')
  packageVersions(@CurrentUser() user: User, @Param('merchantId', new ParseUUIDPipe({ version: '4' })) merchantId: string, @Param('packageId', new ParseUUIDPipe({ version: '4' })) packageId: string) { return this.packagesService.listPackageVersions(user, merchantId, packageId); }
  @Post('merchants/:merchantId/packages/:packageId/versions/:auditId/restore')
  restorePackageVersion(@CurrentUser() user: User, @Param('merchantId', new ParseUUIDPipe({ version: '4' })) merchantId: string, @Param('packageId', new ParseUUIDPipe({ version: '4' })) packageId: string, @Param('auditId', new ParseUUIDPipe({ version: '4' })) auditId: string, @Body() body: RestorePackageVersionDto) { return this.packagesService.restorePackageVersion(user, merchantId, packageId, auditId, body.expectedVersion); }
  @Post('merchants/:merchantId/packages/:packageId/status')
  packageStatus(@CurrentUser() user: User, @Param('merchantId', new ParseUUIDPipe({ version: '4' })) merchantId: string, @Param('packageId', new ParseUUIDPipe({ version: '4' })) packageId: string, @Body() body: ChangePackageStatusDto) { return this.packagesService.setPackageStatus(user, merchantId, packageId, body.status, body.expectedVersion); }
  @Post('merchants/:merchantId/packages/:packageId/sold-count')
  packageSoldCount(@CurrentUser() user: User, @Param('merchantId', new ParseUUIDPipe({ version: '4' })) merchantId: string, @Param('packageId', new ParseUUIDPipe({ version: '4' })) packageId: string, @Body() body: UpdateSoldCountDto) { return this.packagesService.updateSoldCount(user, merchantId, packageId, body.soldCount, body.expectedVersion); }
  @Get('merchants/:merchantId/stores/:storeId/banners')
  bannersList(@CurrentUser() user: User, @Param('merchantId', new ParseUUIDPipe({ version: '4' })) merchantId: string, @Param('storeId', new ParseUUIDPipe({ version: '4' })) storeId: string) { return this.bannersService.listBanners(user, merchantId, storeId); }
  @Post('merchants/:merchantId/stores/:storeId/banners')
  bannerAdd(@CurrentUser() user: User, @Param('merchantId', new ParseUUIDPipe({ version: '4' })) merchantId: string, @Param('storeId', new ParseUUIDPipe({ version: '4' })) storeId: string, @Body() body: { url: string; link?: string }) { return this.bannersService.addBanner(user, merchantId, storeId, body.url, body.link); }
  @Post('merchants/:merchantId/stores/:storeId/banners/reorder')
  bannerReorder(@CurrentUser() user: User, @Param('merchantId', new ParseUUIDPipe({ version: '4' })) merchantId: string, @Param('storeId', new ParseUUIDPipe({ version: '4' })) storeId: string, @Body() body: { ids: string[]; defaultId?: string }) { return this.bannersService.reorderBanners(user, merchantId, storeId, body.ids, body.defaultId); }
  @Put('merchants/:merchantId/stores/:storeId/banners/:bannerId')
  bannerReplace(@CurrentUser() user: User, @Param('merchantId', new ParseUUIDPipe({ version: '4' })) merchantId: string, @Param('storeId', new ParseUUIDPipe({ version: '4' })) storeId: string, @Param('bannerId', new ParseUUIDPipe({ version: '4' })) bannerId: string, @Body() body: { url: string; link?: string }) { return this.bannersService.replaceBanner(user, merchantId, storeId, bannerId, body.url, body.link); }
  @Delete('merchants/:merchantId/stores/:storeId/banners/:bannerId')
  bannerRemove(@CurrentUser() user: User, @Param('merchantId', new ParseUUIDPipe({ version: '4' })) merchantId: string, @Param('storeId', new ParseUUIDPipe({ version: '4' })) storeId: string, @Param('bannerId', new ParseUUIDPipe({ version: '4' })) bannerId: string) { return this.bannersService.removeBanner(user, merchantId, storeId, bannerId); }
  @UseGuards(StepUpAuthGuard)
  @Post('merchants/:merchantId/packages/batch-status')
  batchPackageStatus(@CurrentUser() user: User, @Param('merchantId', new ParseUUIDPipe({ version: '4' })) merchantId: string, @Body() body: CreatePackageBatchStatusDto, @Headers('idempotency-key') idempotencyKey?: string) {
    return this.batchOperations.requestPackageStatusBatch(user, merchantId, body, idempotencyKey || '');
  }
  @Get('batch-operations')
  batchOperationsList(@CurrentUser() user: User, @Query('merchantId') merchantId?: string) { return this.batchOperations.listOperations(user, merchantId); }
  @Get('batch-operations/:operationId')
  batchOperation(@CurrentUser() user: User, @Param('operationId', new ParseUUIDPipe({ version: '4' })) operationId: string) { return this.batchOperations.getOperation(user, operationId); }

  @Get('merchants/:merchantId/users') users(@CurrentUser() user: User, @Param('merchantId') merchantId: string) { return this.staffService.listUsers(user, merchantId); }
  @Post('merchants/:merchantId/staff')
  staff(@CurrentUser() user: User, @Param('merchantId', new ParseUUIDPipe({ version: '4' })) merchantId: string, @Body() body: SaveStaffDto) { return this.staffService.saveStaff(user, merchantId, body); }
  @UseGuards(StepUpAuthGuard)
  @Post('merchants/:merchantId/staff/:staffId/active')
  staffActive(@CurrentUser() user: User, @Param('merchantId', new ParseUUIDPipe({ version: '4' })) merchantId: string, @Param('staffId', new ParseUUIDPipe({ version: '4' })) staffId: string, @Body() body: SetStaffActiveDto, @Headers('idempotency-key') idempotencyKey?: string) { return this.staffService.setStaffActive(user, merchantId, staffId, body.active, idempotencyKey); }
  @UseGuards(StepUpAuthGuard)
  @Post('merchants/:merchantId/staff/:staffId/unbind')
  staffUnbind(@CurrentUser() user: User, @Param('merchantId', new ParseUUIDPipe({ version: '4' })) merchantId: string, @Param('staffId', new ParseUUIDPipe({ version: '4' })) staffId: string) { return this.staffService.unbindVerifier(user, merchantId, staffId); }
  @UseGuards(StepUpAuthGuard)
  @Post('merchants/:merchantId/staff/:staffId/wechat-bind-token')
  staffWechatBindToken(@CurrentUser() user: User, @Param('merchantId', new ParseUUIDPipe({ version: '4' })) merchantId: string, @Param('staffId', new ParseUUIDPipe({ version: '4' })) staffId: string) { return this.staffService.createWechatBindToken(user, merchantId, staffId); }
  @UseGuards(StepUpAuthGuard)
  @Post('merchants/:merchantId/staff/batch-store-access')
  batchStaffStoreAccess(@CurrentUser() user: User, @Param('merchantId', new ParseUUIDPipe({ version: '4' })) merchantId: string, @Body() body: CreateStaffStoreAccessBatchDto, @Headers('idempotency-key') idempotencyKey?: string) {
    return this.staffBatchOperations.request(user, merchantId, body, idempotencyKey || '');
  }
  @Post('merchants/:merchantId/exception-refund-requests') @Roles(UserRole.MERCHANT_ADMIN)
  exceptionRefundRequest(@CurrentUser() user: User, @Param('merchantId', new ParseUUIDPipe({ version: '4' })) merchantId: string, @Body() body: CreateExceptionRefundRequestDto) { return this.supportTickets.createExceptionRefundRequest(user, merchantId, body); }

  @Get('orders') orders(@CurrentUser() user: User, @Query() query: OrderListQueryDto) { return this.transactionRead.listOrders(user, query); }
  @Get('payment-transactions') paymentTransactions(@CurrentUser() user: User, @Query() query: TransactionListQueryDto) { return this.transactionRead.listPaymentTransactions(user, query); }
  @Get('refund-transactions') refundTransactions(@CurrentUser() user: User, @Query() query: TransactionListQueryDto) { return this.transactionRead.listRefundTransactions(user, query); }
  @Get('vouchers') vouchers(@CurrentUser() user: User, @Query() query: TransactionListQueryDto) { return this.transactionRead.listVouchers(user, query); }
  @Post('vouchers/:voucherId/transfer-store') @Roles(UserRole.PLATFORM_ADMIN)
  transferVoucherStore(@CurrentUser() user: User, @Param('voucherId', new ParseUUIDPipe({ version: '4' })) voucherId: string, @Body() body: TransferVoucherStoreDto) { return this.voucherFulfillment.transferStore(user, voucherId, body.targetStoreId); }
  @UseGuards(StepUpAuthGuard)
  @Post('merchants/:merchantId/vouchers/batch-transfer-store') @Roles(UserRole.PLATFORM_ADMIN)
  batchTransferVoucherStore(@CurrentUser() user: User, @Param('merchantId', new ParseUUIDPipe({ version: '4' })) merchantId: string, @Body() body: CreateVoucherStoreTransferBatchDto, @Headers('idempotency-key') idempotencyKey?: string) {
    return this.voucherBatchOperations.request(user, merchantId, body, idempotencyKey || '');
  }
  @UseGuards(StepUpAuthGuard)
  @Post('merchants/:merchantId/vouchers/batch-compensation-refund') @Roles(UserRole.PLATFORM_ADMIN)
  batchCompensationRefund(@CurrentUser() user: User, @Param('merchantId', new ParseUUIDPipe({ version: '4' })) merchantId: string, @Body() body: CreateVoucherCompensationRefundBatchDto, @Headers('idempotency-key') idempotencyKey?: string) {
    return this.refundBatchOperations.request(user, merchantId, body, idempotencyKey || '');
  }
  @UseGuards(StepUpAuthGuard)
  @Post('vouchers/:voucherId/retry-refund') @Roles(UserRole.PLATFORM_ADMIN)
  retryVoucherRefund(@CurrentUser() user: User, @Param('voucherId', new ParseUUIDPipe({ version: '4' })) voucherId: string) { return this.refunds.retry(user, voucherId); }
  @UseGuards(StepUpAuthGuard)
  @Post('vouchers/:voucherId/store-closure-refund') @Roles(UserRole.PLATFORM_ADMIN)
  refundClosedStoreVoucher(@CurrentUser() user: User, @Param('voucherId', new ParseUUIDPipe({ version: '4' })) voucherId: string) { return this.refunds.refundForClosedStore(user, voucherId); }
  @Get('verifications') verifications(@CurrentUser() user: User, @Query() query: TransactionListQueryDto) { return this.transactionRead.listVerifications(user, query); }
  @Get('support-tickets') supportTicketsList(@CurrentUser() user: User, @Query() query: TransactionListQueryDto) { return this.supportTickets.listSupportTickets(user, query); }
  @Get('support-tickets/:ticketId/replies')
  supportTicketReplies(@CurrentUser() user: User, @Param('ticketId', new ParseUUIDPipe({ version: '4' })) ticketId: string) { return this.supportTickets.listSupportTicketReplies(user, ticketId); }
  @Post('support-tickets/:ticketId/replies')
  replySupportTicket(@CurrentUser() user: User, @Param('ticketId', new ParseUUIDPipe({ version: '4' })) ticketId: string, @Body() body: ReplySupportTicketDto) { return this.supportTickets.replySupportTicket(user, ticketId, body.content); }
  @Post('support-tickets/:ticketId/resolve')
  resolveSupportTicket(@CurrentUser() user: User, @Param('ticketId', new ParseUUIDPipe({ version: '4' })) ticketId: string, @Body() body: ResolveSupportTicketDto) { return this.supportTickets.resolveSupportTicket(user, ticketId, body.note); }
  @UseGuards(StepUpAuthGuard)
  @Post('support-tickets/:ticketId/approve-exception-refund') @Roles(UserRole.PLATFORM_ADMIN)
  approveExceptionRefund(@CurrentUser() user: User, @Param('ticketId', new ParseUUIDPipe({ version: '4' })) ticketId: string, @Body() body: ReviewRateChangeRequestDto) { return this.supportTickets.approveExceptionRefund(user, ticketId, body.note); }
  @UseGuards(StepUpAuthGuard)
  @Post('support-tickets/:ticketId/reject-exception-refund') @Roles(UserRole.PLATFORM_ADMIN)
  rejectExceptionRefund(@CurrentUser() user: User, @Param('ticketId', new ParseUUIDPipe({ version: '4' })) ticketId: string, @Body() body: ReviewRateChangeRequestDto) { return this.supportTickets.rejectExceptionRefund(user, ticketId, body.note); }
  @UseGuards(StepUpAuthGuard)
  @Post('support-tickets/:ticketId/execute-exception-refund') @Roles(UserRole.PLATFORM_ADMIN)
  executeExceptionRefund(@CurrentUser() user: User, @Param('ticketId', new ParseUUIDPipe({ version: '4' })) ticketId: string, @Body() body: ExecuteExceptionRefundDto) { return this.refunds.executeApprovedException(user, ticketId, body.note); }
  @Get('reports/summary') report(@CurrentUser() user: User, @Query('merchantId') merchantId?: string) { return this.reporting.summary(user, merchantId); }
  @Get('reports/analytics') reportAnalytics(@CurrentUser() user: User, @Query() query: ReportAnalyticsQueryDto) { return this.reporting.analytics(user, query.merchantId, query.from, query.to); }
  @UseGuards(StepUpAuthGuard)
  @Post('exports')
  async createExport(@CurrentUser() user: User, @Body() body: CreateExportJobDto, @Headers('idempotency-key') idempotencyKey?: string) {
    // Generation encrypts potentially large transaction exports, so this is
    // intentionally stricter than ordinary read APIs.
    await this.requestThrottle.consume('operator-export-create', user.id, 10, 15 * 60_000);
    return this.exports.create(user, body, idempotencyKey);
  }
  @Get('exports')
  exportJobs(@CurrentUser() user: User) { return this.exports.list(user); }
  @Get('exports/:exportJobId')
  exportJob(@CurrentUser() user: User, @Param('exportJobId', new ParseUUIDPipe({ version: '4' })) exportJobId: string) { return this.exports.get(user, exportJobId); }
  @UseGuards(StepUpAuthGuard)
  @Get('exports/:exportJobId/download')
  async downloadExport(@CurrentUser() user: User, @Param('exportJobId', new ParseUUIDPipe({ version: '4' })) exportJobId: string, @Res() response: Response) {
    const { csv, filename } = await this.exports.download(user, exportJobId);
    response.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.type('text/csv; charset=utf-8').send(`\ufeff${csv}`);
  }
  @Post('exports/:exportJobId/revoke')
  revokeExport(@CurrentUser() user: User, @Param('exportJobId', new ParseUUIDPipe({ version: '4' })) exportJobId: string) { return this.exports.revoke(user, exportJobId); }

  @Post('verification/preview') @Roles(UserRole.STORE_STAFF)
  async preview(@CurrentUser() user: User, @Body() body: VerificationPreviewDto) {
    // Preview accepts an untrusted scanned value and therefore gets a higher
    // ceiling than confirmation while still containing automated token probes.
    await this.requestThrottle.consume('staff-verification-preview', user.id, 120, 60_000);
    return this.verification.preview(user, body);
  }
  @Post('verification/confirm') @Roles(UserRole.STORE_STAFF)
  async verify(@CurrentUser() user: User, @Body() body: VerificationConfirmDto) {
    // A physical staff member cannot reasonably confirm more than one voucher
    // per second; the limit also protects row-lock capacity during abuse.
    await this.requestThrottle.consume('staff-verification-confirm', user.id, 60, 60_000);
    return this.verification.confirm(user, body);
  }

  @Get('bills') bills(@CurrentUser() user: User, @Query('merchantId') merchantId?: string) { return this.billing.listBills(user, merchantId); }
  @UseGuards(StepUpAuthGuard)
  @Post('bills/generate') @Roles(UserRole.PLATFORM_ADMIN)
  generateBills(@CurrentUser() user: User, @Body() body: GenerateBillsDto, @Headers('idempotency-key') idempotencyKey?: string) { return this.billing.generateBills(user, body.period, idempotencyKey); }
  @Post('bills/:billId/dispute') @Roles(UserRole.MERCHANT_ADMIN)
  createBillDispute(@CurrentUser() user: User, @Param('billId', new ParseUUIDPipe({ version: '4' })) billId: string, @Body() body: CreateBillDisputeDto) { return this.billing.createBillDispute(user, billId, body.content); }
  @Post('bills/:billId/dispute/resolve') @Roles(UserRole.PLATFORM_ADMIN)
  resolveBillDispute(@CurrentUser() user: User, @Param('billId', new ParseUUIDPipe({ version: '4' })) billId: string, @Body() body: ResolveBillDisputeDto) { return this.billing.resolveBillDispute(user, billId, body.note); }
  @UseGuards(StepUpAuthGuard)
  @Post('bills/:billId/payment-confirmation-requests') @Roles(UserRole.PLATFORM_ADMIN)
  requestBillPaymentConfirmation(@CurrentUser() user: User, @Param('billId', new ParseUUIDPipe({ version: '4' })) billId: string, @Body() body: CreateBillPaymentConfirmationRequestDto, @Headers('idempotency-key') idempotencyKey?: string) { return this.billPaymentConfirmations.request(user, billId, body, idempotencyKey); }
  @Get('bills/:billId/payment-confirmation-requests') @Roles(UserRole.PLATFORM_ADMIN)
  billPaymentConfirmationRequests(@CurrentUser() user: User, @Param('billId', new ParseUUIDPipe({ version: '4' })) billId: string) { return this.billPaymentConfirmations.listForBill(user, billId); }
  @UseGuards(StepUpAuthGuard)
  @Post('bills/:billId/payment-confirmation-requests/:requestId/approve') @Roles(UserRole.PLATFORM_ADMIN)
  approveBillPaymentConfirmationRequest(@CurrentUser() user: User, @Param('billId', new ParseUUIDPipe({ version: '4' })) billId: string, @Param('requestId', new ParseUUIDPipe({ version: '4' })) requestId: string, @Body() body: ReviewRateChangeRequestDto) { return this.billPaymentConfirmations.review(user, billId, requestId, true, body.note); }
  @UseGuards(StepUpAuthGuard)
  @Post('bills/:billId/payment-confirmation-requests/:requestId/reject') @Roles(UserRole.PLATFORM_ADMIN)
  rejectBillPaymentConfirmationRequest(@CurrentUser() user: User, @Param('billId', new ParseUUIDPipe({ version: '4' })) billId: string, @Param('requestId', new ParseUUIDPipe({ version: '4' })) requestId: string, @Body() body: ReviewRateChangeRequestDto) { return this.billPaymentConfirmations.review(user, billId, requestId, false, body.note); }
  @UseGuards(StepUpAuthGuard)
  @Post('bills/:billId/invoice') @Roles(UserRole.PLATFORM_ADMIN)
  updateBillInvoice(@CurrentUser() user: User, @Param('billId', new ParseUUIDPipe({ version: '4' })) billId: string, @Body() body: UpdateBillInvoiceDto) { return this.billing.updateBillInvoice(user, billId, body.invoiceStatus, body.invoiceNumber); }
  @UseGuards(StepUpAuthGuard)
  @Post('bills/:billId/adjustments') @Roles(UserRole.PLATFORM_ADMIN)
  requestBillAdjustment(@CurrentUser() user: User, @Param('billId', new ParseUUIDPipe({ version: '4' })) billId: string, @Body() body: CreateBillAdjustmentDto, @Headers('idempotency-key') idempotencyKey?: string) {
    return this.accountingAdjustments.requestAdjustment(user, billId, body, idempotencyKey || '');
  }
  @Get('bills/:billId/adjustments') @Roles(UserRole.PLATFORM_ADMIN)
  billAdjustments(@CurrentUser() user: User, @Param('billId', new ParseUUIDPipe({ version: '4' })) billId: string) { return this.accountingAdjustments.listAdjustments(user, billId); }
  @Get('bills/:billId/balance-check') @Roles(UserRole.PLATFORM_ADMIN)
  billBalanceCheck(@CurrentUser() user: User, @Param('billId', new ParseUUIDPipe({ version: '4' })) billId: string) { return this.accountingAdjustments.balanceCheck(user, billId); }
  @UseGuards(StepUpAuthGuard)
  @Post('bills/adjustments/:adjustmentId/approve') @Roles(UserRole.PLATFORM_ADMIN)
  approveBillAdjustment(@CurrentUser() user: User, @Param('adjustmentId', new ParseUUIDPipe({ version: '4' })) adjustmentId: string, @Body() body: ReviewBillAdjustmentDto) { return this.accountingAdjustments.reviewAdjustment(user, adjustmentId, true, body.note); }
  @UseGuards(StepUpAuthGuard)
  @Post('bills/adjustments/:adjustmentId/reject') @Roles(UserRole.PLATFORM_ADMIN)
  rejectBillAdjustment(@CurrentUser() user: User, @Param('adjustmentId', new ParseUUIDPipe({ version: '4' })) adjustmentId: string, @Body() body: ReviewBillAdjustmentDto) { return this.accountingAdjustments.reviewAdjustment(user, adjustmentId, false, body.note); }
  @UseGuards(StepUpAuthGuard)
  @Post('bills/adjustments/:adjustmentId/reversal') @Roles(UserRole.PLATFORM_ADMIN)
  requestBillAdjustmentReversal(@CurrentUser() user: User, @Param('adjustmentId', new ParseUUIDPipe({ version: '4' })) adjustmentId: string, @Body() body: CreateBillReversalDto, @Headers('idempotency-key') idempotencyKey?: string) {
    return this.accountingAdjustments.requestReversal(user, adjustmentId, body.note, idempotencyKey || '');
  }
  @Get('merchants/:merchantId/audits') audits(@CurrentUser() user: User, @Param('merchantId', new ParseUUIDPipe({ version: '4' })) merchantId: string, @Query() query: PaginationQueryDto) { return this.auditRead.listForMerchant(user, merchantId, query); }
}
