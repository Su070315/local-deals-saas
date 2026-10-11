import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, In, Raw, Repository } from 'typeorm';
import { AuditLog, DealPackage, Merchant, Order, OrderStatus, PackageStatus, PackageStore, PlatformAccessProfile, Store, User, UserRole } from './domain/entities';
import { AuditWriterService } from './audit-writer.service';
import { MerchantAccessService } from './merchant-access.service';
import { normalizePackageMerchandising, packageMerchandisingFromSnapshot } from './package-merchandising';
import type { PackageMerchandisingFields } from './package-merchandising';
import type { CustomerIdentity } from './app-service.core-types';

export type SavePackageInput = {
  id?: string; expectedVersion?: number; title: string; description?: string;
} & Partial<PackageMerchandisingFields> & {
  priceFen: number; saleLimit?: number; perCustomerLimit?: number; storeIds: string[];
  validFrom: string; validTo: string; validityMode?: 'ABSOLUTE' | 'PURCHASE_RELATIVE'; validityDurationDays?: number | null; status?: PackageStatus;
};

export type PackageConfigSnapshot = PackageMerchandisingFields & {
  version: number; title: string; description: string; priceFen: number; saleLimit: number; perCustomerLimit: number;
  storeIds: string[]; validFrom: string; validTo: string; validityMode: 'ABSOLUTE' | 'PURCHASE_RELATIVE'; validityDurationDays: number | null; status: PackageStatus;
};
export type PackageVersion = PackageConfigSnapshot & { auditId: string; action: string; createdAt: Date };
export type CustomerPurchaseAvailability = {
  remainingStock: number | null; perCustomerRemaining: number | null; maxQuantity: number; storeIds: string[];
  reason: 'PACKAGE_UNAVAILABLE' | 'NO_AVAILABLE_STORE' | 'SOLD_OUT' | 'PERSONAL_LIMIT_REACHED' | null;
};

@Injectable()
export class PackageService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly merchantAccess: MerchantAccessService,
    private readonly auditWriter: AuditWriterService,
    @InjectRepository(Merchant) private readonly merchants: Repository<Merchant>,
    @InjectRepository(Store) private readonly stores: Repository<Store>,
    @InjectRepository(DealPackage) private readonly packages: Repository<DealPackage>,
    @InjectRepository(PackageStore) private readonly packageStores: Repository<PackageStore>,
    @InjectRepository(Order) private readonly orders: Repository<Order>,
    @InjectRepository(AuditLog) private readonly audits: Repository<AuditLog>,
  ) {}

  async listPackages(user: User, merchantId: string): Promise<DealPackage[]> {
    await this.merchantAccess.getForUser(user, merchantId, [PlatformAccessProfile.OPERATIONS]);
    if (user.role === UserRole.STORE_STAFF) throw new ForbiddenException('核销员不可查看套餐配置');
    const deals = await this.packages.find({ where: { merchantId }, order: { updatedAt: 'DESC' } });
    await this.hydrateStoreIds(deals, merchantId);
    return deals.map((deal) => this.normalizeVersion(deal));
  }

  async savePackage(user: User, merchantId: string, input: SavePackageInput): Promise<DealPackage> {
    await this.merchantAccess.getForUser(user, merchantId, [PlatformAccessProfile.OPERATIONS]);
    if (user.role === UserRole.STORE_STAFF) throw new ForbiddenException('核销员不可管理套餐');
    const title = this.requiredText(input.title, '套餐名称', 100);
    const description = this.optionalText(input.description, '套餐说明', 3000);
    const priceFen = this.requiredInteger(input.priceFen, '套餐价格', 1, 100_000_000);
    const merchandising = normalizePackageMerchandising(input, priceFen);
    const saleLimit = this.requiredInteger(input.saleLimit ?? 0, '总销量', 0, 10_000_000);
    const perCustomerLimit = this.requiredInteger(input.perCustomerLimit ?? 0, '每人限购', 0, 10_000);
    const validityMode = input.validityMode || 'ABSOLUTE';
    if (!['ABSOLUTE', 'PURCHASE_RELATIVE'].includes(validityMode)) throw new BadRequestException('有效期模式不正确');
    const validityDurationDays = input.validityDurationDays == null ? null : this.requiredInteger(input.validityDurationDays, '有效期时长', 1, 3650);
    if (validityMode === 'PURCHASE_RELATIVE' && validityDurationDays == null) throw new BadRequestException('购买日起算必须配置有效期时长');
    const validFrom = this.requiredDate(input.validFrom, '生效日期');
    const validTo = this.requiredDate(input.validTo, '失效日期');
    // validFrom/validTo 始终是销售窗口；券的有效期模式另行决定券的使用期限。
    if (validTo < validFrom) throw new BadRequestException('套餐销售窗口不正确');
    if (!Array.isArray(input.storeIds) || !input.storeIds.length) throw new BadRequestException('请至少选择一个适用门店');
    const status = input.status ?? PackageStatus.DRAFT;
    if (!Object.values(PackageStatus).includes(status)) throw new BadRequestException('套餐状态不正确');
    if (input.id) return this.dataSource.transaction(async (manager) => {
      const entity = await manager.findOne(DealPackage, { where: { id: input.id, merchantId }, lock: { mode: 'pessimistic_write' } });
      if (!entity) throw new NotFoundException('套餐不存在');
      this.normalizeVersion(entity); this.requireVersion(input.expectedVersion, entity.version);
      if (saleLimit > 0 && saleLimit < entity.soldCount) throw new BadRequestException('总销量上限不能低于已售或已占用数量');
      await this.assertStores(manager, input.storeIds, merchantId);
      const before = this.snapshot(entity);
      Object.assign(entity, { title, description, ...merchandising, priceFen, saleLimit, perCustomerLimit, storeIds: input.storeIds, validFrom, validTo, validityMode, validityDurationDays, status, version: entity.version + 1 });
      const saved = this.normalizeVersion(await manager.save(DealPackage, entity));
      await this.replacePackageStores(manager, saved.id, merchantId, input.storeIds);
      await this.auditWriter.write(user.id, merchantId, 'PACKAGE_UPDATED', 'Package', saved.id, before, this.snapshot(saved), manager);
      return saved;
    });
    return this.dataSource.transaction(async (manager) => {
      await this.assertStores(manager, input.storeIds, merchantId);
      const entity = manager.create(DealPackage, { merchantId, title, description, ...merchandising, priceFen, saleLimit, soldCount: 0, perCustomerLimit, storeIds: input.storeIds, validFrom, validTo, validityMode, validityDurationDays, status, version: 1 });
      const saved = this.normalizeVersion(await manager.save(DealPackage, entity));
      await this.replacePackageStores(manager, saved.id, merchantId, input.storeIds);
      await this.auditWriter.write(user.id, merchantId, 'PACKAGE_CREATED', 'Package', saved.id, null, this.snapshot(saved), manager);
      return saved;
    });
  }

  async setPackageStatus(user: User, merchantId: string, packageId: string, status: PackageStatus, expectedVersion: number): Promise<DealPackage> {
    await this.merchantAccess.getForUser(user, merchantId, [PlatformAccessProfile.OPERATIONS]);
    if (user.role === UserRole.STORE_STAFF) throw new ForbiddenException('核销员不可操作套餐');
    if (!Object.values(PackageStatus).includes(status)) throw new BadRequestException('套餐状态不正确');
    return this.dataSource.transaction(async (manager) => {
      const entity = await manager.findOne(DealPackage, { where: { id: packageId, merchantId }, lock: { mode: 'pessimistic_write' } });
      if (!entity) throw new NotFoundException('套餐不存在');
      this.normalizeVersion(entity); this.requireVersion(expectedVersion, entity.version);
      if (entity.status === status) return entity;
      const before = this.snapshot(entity); entity.status = status; entity.version += 1;
      const saved = this.normalizeVersion(await manager.save(DealPackage, entity));
      await this.auditWriter.write(user.id, merchantId, 'PACKAGE_STATUS_CHANGED', 'Package', packageId, before, this.snapshot(saved), manager);
      return saved;
    });
  }

  /** 商家编辑"已售数量"（真实销量 soldCount，与订单驱动的增量/退款递减并列的人工校正通道）。
   *  仅商家账号（OPERATIONS 且非核销员）；非负整数 + saleLimit 联动校验；乐观锁 + 审计。 */
  async updateSoldCount(user: User, merchantId: string, packageId: string, soldCount: number, expectedVersion: number): Promise<DealPackage> {
    await this.merchantAccess.getForUser(user, merchantId, [PlatformAccessProfile.OPERATIONS]);
    if (user.role === UserRole.STORE_STAFF) throw new ForbiddenException('核销员不可修改已售数量');
    const value = this.requiredInteger(soldCount, '已售数量', 0, 10_000_000);
    return this.dataSource.transaction(async (manager) => {
      const entity = await manager.findOne(DealPackage, { where: { id: packageId, merchantId }, lock: { mode: 'pessimistic_write' } });
      if (!entity) throw new NotFoundException('套餐不存在');
      this.normalizeVersion(entity); this.requireVersion(expectedVersion, entity.version);
      if (entity.saleLimit > 0 && value > entity.saleLimit) throw new BadRequestException(`已售数量不能超过总销量上限 ${entity.saleLimit}`);
      if (entity.soldCount === value) return entity;
      const beforeSoldCount = entity.soldCount;
      const before = this.snapshot(entity); entity.soldCount = value; entity.version += 1;
      const saved = this.normalizeVersion(await manager.save(DealPackage, entity));
      // 审计记录附加 soldCount 前后值（snapshot 不含该字段，单独携带以满足"修改前后数值可追溯"）
      await this.auditWriter.write(user.id, merchantId, 'PACKAGE_SOLD_COUNT_UPDATED', 'Package', packageId, { ...before, soldCount: beforeSoldCount }, { ...this.snapshot(saved), soldCount: saved.soldCount }, manager);
      return saved;
    });
  }

  async listPackageVersions(user: User, merchantId: string, packageId: string): Promise<PackageVersion[]> {
    await this.merchantAccess.getForUser(user, merchantId, [PlatformAccessProfile.OPERATIONS]);
    if (user.role === UserRole.STORE_STAFF) throw new ForbiddenException('核销员不可查看套餐版本');
    await this.packages.findOneByOrFail({ id: packageId, merchantId });
    const records = await this.audits.find({ where: { merchantId, resourceType: 'Package', resourceId: packageId }, order: { createdAt: 'DESC' }, take: 100 });
    return records.flatMap((record) => { const snapshot = this.snapshotFromAudit(record.after); return snapshot ? [{ ...snapshot, auditId: record.id, action: record.action, createdAt: record.createdAt }] : []; });
  }

  async restorePackageVersion(user: User, merchantId: string, packageId: string, auditId: string, expectedVersion: number): Promise<DealPackage> {
    await this.merchantAccess.getForUser(user, merchantId, [PlatformAccessProfile.OPERATIONS]);
    if (user.role === UserRole.STORE_STAFF) throw new ForbiddenException('核销员不可恢复套餐版本');
    return this.dataSource.transaction(async (manager) => {
      const entity = await manager.findOne(DealPackage, { where: { id: packageId, merchantId }, lock: { mode: 'pessimistic_write' } });
      if (!entity) throw new NotFoundException('套餐不存在');
      this.normalizeVersion(entity); this.requireVersion(expectedVersion, entity.version);
      const source = await manager.findOneBy(AuditLog, { id: auditId, merchantId, resourceType: 'Package', resourceId: packageId });
      if (!source) throw new NotFoundException('套餐历史版本不存在');
      const snapshot = this.snapshotFromAudit(source.after);
      if (!snapshot) throw new BadRequestException('该历史记录无法用于恢复');
      await this.assertStores(manager, snapshot.storeIds, merchantId);
      const before = this.snapshot(entity);
      Object.assign(entity, { title: snapshot.title, description: snapshot.description, ...packageMerchandisingFromSnapshot(snapshot), priceFen: snapshot.priceFen, saleLimit: snapshot.saleLimit, perCustomerLimit: snapshot.perCustomerLimit, storeIds: snapshot.storeIds, validFrom: this.requiredBusinessDate(snapshot.validFrom, '历史套餐生效日期'), validTo: this.requiredBusinessDate(snapshot.validTo, '历史套餐失效日期'), validityMode: snapshot.validityMode, validityDurationDays: snapshot.validityDurationDays, status: snapshot.status, version: entity.version + 1 });
      const saved = this.normalizeVersion(await manager.save(DealPackage, entity));
      await this.replacePackageStores(manager, saved.id, merchantId, snapshot.storeIds);
      await this.auditWriter.write(user.id, merchantId, 'PACKAGE_VERSION_RESTORED', 'Package', packageId, before, this.snapshot(saved), manager);
      return saved;
    });
  }

  async publicPackages(merchantId: string): Promise<Array<Pick<DealPackage, 'id' | 'title' | 'description' | 'priceFen' | 'productType' | 'skuCode' | 'barcode' | 'recommendation' | 'coverImageUrl' | 'galleryUrls' | 'videoUrl' | 'originalPriceFen' | 'memberPriceFen' | 'purchasePriceFen' | 'categoryName' | 'categoryIds' | 'unit' | 'minPurchaseQuantity' | 'virtualSales' | 'tags' | 'fulfillmentMethods' | 'distributionEnabled' | 'batchManaged' | 'pointsEnabled' | 'inventoryEnabled' | 'inventoryWarningThreshold' | 'salesChannels' | 'guaranteeLabels' | 'parameterValues' | 'purchaseNotes' | 'usageRules' | 'detailContent' | 'saleLimit' | 'soldCount' | 'perCustomerLimit' | 'storeIds' | 'validFrom' | 'validTo' | 'validityMode' | 'validityDurationDays' | 'status' | 'version'>>> {
    const merchant = await this.merchants.findOneBy({ id: merchantId });
    if (!merchant || !this.isMerchantSaleActive(merchant)) throw new NotFoundException('店铺暂不可访问');
    // 用日期字符串与 date 列比较，避免 Date 时区导致"当天商品被当成未来"（date 列读出为 UTC 零点，差 8 小时）
    const today = this.day();
    const packages = await this.packages.find({
      where: {
        merchantId,
        status: PackageStatus.ON_SALE,
        validFrom: Raw((alias) => `${alias} <= :today`, { today }),
        validTo: Raw((alias) => `${alias} >= :today`, { today }),
      },
      order: { createdAt: 'DESC' },
    });
    const storeIds = await this.storeIdMap(packages, merchantId);
    return packages.map((deal) => ({ id: deal.id, title: deal.title, description: deal.description, priceFen: deal.priceFen, ...packageMerchandisingFromSnapshot(deal), saleLimit: deal.saleLimit, soldCount: deal.soldCount, perCustomerLimit: deal.perCustomerLimit, storeIds: storeIds.get(deal.id) || deal.storeIds, validFrom: deal.validFrom, validTo: deal.validTo, validityMode: deal.validityMode || 'ABSOLUTE', validityDurationDays: deal.validityDurationDays ?? null, status: deal.status, version: this.requiredInteger(deal.version, '套餐版本号', 1, 2_147_483_647) }));
  }

  /** 桌面版模板：GET /public/packages 分页返回在售商品 */
  async publicPackagePage(merchantId: string, page: number, limit: number): Promise<{ items: Array<Record<string, unknown>> }> {
    const size = Math.max(1, Math.min(50, limit || 20));
    const current = Math.max(1, page || 1);
    const merchant = await this.merchants.findOneBy({ id: merchantId });
    if (!merchant || !this.isMerchantSaleActive(merchant)) throw new NotFoundException('店铺暂不可访问');
    const today = this.day();
    const [packages, total] = await Promise.all([
      this.packages.find({
        where: { merchantId, status: PackageStatus.ON_SALE, validFrom: Raw((alias) => `${alias} <= :today`, { today }), validTo: Raw((alias) => `${alias} >= :today`, { today }) },
        order: { createdAt: 'DESC' },
        skip: (current - 1) * size,
        take: size,
      }),
      this.packages.count({ where: { merchantId, status: PackageStatus.ON_SALE, validFrom: Raw((alias) => `${alias} <= :today`, { today }), validTo: Raw((alias) => `${alias} >= :today`, { today }) } }),
    ]);
    const storeIds = await this.storeIdMap(packages, merchantId);
    const items = packages.map((deal) => ({
      id: deal.id, title: deal.title, description: deal.description, priceFen: deal.priceFen,
      ...packageMerchandisingFromSnapshot(deal),
      // FIX(2026-08-10)：补返回商品图集/富文本详情/保障/参数/虚拟销量（小程序端多图轮播与详情分区渲染所需）
      coverImageUrl: deal.coverImageUrl, galleryUrls: deal.galleryUrls,
      detailContent: deal.detailContent, guaranteeLabels: deal.guaranteeLabels, parameterValues: deal.parameterValues,
      virtualSales: deal.virtualSales,
      saleLimit: deal.saleLimit, soldCount: deal.soldCount, perCustomerLimit: deal.perCustomerLimit,
      storeIds: storeIds.get(deal.id) || deal.storeIds, validFrom: deal.validFrom, validTo: deal.validTo,
      validityMode: deal.validityMode || 'ABSOLUTE', validityDurationDays: deal.validityDurationDays ?? null,
      status: deal.status, version: this.requiredInteger(deal.version, '套餐版本号', 1, 2_147_483_647),
    }));
    return { items };
  }

  /** 桌面版模板：GET /public/packages/:id 返回单个套餐详情 */
  async publicPackageDetail(merchantId: string, packageId: string): Promise<Record<string, unknown>> {
    const merchant = await this.merchants.findOneBy({ id: merchantId });
    if (!merchant || !this.isMerchantSaleActive(merchant)) throw new NotFoundException('店铺暂不可访问');
    const deal = await this.packages.findOneBy({ id: packageId, merchantId });
    if (!deal || deal.status !== PackageStatus.ON_SALE) throw new NotFoundException('套餐不存在或已下架');
    const storeIds = await this.storeIdsForRepository(deal, merchantId);
    return {
      id: deal.id, title: deal.title, description: deal.description, priceFen: deal.priceFen,
      ...packageMerchandisingFromSnapshot(deal),
      // FIX(2026-08-10)：补返回商品图集/富文本详情/保障/参数/虚拟销量（小程序端多图轮播与详情分区渲染所需）
      coverImageUrl: deal.coverImageUrl, galleryUrls: deal.galleryUrls,
      detailContent: deal.detailContent, guaranteeLabels: deal.guaranteeLabels, parameterValues: deal.parameterValues,
      virtualSales: deal.virtualSales,
      saleLimit: deal.saleLimit, soldCount: deal.soldCount, perCustomerLimit: deal.perCustomerLimit,
      storeIds, validFrom: deal.validFrom, validTo: deal.validTo,
      validityMode: deal.validityMode || 'ABSOLUTE', validityDurationDays: deal.validityDurationDays ?? null,
      status: deal.status, version: this.requiredInteger(deal.version, '套餐版本号', 1, 2_147_483_647),
    };
  }

  async customerPurchaseAvailability(merchantId: string, packageId: string, customer: CustomerIdentity): Promise<CustomerPurchaseAvailability> {
    const merchant = await this.merchants.findOneBy({ id: merchantId });
    if (!merchant || !this.isMerchantSaleActive(merchant)) throw new NotFoundException('店铺暂不可访问');
    const deal = await this.packages.findOneBy({ id: packageId, merchantId });
    if (!deal) throw new NotFoundException('套餐不存在');
    const configuredStoreIds = await this.storeIdsForRepository(deal, merchantId);
    const openStoreIds = new Set((await this.stores.findBy({ merchantId, openForSale: true })).map((store) => store.id));
    const availableStores = configuredStoreIds.filter((storeId) => openStoreIds.has(storeId));
    const saleActive = deal.status === PackageStatus.ON_SALE && this.day(deal.validFrom) <= this.day() && this.day(deal.validTo) >= this.day();
    const remainingStock = deal.saleLimit > 0 ? Math.max(0, deal.saleLimit - deal.soldCount) : null;
    const purchased = deal.perCustomerLimit > 0 ? await this.orders.createQueryBuilder('o').where('o.packageId = :packageId AND o.customerId = :customerId AND (o.status = :paidStatus OR (o.status = :pendingStatus AND o.paymentExpiresAt >= :now))', { packageId: deal.id, customerId: customer.id, paidStatus: OrderStatus.PAID, pendingStatus: OrderStatus.PENDING_PAYMENT, now: new Date() }).select('COALESCE(SUM(o.quantity), 0)', 'total').getRawOne<{ total: string }>() : null;
    const perCustomerRemaining = deal.perCustomerLimit > 0 ? Math.max(0, deal.perCustomerLimit - Number(purchased?.total || 0)) : null;
    let reason: CustomerPurchaseAvailability['reason'] = null;
    if (!saleActive) reason = 'PACKAGE_UNAVAILABLE'; else if (!availableStores.length) reason = 'NO_AVAILABLE_STORE'; else if (remainingStock === 0) reason = 'SOLD_OUT'; else if (perCustomerRemaining === 0) reason = 'PERSONAL_LIMIT_REACHED';
    const maxQuantity = reason ? 0 : Math.max(0, Math.min(20, remainingStock ?? 20, perCustomerRemaining ?? 20));
    return { remainingStock, perCustomerRemaining, maxQuantity, storeIds: availableStores, reason };
  }

  /** Returns relational mappings first and falls back to the legacy JSON field. */
  async storeIdsFor(manager: EntityManager, deal: Pick<DealPackage, 'id' | 'merchantId' | 'storeIds'>, merchantId = deal.merchantId): Promise<string[]> {
    const rows = await manager.find(PackageStore, { where: { packageId: deal.id, merchantId }, order: { createdAt: 'ASC', id: 'ASC' } });
    return rows.length ? rows.map((row) => row.storeId) : [...deal.storeIds];
  }

  async assertStoreApplies(manager: EntityManager, deal: Pick<DealPackage, 'id' | 'merchantId' | 'storeIds'>, storeId: string): Promise<void> {
    if (!(await this.storeIdsFor(manager, deal)).includes(storeId)) throw new BadRequestException('该门店不适用于此套餐');
  }

  private async assertStores(manager: EntityManager, storeIds: string[], merchantId: string): Promise<void> {
    const storeCount = await manager.countBy(Store, { id: In(storeIds), merchantId });
    if (storeCount !== storeIds.length) throw new BadRequestException('套餐适用门店不属于该商家');
  }

  private async replacePackageStores(manager: EntityManager, packageId: string, merchantId: string, storeIds: string[]): Promise<void> {
    await manager.delete(PackageStore, { packageId, merchantId });
    await manager.insert(PackageStore, storeIds.map((storeId) => ({ packageId, storeId, merchantId })));
  }

  private async storeIdsForRepository(deal: Pick<DealPackage, 'id' | 'merchantId' | 'storeIds'>, merchantId = deal.merchantId): Promise<string[]> {
    const rows = await this.packageStores.find({ where: { packageId: deal.id, merchantId }, order: { createdAt: 'ASC', id: 'ASC' } });
    return rows.length ? rows.map((row) => row.storeId) : [...deal.storeIds];
  }

  private async storeIdMap(deals: DealPackage[], merchantId: string): Promise<Map<string, string[]>> {
    const map = new Map<string, string[]>();
    if (!deals.length) return map;
    const rows = await this.packageStores.find({ where: { merchantId, packageId: In(deals.map((deal) => deal.id)) }, order: { createdAt: 'ASC', id: 'ASC' } });
    for (const row of rows) map.set(row.packageId, [...(map.get(row.packageId) || []), row.storeId]);
    return map;
  }

  private async hydrateStoreIds(deals: DealPackage[], merchantId: string): Promise<void> {
    const map = await this.storeIdMap(deals, merchantId);
    for (const deal of deals) {
      const storeIds = map.get(deal.id);
      if (storeIds?.length) deal.storeIds = storeIds;
    }
  }
  private snapshot(deal: DealPackage): PackageConfigSnapshot { return { version: this.requiredInteger(deal.version, '套餐版本号', 1, 2_147_483_647), title: deal.title, description: deal.description, priceFen: deal.priceFen, ...packageMerchandisingFromSnapshot(deal), saleLimit: deal.saleLimit, perCustomerLimit: deal.perCustomerLimit, storeIds: [...deal.storeIds], validFrom: this.day(deal.validFrom), validTo: this.day(deal.validTo), validityMode: deal.validityMode || 'ABSOLUTE', validityDurationDays: deal.validityDurationDays ?? null, status: deal.status }; }
  private requireVersion(expectedVersion: unknown, currentVersion: number): void { if (this.requiredInteger(expectedVersion, '套餐版本号', 1, 2_147_483_647) !== this.requiredInteger(currentVersion, '套餐当前版本号', 1, 2_147_483_647)) throw new ConflictException('套餐已被其他操作更新，请刷新后重试'); }
  private normalizeVersion(deal: DealPackage): DealPackage { deal.version = this.requiredInteger(deal.version, '套餐版本号', 1, 2_147_483_647); return deal; }
  private snapshotFromAudit(value: Record<string, unknown> | null): PackageConfigSnapshot | null {
    if (!value || typeof value !== 'object') return null;
    const snapshot = value as Partial<PackageConfigSnapshot>;
    const validityMode = snapshot.validityMode || 'ABSOLUTE';
    const validityDurationDays = snapshot.validityDurationDays == null ? null : Number(snapshot.validityDurationDays);
    const relativeDurationValid = validityDurationDays !== null && Number.isInteger(validityDurationDays) && validityDurationDays >= 1 && validityDurationDays <= 3650;
    if (!Number.isInteger(snapshot.version) || snapshot.version! < 1 || typeof snapshot.title !== 'string' || typeof snapshot.description !== 'string' || !Number.isInteger(snapshot.priceFen) || snapshot.priceFen! < 1 || !Number.isInteger(snapshot.saleLimit) || snapshot.saleLimit! < 0 || !Number.isInteger(snapshot.perCustomerLimit) || snapshot.perCustomerLimit! < 0 || !Array.isArray(snapshot.storeIds) || !snapshot.storeIds.length || !snapshot.storeIds.every((storeId) => typeof storeId === 'string') || typeof snapshot.validFrom !== 'string' || typeof snapshot.validTo !== 'string' || !['ABSOLUTE', 'PURCHASE_RELATIVE'].includes(validityMode) || (validityMode === 'PURCHASE_RELATIVE' && !relativeDurationValid) || !Object.values(PackageStatus).includes(snapshot.status as PackageStatus)) return null;
    try { const validFrom = this.requiredBusinessDate(snapshot.validFrom, '历史套餐生效日期'); const validTo = this.requiredBusinessDate(snapshot.validTo, '历史套餐失效日期'); if (validTo < validFrom) return null; return { version: snapshot.version!, title: snapshot.title, description: snapshot.description, priceFen: snapshot.priceFen!, ...packageMerchandisingFromSnapshot(snapshot), saleLimit: snapshot.saleLimit!, perCustomerLimit: snapshot.perCustomerLimit!, storeIds: [...snapshot.storeIds], validFrom: this.day(validFrom), validTo: this.day(validTo), validityMode, validityDurationDays, status: snapshot.status! }; } catch { return null; }
  }
  private requiredText(value: unknown, label: string, maxLength = 120): string { if (typeof value !== 'string') throw new BadRequestException(`${label}格式不正确`); const normalized = value.trim(); if (!normalized || normalized.length > maxLength) throw new BadRequestException(`${label}不能为空且不能超过 ${maxLength} 个字符`); return normalized; }
  private optionalText(value: unknown, label: string, maxLength = 500): string { return value === undefined || value === null || value === '' ? '' : this.requiredText(value, label, maxLength); }
  private requiredInteger(value: unknown, label: string, min: number, max: number): number { const number = Number(value); if (!Number.isInteger(number) || number < min || number > max) throw new BadRequestException(`${label}必须为 ${min} 至 ${max} 的整数`); return number; }
  private requiredDate(value: unknown, label: string): Date { const date = new Date(String(value)); if (Number.isNaN(date.getTime())) throw new BadRequestException(`${label}格式不正确`); return date; }
  private requiredBusinessDate(value: unknown, label: string): Date { if (typeof value !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])-([0-2]\d|3[01])$/.test(value)) throw new BadRequestException(`${label}格式为 YYYY-MM-DD`); const date = new Date(`${value}T00:00:00+08:00`); if (Number.isNaN(date.getTime()) || this.day(date) !== value) throw new BadRequestException(`${label}不是有效日期`); return date; }
  private day(date: Date | string = new Date()): string { const values = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(date)).filter((part) => part.type !== 'literal').map((part) => [part.type, part.value])); return `${values.year}-${values.month}-${values.day}`; }
  private businessDayStart(day = this.day()): Date { return new Date(`${day}T00:00:00+08:00`); }
  private isMerchantSaleActive(merchant: Merchant): boolean {
    // Contract and SaaS cooperation are handled outside the platform. A date
    // on that record cannot silently remove an active merchant's storefront.
    return merchant.status === 'ACTIVE';
  }
}
