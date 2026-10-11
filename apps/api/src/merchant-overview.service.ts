import { ForbiddenException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import {
  DealPackage, Merchant, MerchantStatus, MerchantTemplateConfig, Order, OrderStatus, PackageStatus,
  PlatformAccessProfile, SettlementLedgerEntry, Store, User, UserRole, Verification, Voucher,
} from './domain/entities';
import {
  WechatOnboardingBusinessStatus, WechatOnboardingStep, WechatOnboardingStepKey,
} from './domain/wechat-platform.entities';
import { MerchantAccessService } from './merchant-access.service';
import { MerchantQueryScopeService } from './merchant-query-scope.service';

type MerchantReadinessState = 'READY' | 'WARNING' | 'BLOCKED';
type MerchantReadinessItem = {
  key: 'sales' | 'stores' | 'packages' | 'staff' | 'contact' | 'navigation' | 'template' | 'registration';
  title: string;
  state: MerchantReadinessState;
  detail: string;
  action?: 'merchants' | 'profile' | 'stores' | 'packages' | 'staff' | 'template' | 'registration';
};
type MerchantReadiness = {
  merchantId: string;
  brandName: string;
  readyCount: number;
  totalCount: number;
  blockedCount: number;
  checks: MerchantReadinessItem[];
};

@Injectable()
export class MerchantOverviewService {
  constructor(
    private readonly merchantAccess: MerchantAccessService,
    private readonly merchantScope: MerchantQueryScopeService,
    @InjectRepository(Merchant) private readonly merchants: Repository<Merchant>,
    @InjectRepository(MerchantTemplateConfig) private readonly templateConfigs: Repository<MerchantTemplateConfig>,
    @InjectRepository(Store) private readonly stores: Repository<Store>,
    @InjectRepository(DealPackage) private readonly packages: Repository<DealPackage>,
    @InjectRepository(User) private readonly users: Repository<User>,
    @InjectRepository(Order) private readonly orders: Repository<Order>,
    @InjectRepository(Voucher) private readonly vouchers: Repository<Voucher>,
    @InjectRepository(Verification) private readonly verifications: Repository<Verification>,
    @InjectRepository(SettlementLedgerEntry) private readonly ledger: Repository<SettlementLedgerEntry>,
    @InjectRepository(WechatOnboardingStep) private readonly onboardingSteps: Repository<WechatOnboardingStep>,
  ) {}

  async dashboard(user: User, merchantId?: string) {
    if (user.role === UserRole.PLATFORM_ADMIN) this.merchantAccess.requirePlatformAccess(user, '查看经营看板', [PlatformAccessProfile.OPERATIONS, PlatformAccessProfile.FINANCE, PlatformAccessProfile.COMPLIANCE]);
    if (user.role === UserRole.STORE_STAFF) {
      if (merchantId && merchantId !== user.merchantId) throw new ForbiddenException('无权访问该商家数据');
      const storeIds = user.storeIds || [];
      if (!user.merchantId || !storeIds.length) return { scopeMerchantId: user.merchantId || null, stores: 0, verifications: 0 };
      const verifications = await this.verifications.countBy({ merchantId: user.merchantId, storeId: In(storeIds), staffId: user.id });
      return { scopeMerchantId: user.merchantId, stores: storeIds.length, verifications };
    }
    const scope = await this.merchantScope.resolve(user, merchantId, [PlatformAccessProfile.OPERATIONS, PlatformAccessProfile.FINANCE, PlatformAccessProfile.COMPLIANCE]);
    if (scope.kind === 'none') return { scopeMerchantId: merchantId || null, merchants: 0, orders: 0, vouchers: 0, verifiedAmountFen: 0, serviceFeeFen: 0 };
    const [merchants, orders, vouchers, ledger] = await Promise.all([
      this.merchantScope.applyMerchant(scope, this.merchants.createQueryBuilder('merchant'), 'merchant').getCount(),
      // A3：订单数与商户端报表同口径（仅计已支付/已退款，排除从未支付的 CLOSED/PENDING_PAYMENT），避免 CLOSED 测试单虚增平台汇总
      this.merchantScope.apply(scope, this.orders.createQueryBuilder('order'), 'order').where('order.status IN (:...paidStates)', { paidStates: [OrderStatus.PAID, OrderStatus.REFUNDED] }).getCount(),
      this.merchantScope.apply(scope, this.vouchers.createQueryBuilder('voucher'), 'voucher').getCount(),
      this.merchantScope.apply(scope, this.ledger.createQueryBuilder('entry').select('COALESCE(SUM(entry.verifiedAmountFen), 0)', 'amount').addSelect('COALESCE(SUM(entry.serviceFeeFen), 0)', 'fee'), 'entry').getRawOne<{ amount: string; fee: string }>(),
    ]);
    return { scopeMerchantId: merchantId || null, merchants, orders, vouchers, verifiedAmountFen: Number(ledger?.amount || 0), serviceFeeFen: Number(ledger?.fee || 0) };
  }

  async readiness(user: User, merchantId: string): Promise<MerchantReadiness> {
    const merchant = await this.merchantAccess.getForUser(user, merchantId, [PlatformAccessProfile.OPERATIONS, PlatformAccessProfile.COMPLIANCE]);
    if (user.role === UserRole.STORE_STAFF) throw new ForbiddenException('核销员不可查看商家运营检查');
    const [templateConfig, stores, packages, staff, publishableStep] = await Promise.all([
      this.templateConfigs.findOneBy({ merchantId }),
      this.stores.findBy({ merchantId }), this.packages.findBy({ merchantId }),
      this.users.findBy({ merchantId, role: UserRole.STORE_STAFF, active: true }),
      this.onboardingSteps.findOneBy({ merchantId, key: WechatOnboardingStepKey.PUBLISHABLE }),
    ]);
    const saleStores = stores.filter((store) => store.openForSale);
    const saleStoreIds = new Set(saleStores.map((store) => store.id));
    const onSalePackages = packages.filter((deal) => deal.status === PackageStatus.ON_SALE);
    const activeStaff = staff.filter((member) => (member.storeIds || []).some((storeId) => saleStoreIds.has(storeId)));
    const featuredPackage = templateConfig?.featuredPackageId ? onSalePackages.find((deal) => deal.id === templateConfig.featuredPackageId) : undefined;
    const salesActive = merchant.status === MerchantStatus.ACTIVE;
    const salesDetail = merchant.status === MerchantStatus.SALES_SUSPENDED
      ? '当前已暂停新售；已购有效券仍可继续履约。'
      : merchant.status === MerchantStatus.EXITING
        ? '商家正在离场收尾；已停止新售，仍需完成既有券、退款、售后和结算。'
        : merchant.status === MerchantStatus.CLOSED
          ? '商家已退出经营，只保留历史券履约。'
          : '商家允许接受新订单。';
    const checks: MerchantReadinessItem[] = [
      { key: 'sales', title: '新订单状态', state: salesActive ? 'READY' : 'BLOCKED', detail: salesDetail, ...(user.role === UserRole.PLATFORM_ADMIN ? { action: 'merchants' as const } : {}) },
      { key: 'stores', title: '可售门店', state: saleStores.length ? 'READY' : 'BLOCKED', detail: saleStores.length ? `已有 ${saleStores.length} 家门店接受新订单。` : '至少启用一家门店后，顾客才能绑定核销地点。', action: 'stores' },
      { key: 'packages', title: '在售套餐', state: onSalePackages.length ? 'READY' : 'BLOCKED', detail: onSalePackages.length ? `已有 ${onSalePackages.length} 个套餐在售。` : '还没有在售套餐，顾客端不会展示可购买内容。', action: 'packages' },
      { key: 'staff', title: '核销员授权', state: activeStaff.length ? 'READY' : 'WARNING', detail: activeStaff.length ? `${activeStaff.length} 名核销员已关联可售门店。` : '尚未有核销员关联可售门店，建议在首笔到店前完成授权。', action: 'staff' },
      { key: 'contact', title: '顾客服务电话', state: merchant.servicePhone.trim() ? 'READY' : 'WARNING', detail: merchant.servicePhone.trim() ? '顾客端可直接拨打商家服务电话。' : '顾客端暂时没有商家服务电话，售后只能提交平台工单。', action: 'profile' },
      { key: 'navigation', title: '门店地图导航', state: !saleStores.length || saleStores.every((store) => store.latitude !== null && store.longitude !== null) ? 'READY' : 'WARNING', detail: !saleStores.length ? '待门店启用后再配置地图位置。' : saleStores.every((store) => store.latitude !== null && store.longitude !== null) ? '所有可售门店均可在顾客端打开地图导航。' : '部分可售门店未配置准确坐标，顾客端将提示无法导航。', action: 'stores' },
      { key: 'template', title: '主推套餐', state: featuredPackage ? 'READY' : 'WARNING', detail: featuredPackage ? `顾客首页主推“${featuredPackage.title}”。` : '未设置在售主推套餐，顾客端仍会展示套餐列表。', action: 'template' },
      { key: 'registration', title: '主体与授权进度', state: publishableStep?.status === WechatOnboardingBusinessStatus.COMPLETE ? 'READY' : 'WARNING', detail: publishableStep?.status === WechatOnboardingBusinessStatus.COMPLETE ? '小程序已具备发布条件（代码审核通过）。' : '开户与授权进度由微信真实状态自动同步，完成备案审核后即可发布。', action: 'registration' },
    ];
    return { merchantId: merchant.id, brandName: merchant.brandName, readyCount: checks.filter((check) => check.state === 'READY').length, totalCount: checks.length, blockedCount: checks.filter((check) => check.state === 'BLOCKED').length, checks };
  }
}
