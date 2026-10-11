import { BadRequestException, ConflictException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash, randomBytes } from 'crypto';
import { DataSource, In, Repository } from 'typeorm';
import {
  CommissionRateVersion, DealPackage, Merchant, MerchantStatus, MerchantTemplateConfig, Order, OrderStatus,
  PackageStatus, PaymentOutbox, PaymentOutboxStatus, Refund, Store, Voucher, VoucherStatus,
} from './domain/entities';
import { AuditWriterService } from './audit-writer.service';
import { PackageService } from './package.service';
import { PaymentProcessingService } from './payment-processing.service';
import { VerificationService } from './verification.service';
import { PlatformRuntimeControlService } from './platform-runtime-control.service';
import type { CustomerIdentity } from './app-service.core-types';

export type CustomerVoucherListItem = Pick<Voucher, 'id' | 'code' | 'merchantId' | 'packageId' | 'storeId' | 'faceValueFen' | 'status' | 'validFrom' | 'validTo' | 'createdAt'> & {
  /** 支付后券包高亮定位所需的订单关联；只读透传，不改变支付状态。 */
  orderId: string;
  merchantName: string;
  storeName: string;
  storeAddress: string;
  packageTitle: string;
  refundStatus: string | null;
};
export type CustomerVoucherPage = { items: CustomerVoucherListItem[]; nextCursor: string | null };

@Injectable()
export class CustomerCommerceService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly auditWriter: AuditWriterService,
    private readonly packageService: PackageService,
    private readonly paymentProcessing: PaymentProcessingService,
    private readonly verificationService: VerificationService,
    private readonly runtimeControls: PlatformRuntimeControlService,
    @InjectRepository(Merchant) private readonly merchants: Repository<Merchant>,
    @InjectRepository(MerchantTemplateConfig) private readonly templateConfigs: Repository<MerchantTemplateConfig>,
    @InjectRepository(DealPackage) private readonly packagesRepo: Repository<DealPackage>,
    @InjectRepository(Store) private readonly stores: Repository<Store>,
    @InjectRepository(Order) private readonly orders: Repository<Order>,
    @InjectRepository(Voucher) private readonly vouchers: Repository<Voucher>,
    @InjectRepository(Refund) private readonly refunds: Repository<Refund>,
    @InjectRepository(CommissionRateVersion) private readonly rates: Repository<CommissionRateVersion>,
  ) {}

  async publicMerchant(merchantId: string) {
    const merchant = await this.merchants.findOneBy({ id: merchantId });
    if (!merchant || !this.isMerchantSaleActive(merchant)) throw new NotFoundException('店铺暂不可访问');
    const [stores, templateConfig] = await Promise.all([
      this.stores.findBy({ merchantId, openForSale: true }),
      this.templateConfigs.findOneBy({ merchantId }),
    ]);
    return {
      merchant: { id: merchant.id, brandName: merchant.brandName, logoUrl: merchant.logoUrl, primaryColor: merchant.primaryColor, servicePhone: merchant.servicePhone },
      templateConfig: { homeTitle: templateConfig?.homeTitle || '', homeSubtitle: templateConfig?.homeSubtitle || '', featuredPackageId: templateConfig?.featuredPackageId || null },
      stores: stores.map((store) => ({ id: store.id, name: store.name, address: store.address, latitude: store.latitude, longitude: store.longitude, phone: store.phone, businessHours: store.businessHours })),
    };
  }

  async publicMerchants() {
    const merchants = await this.merchants.find({ where: { status: MerchantStatus.ACTIVE }, order: { brandName: 'ASC' } });
    return merchants.filter((merchant) => this.isMerchantSaleActive(merchant)).map((merchant) => ({ id: merchant.id, brandName: merchant.brandName, logoUrl: merchant.logoUrl, primaryColor: merchant.primaryColor, servicePhone: merchant.servicePhone }));
  }

  async createOrder(merchantId: string, customer: CustomerIdentity, input: { idempotencyKey: string; packageId: string; storeId: string; quantity: number }): Promise<Order> {
    if (!Number.isInteger(input.quantity) || input.quantity < 1 || input.quantity > 20) throw new BadRequestException('购买数量必须为 1 至 20');
    if (typeof input.idempotencyKey !== 'string' || !/^[A-Za-z0-9_-]{12,128}$/.test(input.idempotencyKey)) throw new BadRequestException('下单请求标识格式不正确');
    this.paymentProcessing.assertEnabled();
    let created: Order;
    try {
      created = await this.dataSource.transaction(async (manager) => {
        await this.runtimeControls.assertSalesEnabled(manager);
        const merchant = await manager.findOne(Merchant, { where: { id: merchantId }, lock: { mode: 'pessimistic_write' } });
        if (!merchant || !this.isMerchantSaleActive(merchant)) throw new BadRequestException('商家已暂停售卖');
        const existing = await manager.findOneBy(Order, { customerId: customer.id, idempotencyKey: input.idempotencyKey });
        if (existing) {
          // 幂等命中：仅当旧单仍"进行中（待支付）"时复用，防止网络重试重复下单；
          // 旧单已终态（超时关闭/已支付/已退款）时视为失效，允许重新下单（用新键避免唯一约束冲突）
          if (existing.status === OrderStatus.PENDING_PAYMENT && new Date(existing.paymentExpiresAt) > new Date()) {
            this.ensureSameOrderIntent(existing, merchantId, input);
            return existing;
          }
          // #8：旧单仍是 PENDING_PAYMENT 但已超支付窗口（未及清扫）——先关闭旧单再重下单，
          // 防旧单滞留（占 soldCount/限购额度）与旧单晚付触发资金滞留（NEEDS_RECONCILIATION）
          if (existing.status === OrderStatus.PENDING_PAYMENT) {
            const before = { status: existing.status };
            existing.status = OrderStatus.CLOSED;
            await manager.save(Order, existing);
            await manager.update(PaymentOutbox, { orderId: existing.id, status: In([PaymentOutboxStatus.PENDING, PaymentOutboxStatus.PROCESSING, PaymentOutboxStatus.RETRY, PaymentOutboxStatus.DISPATCHED]) }, { status: PaymentOutboxStatus.CANCELLED, lastError: '顾客重新下单，旧单关闭' });
            await manager.decrement(DealPackage, { id: existing.packageId }, 'soldCount', existing.quantity);
            await this.auditWriter.write(`customer:${customer.id}`, merchantId, 'ORDER_REPLACED_BY_NEW_ORDER', 'Order', existing.id, before, { status: OrderStatus.CLOSED, reason: '旧单超时被新订单替代' }, manager);
          }
          input = { ...input, idempotencyKey: `${input.idempotencyKey.slice(0, 20)}-${Date.now().toString(36).slice(-4)}` };
        }
        const paymentRoute = await this.paymentProcessing.paymentRoute(manager, merchantId);
        const store = await manager.findOne(Store, { where: { id: input.storeId, merchantId }, lock: { mode: 'pessimistic_write' } });
        if (!store?.openForSale) throw new BadRequestException('所选门店暂不可售');
        const deal = await manager.findOne(DealPackage, { where: { id: input.packageId, merchantId }, lock: { mode: 'pessimistic_write' } });
        if (!deal || deal.status !== PackageStatus.ON_SALE || this.day(deal.validFrom) > this.day() || this.day(deal.validTo) < this.day()) throw new BadRequestException('套餐当前不可购买');
        await this.packageService.assertStoreApplies(manager, deal, input.storeId);
        if (deal.saleLimit > 0 && deal.soldCount + input.quantity > deal.saleLimit) throw new BadRequestException('套餐库存不足');
        if (deal.perCustomerLimit > 0) {
          // 限购口径：已支付 + 仍在支付窗口内的待支付单（过期未清扫的 PENDING 单不计入，避免顾客被幽灵订单拦截）
          const past = await manager.createQueryBuilder(Order, 'o').where('o.packageId = :packageId AND o.customerId = :customerId AND (o.status = :paid OR (o.status = :pending AND o.paymentExpiresAt > :now))', { packageId: deal.id, customerId: customer.id, paid: OrderStatus.PAID, pending: OrderStatus.PENDING_PAYMENT, now: new Date() }).select('COALESCE(SUM(o.quantity), 0)', 'total').getRawOne<{ total: string }>();
          if (Number(past?.total || 0) + input.quantity > deal.perCustomerLimit) throw new BadRequestException('超过每人限购数量');
        }
        const rate = await this.activeRate(merchantId);
        // M7：价格必须为正（0 元/负价单走真实渠道必然失败，拒绝下单）
        if (!Number.isFinite(deal.priceFen) || deal.priceFen <= 0) throw new BadRequestException('套餐价格异常，暂不可购买');
        deal.soldCount += input.quantity;
        await manager.save(DealPackage, deal);
        const validityMode = deal.validityMode || 'ABSOLUTE';
        const validityDurationDays = deal.validityDurationDays ?? null;
        const purchaseDay = this.day(new Date());
        const relativeFrom = validityMode === 'PURCHASE_RELATIVE' ? this.businessDayStart(purchaseDay) : new Date(deal.validFrom);
        const relativeTo = validityMode === 'PURCHASE_RELATIVE' ? this.businessDayStart(this.addBusinessDays(purchaseDay, validityDurationDays || 1)) : new Date(deal.validTo);
        const order = await manager.save(Order, { orderNo: this.nextOrderNo(), merchantId, packageId: deal.id, storeId: store.id, customerId: customer.id, idempotencyKey: input.idempotencyKey, quantity: input.quantity, amountFen: deal.priceFen * input.quantity, unitPriceFen: deal.priceFen, packageTitleSnapshot: deal.title, packageVersionSnapshot: deal.version, validFromSnapshot: relativeFrom, validToSnapshot: relativeTo, validityModeSnapshot: validityMode, validityDurationDaysSnapshot: validityDurationDays, commissionRateSnapshot: rate.rate, status: OrderStatus.PENDING_PAYMENT, paymentExpiresAt: new Date(Date.now() + 15 * 60 * 1000), paymentReference: null });
        await manager.save(PaymentOutbox, { orderId: order.id, merchantId: order.merchantId, provider: paymentRoute.provider, paymentProfileId: paymentRoute.paymentProfileId, providerMerchantId: paymentRoute.providerMerchantId, idempotencyKey: `order-${order.id}`, amountFen: order.amountFen, expiresAt: order.paymentExpiresAt, status: PaymentOutboxStatus.PENDING, attemptCount: 0, lastAttemptAt: null, lastReconciledAt: null, nextAttemptAt: new Date(), providerReference: null, lastError: '' });
        await this.auditWriter.write(`customer:${customer.id}`, merchantId, 'ORDER_CREATED', 'Order', order.id, null, { orderNo: order.orderNo, amountFen: order.amountFen, quantity: order.quantity, status: order.status }, manager);
        return order;
      });
    } catch (error) {
      if (!this.isUniqueConstraintError(error)) throw error;
      const existing = await this.orders.findOneBy({ customerId: customer.id, idempotencyKey: input.idempotencyKey });
      if (!existing) throw error;
      this.ensureSameOrderIntent(existing, merchantId, input);
      created = existing;
    }
    await this.paymentProcessing.dispatchPendingIntents(1);
    return created;
  }

  async confirmDemoPayment(orderId: string, customer: CustomerIdentity): Promise<{ order: Order; vouchers: Voucher[] }> {
    return this.paymentProcessing.confirmDemoPayment(orderId, customer);
  }

  /** 桌面版模板：POST /public/orders 下单即返回 orderId + prepay（对齐其支付契约） */
  async createOrderForPublic(merchantId: string, customer: CustomerIdentity, input: { packageId: string; storeId: string; quantity: number; remark?: string; idempotencyKey?: string }): Promise<{ orderId: string; prepay: Record<string, unknown> | null }> {
    // 门店归属会影响履约、券适用范围及后续售后。仅在套餐恰好只有一家可售适用门店时
    // 自动确定；多门店必须由顾客明确选择，绝不按排序取第一家。
    let storeId = input.storeId;
    if (!storeId) {
      const deal = await this.packagesRepo.findOne({ where: { id: input.packageId, merchantId } });
      if (!deal) throw new BadRequestException('套餐不存在');
      const storeIds = await this.packageService.storeIdsFor(this.dataSource.manager, { id: deal.id, merchantId, storeIds: deal.storeIds });
      const openStores = await this.stores.find({ where: { merchantId, openForSale: true } });
      const applicableStores = openStores.filter((store) => storeIds.includes(store.id));
      if (applicableStores.length === 1) {
        storeId = applicableStores[0].id;
      } else if (!applicableStores.length) {
        throw new BadRequestException('该套餐当前未绑定可售门店');
      } else {
        throw new BadRequestException('该套餐适用多家门店，请先选择门店后再下单');
      }
    }
    // H2：幂等键按请求内容确定性派生（顾客+套餐+门店+数量+分钟窗口），网络重试同内容同键，避免重复下单占库存
    const idempotencyKey = input.idempotencyKey || this.deriveOrderIdempotencyKey(customer.id, input.packageId, storeId, input.quantity);
    const order = await this.createOrder(merchantId, customer, { idempotencyKey, packageId: input.packageId, storeId, quantity: input.quantity });
    const params = await this.paymentProcessing.paymentParams(order.id, customer.id);
    const prepay = this.parsePrepay(params.payInfo);
    if (!prepay) throw new ServiceUnavailableException('支付参数未准备完成，请稍后重试');
    return { orderId: order.id, prepay };
  }

  /** 把 pay_info（WeixinJSBridge.invoke 串或 JSON）解析成小程序端可识别的支付参数对象（兼容微信直连、天阙收银台、汇付 V3 聚合正扫） */
  private parsePrepay(payInfo: string): Record<string, unknown> | null {
    let raw = String(payInfo || '').trim();
    if (!raw) return null;
    const match = raw.match(/getBrandWCPayRequest'\s*,\s*(\{[\s\S]*\})\s*\)\s*;?\s*$/);
    if (match) raw = match[1];
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (parsed && parsed.timeStamp && parsed.nonceStr && parsed.package && parsed.paySign) {
        return { mode: 'wechat', timeStamp: parsed.timeStamp, nonceStr: parsed.nonceStr, package: parsed.package, signType: parsed.signType || 'RSA', paySign: parsed.paySign };
      }
      // 天阙小程序收银台：payInfo 为 { mode: 'tianque', appId, path, uuid }
      if (parsed && parsed.mode === 'tianque' && parsed.appId && parsed.path) {
        return { mode: 'tianque', appId: parsed.appId, path: parsed.path, uuid: parsed.uuid || '' };
      }
      // 汇付 V3 聚合正扫：payInfo 为 { mode: 'huifu', pay_info: "<微信 JSAPI 参数 JSON>" }，透传给前端直接 wx.requestPayment
      if (parsed && parsed.mode === 'huifu' && parsed.pay_info) {
        return { mode: 'huifu', pay_info: parsed.pay_info, orderNo: parsed.orderNo || '', hfSeqId: parsed.hfSeqId || '' };
      }
    } catch { /* fallthrough */ }
    return null;
  }

  /** 取小程序端调起支付参数（真实支付链路用）。 */
  async paymentParams(orderId: string, customer: CustomerIdentity): Promise<{ payInfo: string; expiresAt: Date }> {
    return this.paymentProcessing.paymentParams(orderId, customer.id);
  }

  /** 支付参数（含小程序端可直接使用的 prepay 对象，兼容微信直连与天阙收银台）。 */
  async paymentParamsForPublic(orderId: string, customer: CustomerIdentity): Promise<{ prepay: Record<string, unknown> | null; payInfo: string; expiresAt: Date }> {
    const { payInfo, expiresAt } = await this.paymentParams(orderId, customer);
    return { prepay: this.parsePrepay(payInfo), payInfo, expiresAt };
  }

  async customerVouchers(customer: CustomerIdentity, merchantId?: string): Promise<CustomerVoucherListItem[]> {
    return this.customerVoucherListItems(await this.vouchers.find({ where: { customerId: customer.id, ...(merchantId ? { merchantId } : {}) }, order: { createdAt: 'DESC', id: 'DESC' } }));
  }

  /** 桌面版模板：GET /public/orders 订单列表（对齐其状态枚举与字段） */
  async customerOrderPage(customer: CustomerIdentity, input: { page?: number; limit?: number; status?: string; merchantId?: string }): Promise<{ items: Array<Record<string, unknown>> }> {
    const page = Math.max(1, Number(input.page || 1));
    const size = Math.max(1, Math.min(50, Number(input.limit || 20)));
    const query = this.orders.createQueryBuilder('order')
      .where('order.customerId = :customerId' + (input.merchantId ? ' AND order.merchantId = :merchantId' : ''), { customerId: customer.id, ...(input.merchantId ? { merchantId: input.merchantId } : {}) })
      .orderBy('order.createdAt', 'DESC')
      .addOrderBy('order.id', 'DESC')
      .skip((page - 1) * size)
      .take(size);
    if (input.status && input.status !== 'ALL') {
      const mapped = this.publicOrderStatusToInternal(input.status);
      if (mapped) query.andWhere('order.status = :status', { status: mapped });
    }
    const orders = await query.getMany();
    const packageIds = [...new Set(orders.map((o) => o.packageId))];
    const covers = new Map<string, string>();
    if (packageIds.length) {
      const pkgs = await this.packagesRepo.find({ where: { id: In(packageIds) }, select: { id: true, coverImageUrl: true } });
      for (const p of pkgs) covers.set(p.id, p.coverImageUrl || '');
    }
    const usedStatus = new Map<string, boolean>();
    for (const o of orders) {
      if (o.status === OrderStatus.PAID) usedStatus.set(o.id, await this.orderHasUsedVoucher(o.id));
    }
    // FIX: 订单列表补充 voucherId——小程序订单页"查看券码"按钮依赖 item.voucherId 跳转券包页，
    // 此前接口未返回该字段导致前端恒为空、点击无反应。PAID 订单取该订单的一张券（未使用优先）。
    const voucherIds = new Map<string, string>();
    const paidOrderIds = orders.filter((o) => o.status === OrderStatus.PAID).map((o) => o.id);
    if (paidOrderIds.length) {
      const orderVouchers = await this.vouchers.createQueryBuilder('voucher')
        .select(['voucher.id', 'voucher.orderId', 'voucher.status'])
        .where('voucher.orderId IN (:...ids)', { ids: paidOrderIds })
        .orderBy("CASE WHEN voucher.status = 'UNUSED' THEN 0 ELSE 1 END", 'ASC')
        .addOrderBy('voucher.createdAt', 'DESC')
        .getMany();
      for (const v of orderVouchers) {
        if (!voucherIds.has(v.orderId)) voucherIds.set(v.orderId, v.id);
      }
    }
    const items = orders.map((o) => ({
      id: o.id,
      orderNo: o.orderNo,
      packageTitle: o.packageTitleSnapshot,
      coverImageUrl: covers.get(o.packageId) || '',
      quantity: o.quantity,
      totalFen: o.amountFen,
      status: this.publicOrderStatusFromInternal(o.status, usedStatus.get(o.id) || false),
      createdAt: o.createdAt,
      packageId: o.packageId,
      voucherId: o.status === OrderStatus.PAID ? voucherIds.get(o.id) || null : null,
    }));
    return { items };
  }

  /** 桌面版模板：GET /public/orders/:orderId 单订单查询（校验归属，供支付轮询/详情用） */
  async customerOrderById(orderId: string, customer: CustomerIdentity, merchantId?: string): Promise<Record<string, unknown> | null> {
    const order = await this.orders.findOne({ where: { id: orderId, customerId: customer.id, ...(merchantId ? { merchantId } : {}) } });
    if (!order) return null;
    const used = order.status === OrderStatus.PAID ? await this.orderHasUsedVoucher(order.id) : false;
    // FIX: 与订单列表一致补充 voucherId（PAID 订单取该订单一张券，未使用优先），供小程序"查看券码"跳转
    let voucherId: string | null = null;
    if (order.status === OrderStatus.PAID) {
      const v = await this.vouchers.createQueryBuilder('voucher')
        .select(['voucher.id'])
        .where('voucher.orderId = :orderId', { orderId: order.id })
        .orderBy("CASE WHEN voucher.status = 'UNUSED' THEN 0 ELSE 1 END", 'ASC')
        .addOrderBy('voucher.createdAt', 'DESC')
        .getOne();
      voucherId = v?.id || null;
    }
    return {
      id: order.id,
      orderNo: order.orderNo,
      packageTitle: order.packageTitleSnapshot,
      quantity: order.quantity,
      totalFen: order.amountFen,
      status: this.publicOrderStatusFromInternal(order.status, used),
      createdAt: order.createdAt,
      packageId: order.packageId,
      paymentExpiresAt: order.paymentExpiresAt,
      voucherId,
    };
  }

  /** 桌面版模板：POST /public/orders/:orderId/confirm-payment 请求后端异步补偿（校验归属），快速返回订单最新状态。 */
  async confirmPayment(orderId: string, customer: CustomerIdentity): Promise<Record<string, unknown> | null> {
    await this.paymentProcessing.requestOrderPaymentReconciliation(orderId, customer.id);
    return this.customerOrderById(orderId, customer);
  }

  /** 桌面版模板：POST /public/orders/:id/cancel 取消待支付订单 */
  async cancelOrder(orderId: string, customer: CustomerIdentity, merchantId?: string): Promise<{ cancelled: boolean }> {    await this.dataSource.transaction(async (manager) => {
      const order = await manager.findOne(Order, { where: { id: orderId, customerId: customer.id, ...(merchantId ? { merchantId } : {}) }, lock: { mode: 'pessimistic_write' } });
      if (!order) throw new NotFoundException('订单不存在');
      if (order.status === OrderStatus.CLOSED) return;
      if (order.status !== OrderStatus.PENDING_PAYMENT) throw new BadRequestException('订单当前不可取消');
      // H4：已派发渠道支付单（DISPATCHED）的订单禁止直接取消——渠道单已成孤儿，顾客可能晚付款导致资金滞留；
      // 先由支付查单/关单流程处理，避免 NEEDS_RECONCILIATION
      const dispatched = await manager.findOne(PaymentOutbox, { where: { orderId: order.id, status: PaymentOutboxStatus.DISPATCHED } });
      if (dispatched) {
        throw new ConflictException('该订单已发起支付，暂不能取消；如未完成支付请稍后重试（支付结果确认中）');
      }
      order.status = OrderStatus.CLOSED;
      await manager.save(Order, order);
      await manager.update(PaymentOutbox, { orderId: order.id, status: In([PaymentOutboxStatus.PENDING, PaymentOutboxStatus.PROCESSING, PaymentOutboxStatus.RETRY, PaymentOutboxStatus.DISPATCHED]) }, { status: PaymentOutboxStatus.CANCELLED, lastError: '订单已取消' });
      await manager.decrement(DealPackage, { id: order.packageId }, 'soldCount', order.quantity);
      await this.auditWriter.write(`customer:${customer.id}`, order.merchantId, 'ORDER_CANCELLED', 'Order', order.id, { status: OrderStatus.PENDING_PAYMENT }, { status: OrderStatus.CLOSED }, manager);
    });
    return { cancelled: true };
  }

  private async orderHasUsedVoucher(orderId: string): Promise<boolean> {
    const used = await this.vouchers.findOneBy({ orderId, status: VoucherStatus.USED });
    return Boolean(used);
  }

  /** 内部状态 → 桌面版状态（USED 需结合券是否核销） */
  private publicOrderStatusFromInternal(status: OrderStatus, used: boolean): string {
    switch (status) {
      case OrderStatus.PENDING_PAYMENT: return 'PENDING_PAY';
      case OrderStatus.PAID: return used ? 'USED' : 'PAID';
      case OrderStatus.CLOSED: return 'CANCELLED';
      case OrderStatus.REFUNDED: return 'REFUNDED';
      default: return status;
    }
  }

  private publicOrderStatusToInternal(status: string): OrderStatus | null {
    switch (status) {
      case 'PENDING_PAY': return OrderStatus.PENDING_PAYMENT;
      case 'PAID': case 'USED': return OrderStatus.PAID;
      case 'CANCELLED': return OrderStatus.CLOSED;
      case 'REFUNDED': return OrderStatus.REFUNDED;
      default: return null;
    }
  }

  async customerVoucherPage(customer: CustomerIdentity, input: { limit?: string; cursor?: string; merchantId?: string }): Promise<CustomerVoucherPage> {
    const rawLimit = input.limit === undefined ? '30' : input.limit;
    if (!/^\d+$/.test(rawLimit)) throw new BadRequestException('券包每页条数格式不正确');
    const limit = this.requiredInteger(Number(rawLimit), '券包每页条数', 1, 50);
    const cursor = this.parseCustomerVoucherPageCursor(input.cursor);
    const query = this.vouchers.createQueryBuilder('voucher')
      .where('voucher.customerId = :customerId' + (input.merchantId ? ' AND voucher.merchantId = :merchantId' : ''), { customerId: customer.id, ...(input.merchantId ? { merchantId: input.merchantId } : {}) })
      .orderBy('voucher.createdAt', 'DESC')
      .addOrderBy('voucher.id', 'DESC')
      .take(limit + 1);
    if (cursor) query.andWhere('(voucher.createdAt < :createdAt OR (voucher.createdAt = :createdAt AND voucher.id < :id))', cursor);
    const vouchers = await query.getMany();
    const hasMore = vouchers.length > limit;
    const page = hasMore ? vouchers.slice(0, limit) : vouchers;
    return { items: await this.customerVoucherListItems(page), nextCursor: hasMore && page.length ? this.customerVoucherPageCursor(page[page.length - 1]) : null };
  }

  async dynamicCode(voucherId: string, customer: CustomerIdentity): Promise<{ token: string; expiresAt: string }> {
    return this.verificationService.dynamicCode(voucherId, customer);
  }

  private async customerVoucherListItems(vouchers: Voucher[]): Promise<CustomerVoucherListItem[]> {
    if (!vouchers.length) return [];
    const [merchants, stores, orders, refunds] = await Promise.all([
      this.merchants.findBy({ id: In([...new Set(vouchers.map((voucher) => voucher.merchantId))]) }),
      this.stores.findBy({ id: In([...new Set(vouchers.map((voucher) => voucher.storeId))]) }),
      this.orders.findBy({ id: In([...new Set(vouchers.map((voucher) => voucher.orderId))]) }),
      this.refunds.findBy({ voucherId: In(vouchers.map((voucher) => voucher.id)) }),
    ]);
    const merchantsById = new Map(merchants.map((merchant) => [merchant.id, merchant]));
    const storesById = new Map(stores.map((store) => [store.id, store]));
    const ordersById = new Map(orders.map((order) => [order.id, order]));
    const refundsByVoucherId = new Map(refunds.map((refund) => [refund.voucherId, refund]));
    return vouchers.map((voucher) => ({
      id: voucher.id, code: voucher.code, orderId: voucher.orderId, merchantId: voucher.merchantId, merchantName: merchantsById.get(voucher.merchantId)?.brandName || '商家',
      packageId: voucher.packageId, packageTitle: ordersById.get(voucher.orderId)?.packageTitleSnapshot || '到店团购券',
      storeId: voucher.storeId, storeName: storesById.get(voucher.storeId)?.name || '指定门店', storeAddress: storesById.get(voucher.storeId)?.address || '',
      faceValueFen: voucher.faceValueFen, status: this.effectiveVoucherStatus(voucher), validFrom: voucher.validFrom, validTo: voucher.validTo,
      createdAt: voucher.createdAt, refundStatus: refundsByVoucherId.get(voucher.id)?.status || null,
    }));
  }

  private customerVoucherPageCursor(voucher: Voucher): string {
    return Buffer.from(JSON.stringify({ createdAt: voucher.createdAt.toISOString(), id: voucher.id }), 'utf8').toString('base64url');
  }

  private parseCustomerVoucherPageCursor(cursor?: string): { createdAt: Date; id: string } | null {
    if (!cursor) return null;
    if (!/^[A-Za-z0-9_-]{1,256}$/.test(cursor)) throw new BadRequestException('券包分页标记格式不正确');
    try {
      const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { createdAt?: unknown; id?: unknown };
      const createdAt = typeof parsed.createdAt === 'string' ? new Date(parsed.createdAt) : null;
      if (!createdAt || Number.isNaN(createdAt.getTime()) || typeof parsed.id !== 'string' || !/^[0-9a-f-]{36}$/i.test(parsed.id)) throw new Error('invalid cursor');
      return { createdAt, id: parsed.id };
    } catch {
      throw new BadRequestException('券包分页标记格式不正确');
    }
  }

  private async activeRate(merchantId: string, at = new Date()): Promise<CommissionRateVersion> {
    const rate = await this.rates.createQueryBuilder('r').where('r.merchantId = :merchantId AND r.effectiveFrom <= :at', { merchantId, at }).orderBy('r.effectiveFrom', 'DESC').getOne();
    if (!rate) throw new BadRequestException('商家未配置有效服务费率');
    return rate;
  }

  private ensureSameOrderIntent(order: Order, merchantId: string, input: { packageId: string; storeId: string; quantity: number }): void {
    if (order.merchantId !== merchantId || order.packageId !== input.packageId || order.storeId !== input.storeId || order.quantity !== input.quantity) throw new ConflictException('下单请求标识已用于其他订单，请刷新后重试');
  }

  private effectiveVoucherStatus(voucher: Voucher): VoucherStatus {
    return voucher.status === VoucherStatus.UNUSED && this.day(voucher.validTo) < this.day() ? VoucherStatus.EXPIRED : voucher.status;
  }

  private isMerchantSaleActive(merchant: Merchant): boolean {
    // Contract and SaaS cooperation are handled outside the platform. Their
    // dates must never silently hide an operating merchant from customers.
    // Sales can change only through the explicit, audited merchant status.
    return merchant.status === MerchantStatus.ACTIVE;
  }

  private day(date: Date | string = new Date()): string {
    const values = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(date)).filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
    return `${values.year}-${values.month}-${values.day}`;
  }

  private businessDayStart(day: string): Date { return new Date(`${day}T00:00:00+08:00`); }

  private addBusinessDays(day: string, days: number): string {
    const date = this.businessDayStart(day);
    date.setUTCDate(date.getUTCDate() + Math.max(1, Math.trunc(days)));
    return this.day(date);
  }

  /** 北京时间分钟窗口（yyyyMMddHHmm）：幂等键防"同一次操作重复提交"，跨分钟允许重新下单 */
  private minuteWindow(date: Date = new Date()): string {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(date).filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
    return `${parts.year}${parts.month}${parts.day}${parts.hour}${parts.minute}`;
  }

  private nextOrderNo(): string { return `DG${this.day().replace(/-/g, '')}${randomBytes(8).toString('hex').toUpperCase()}`; }

  /** H2：按请求内容确定性派生下单幂等键（顾客+套餐+门店+数量+分钟窗口），网络重试同内容同键；跨分钟可重新下单 */
  private deriveOrderIdempotencyKey(customerId: string, packageId: string, storeId: string, quantity: number): string {
    const window = this.minuteWindow();
    const raw = `${customerId}|${packageId}|${storeId}|${quantity}|${window}`;
    return `order_${createHash('sha256').update(raw).digest('hex').slice(0, 24)}`;
  }

  private isUniqueConstraintError(error: unknown): boolean { return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === '23505'; }
  private requiredInteger(value: unknown, label: string, min: number, max: number): number {
    const number = Number(value);
    if (!Number.isInteger(number) || number < min || number > max) throw new BadRequestException(`${label}必须为 ${min} 至 ${max} 的整数`);
    return number;
  }
}
