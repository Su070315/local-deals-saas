import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import bcrypt from 'bcryptjs';
import {
  Agency, AgencyCooperationPlan, CommissionRateVersion, DealPackage, Merchant, MerchantRegistration, MerchantRegistrationStatus, MerchantStatus,
  PackageStatus, PackageStore, PlatformAccessProfile, Store, User, UserRole,
} from './domain/entities';
import { Repository } from 'typeorm';

@Injectable()
export class SeedService {
  constructor(
    @InjectRepository(Agency) private readonly agencies: Repository<Agency>,
    @InjectRepository(Merchant) private readonly merchants: Repository<Merchant>,
    @InjectRepository(MerchantRegistration) private readonly registrations: Repository<MerchantRegistration>,
    @InjectRepository(Store) private readonly stores: Repository<Store>,
    @InjectRepository(DealPackage) private readonly packages: Repository<DealPackage>,
    @InjectRepository(PackageStore) private readonly packageStores: Repository<PackageStore>,
    @InjectRepository(User) private readonly users: Repository<User>,
    @InjectRepository(CommissionRateVersion) private readonly rates: Repository<CommissionRateVersion>,
  ) {}

  async seed(): Promise<void> {
    if (await this.users.count()) return;
    const passwordHash = await bcrypt.hash('Demo123456', 10);
    const agency = await this.agencies.save({ name: '华南精选生活代理', active: true, cooperationPlan: AgencyCooperationPlan.ANNUAL_UNLIMITED, publicationQuotaRemaining: 0, cooperationStartsAt: new Date('2026-01-01'), cooperationEndsAt: new Date('2027-12-31'), cooperationReference: '演示年度合作' });
    const merchant = await this.merchants.save({
      agencyId: agency.id,
      legalName: '广州花时间生活服务有限公司',
      brandName: '花时间花艺',
      servicePhone: '020-8888-1234',
      contractNumber: 'DEMO-2026-001',
      contractEndsAt: new Date('2027-06-30'),
      primaryColor: '#d94875',
      status: MerchantStatus.ACTIVE,
    });
    const store = await this.stores.save({
      merchantId: merchant.id,
      name: '花时间花艺 - 珠江新城店',
      address: '广州市天河区花城大道 88 号',
      phone: '020-8888-1234',
      businessHours: '10:00-21:00',
      openForSale: true,
    });
    await this.rates.save({ merchantId: merchant.id, rate: '0.0800', effectiveFrom: new Date('2026-01-01'), note: '演示合同费率', createdBy: 'seed' });
    const seedPackages = await this.packages.save([
      {
        merchantId: merchant.id, title: '单支鲜花花束', description: '任选时令鲜花一束，到店凭券领取。',
        priceFen: 3990, originalPriceFen: 5900, tags: ['招牌', '到店自取'], purchaseNotes: '请在有效期内选择门店下单；花材以当日供应为准。', usageRules: '到店出示动态券码核销，每张券限用一次。', saleLimit: 200, soldCount: 0, perCustomerLimit: 3, storeIds: [store.id],
        validFrom: new Date('2026-01-01'), validTo: new Date('2026-12-31'), status: PackageStatus.ON_SALE,
      },
      {
        merchantId: merchant.id, title: '周末花艺体验课', description: '包含花材和工具，需提前电话预约。',
        priceFen: 12800, originalPriceFen: 16800, tags: ['周末', '预约'], purchaseNotes: '请至少提前一天联系门店预约课程时间。', usageRules: '凭动态码到店核销，迟到规则以门店通知为准。', saleLimit: 40, soldCount: 0, perCustomerLimit: 1, storeIds: [store.id],
        validFrom: new Date('2026-01-01'), validTo: new Date('2026-12-31'), status: PackageStatus.ON_SALE,
      },
    ]);
    await this.packageStores.save(seedPackages.map((deal) => ({ packageId: deal.id, merchantId: merchant.id, storeId: store.id })));
    const additionalMerchants = await this.merchants.save([
      { agencyId: agency.id, legalName: '广州午间食堂餐饮有限公司', brandName: '午间食堂', servicePhone: '020-8888-2234', contractNumber: 'DEMO-2026-002', contractEndsAt: new Date('2027-06-30'), status: MerchantStatus.ACTIVE },
      { agencyId: agency.id, legalName: '广州果然鲜农产品有限公司', brandName: '果然鲜果', servicePhone: '020-8888-3234', contractNumber: 'DEMO-2026-003', contractEndsAt: new Date('2027-06-30'), status: MerchantStatus.ACTIVE },
      { agencyId: agency.id, legalName: '广州暖光花艺有限公司', brandName: '暖光花艺', servicePhone: '020-8888-4234', contractNumber: 'DEMO-2026-004', contractEndsAt: new Date('2027-06-30'), status: MerchantStatus.ACTIVE },
      { agencyId: agency.id, legalName: '广州慢调生活服务有限公司', brandName: '慢调理发', servicePhone: '020-8888-5234', contractNumber: 'DEMO-2026-005', contractEndsAt: new Date('2027-06-30'), status: MerchantStatus.ACTIVE },
    ]);
    await this.registrations.save([
      { merchantId: merchant.id, status: MerchantRegistrationStatus.PENDING_MATERIALS, note: '演示资料清单待代理商补齐。', failureReason: '', updatedBy: null },
      ...additionalMerchants.map((extra) => ({ merchantId: extra.id, status: MerchantRegistrationStatus.DRAFT, note: '', failureReason: '', updatedBy: null })),
    ]);
    const offerings: Record<string, { title: string; description: string; priceFen: number }> = {
      '午间食堂': { title: '双人午市套餐', description: '工作日午市到店使用，含主食与饮品。', priceFen: 6900 },
      '果然鲜果': { title: '当季水果礼盒', description: '到店领取新鲜水果礼盒一份。', priceFen: 5900 },
      '暖光花艺': { title: '节日鲜花小篮', description: '到店领取，款式以当日花材为准。', priceFen: 4990 },
      '慢调理发': { title: '男士精剪服务', description: '含洗剪造型，到店前请电话预约。', priceFen: 7800 },
    };
    for (const extra of additionalMerchants) {
      const extraStore = await this.stores.save({ merchantId: extra.id, name: `${extra.brandName} - 天河店`, address: '广州市天河区体育西路 66 号', phone: extra.servicePhone, businessHours: '09:00-21:00', openForSale: true });
      await this.rates.save({ merchantId: extra.id, rate: '0.0800', effectiveFrom: new Date('2026-01-01'), note: '演示合同费率', createdBy: 'seed' });
      const deal = await this.packages.save({ merchantId: extra.id, ...offerings[extra.brandName], saleLimit: 100, soldCount: 0, perCustomerLimit: 3, storeIds: [extraStore.id], validFrom: new Date('2026-01-01'), validTo: new Date('2026-12-31'), status: PackageStatus.ON_SALE });
      await this.packageStores.save({ packageId: deal.id, merchantId: extra.id, storeId: extraStore.id });
    }
    await this.users.save([
      { email: 'platform@demo.local', name: '平台管理员', passwordHash, role: UserRole.PLATFORM_ADMIN, platformAccessProfile: PlatformAccessProfile.SYSTEM_ADMIN, agencyId: null, merchantId: null, storeIds: null },
      { email: 'platform-operations@demo.local', name: '平台运营演示账号', passwordHash, role: UserRole.PLATFORM_ADMIN, platformAccessProfile: PlatformAccessProfile.OPERATIONS, agencyId: null, merchantId: null, storeIds: null },
      { email: 'agency@demo.local', name: '代理商管理员', passwordHash, role: UserRole.AGENCY_ADMIN, agencyId: agency.id, merchantId: null, storeIds: null },
      { email: 'merchant@demo.local', name: '花时间管理员', passwordHash, role: UserRole.MERCHANT_ADMIN, agencyId: agency.id, merchantId: merchant.id, storeIds: null },
      { email: 'staff@demo.local', name: '珠江新城核销员', passwordHash, role: UserRole.STORE_STAFF, agencyId: agency.id, merchantId: merchant.id, storeIds: [store.id] },
    ]);
  }
}
