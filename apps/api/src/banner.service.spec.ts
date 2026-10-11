import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { BannerService } from './banner.service';
import { MerchantAccessService } from './merchant-access.service';
import { AuditWriterService } from './audit-writer.service';
import { MerchantBanner, Store, User, UserRole } from './domain/entities';

/** 门店级轮播图管理的单元测试（纯 mock，不连数据库）：门店维度隔离 + 权限 + 校验 */

function makeService(overrides: {
  banners?: Partial<MerchantBanner>[];
  managerFind?: () => Promise<Partial<MerchantBanner>[]>;
  managerFindOne?: () => Promise<Partial<MerchantBanner> | null>;
  storeExists?: boolean;
  accessError?: unknown;
} = {}) {
  const configRepo = {
    findOneBy: jest.fn(async () => null),
    create: jest.fn((data) => data),
    save: jest.fn(async (entity) => entity),
  };
  const manager = {
    create: jest.fn((_cls: unknown, data: Partial<MerchantBanner>) => data),
    save: jest.fn(async (_cls: unknown, entity: MerchantBanner | MerchantBanner[]) => Array.isArray(entity) ? entity : ({ ...entity })),
    find: jest.fn(async () => overrides.banners ?? overrides.managerFind?.() ?? []),
    findOne: jest.fn(async () => overrides.managerFindOne?.() ?? null),
    count: jest.fn(async () => (overrides.banners || []).length),
    getRepository: jest.fn(() => configRepo),
    delete: jest.fn(async () => undefined),
  } as unknown as EntityManager;
  const dataSource = {
    transaction: jest.fn(async (callback: (m: EntityManager) => Promise<unknown>) => callback(manager)),
  } as unknown as DataSource;
  const merchantAccess = {
    getForUser: jest.fn(async () => {
      if (overrides.accessError) throw overrides.accessError;
    }),
  } as unknown as MerchantAccessService;
  const auditWriter = { write: jest.fn(async () => undefined) } as unknown as AuditWriterService;
  const bannerRepo = { find: jest.fn() } as unknown as Repository<MerchantBanner>;
  const storeRepo = {
    findOneBy: jest.fn(async () => (overrides.storeExists === false ? null : { id: STORE_ID, merchantId: MERCHANT_ID })),
  } as unknown as Repository<Store>;
  const auditRepo = {} as never;
  const service = new BannerService(dataSource, merchantAccess, auditWriter, bannerRepo, storeRepo, auditRepo);
  return { service, manager, merchantAccess, auditWriter, storeRepo, configRepo };
}

const merchantUser = { id: 'u-1', role: UserRole.MERCHANT_ADMIN } as User;
const staffUser = { id: 'u-2', role: UserRole.STORE_STAFF } as User;
const MERCHANT_ID = '11111111-1111-4111-8111-111111111111';
const STORE_ID = '44444444-4444-4444-8444-444444444444';
const BANNER_ID = '22222222-2222-4222-8222-222222222222';
const URL = 'https://cdn.example.com/banner.jpg';

function baseBanner(over: Partial<MerchantBanner> = {}): Partial<MerchantBanner> {
  return { id: BANNER_ID, merchantId: MERCHANT_ID, storeId: STORE_ID, url: URL, link: '', sortOrder: 1, isDefault: true, ...over };
}

describe('BannerService（门店维度）', () => {
  describe('权限与归属', () => {
    it('拒绝核销员（STORE_STAFF）管理轮播图', async () => {
      const { service } = makeService();
      await expect(service.listBanners(staffUser, MERCHANT_ID, STORE_ID)).rejects.toThrow(ForbiddenException);
    });

    it('无 OPERATIONS 权限时透传 merchantAccess 异常', async () => {
      const { service } = makeService({ accessError: new ForbiddenException('无权限') });
      await expect(service.listBanners(merchantUser, MERCHANT_ID, STORE_ID)).rejects.toThrow(ForbiddenException);
    });

    it('门店不属于该商家时返回 404（防跨店越权）', async () => {
      const { service } = makeService({ storeExists: false });
      await expect(service.listBanners(merchantUser, MERCHANT_ID, STORE_ID)).rejects.toThrow(NotFoundException);
      await expect(service.addBanner(merchantUser, MERCHANT_ID, STORE_ID, URL)).rejects.toThrow(NotFoundException);
      await expect(service.removeBanner(merchantUser, MERCHANT_ID, STORE_ID, BANNER_ID)).rejects.toThrow(NotFoundException);
    });
  });

  describe('addBanner', () => {
    it('非 https 地址被拒绝', async () => {
      const { service } = makeService();
      await expect(service.addBanner(merchantUser, MERCHANT_ID, STORE_ID, 'http://insecure.com/a.jpg')).rejects.toThrow(BadRequestException);
    });

    it('非法跳转链接被拒绝（仅支持 / 开头内部路径）', async () => {
      const { service } = makeService();
      await expect(service.addBanner(merchantUser, MERCHANT_ID, STORE_ID, URL, 'https://evil.com/x')).rejects.toThrow(BadRequestException);
      await expect(service.addBanner(merchantUser, MERCHANT_ID, STORE_ID, URL, 'javascript:alert(1)')).rejects.toThrow(BadRequestException);
    });

    it('首张自动设默认，sortOrder 从 1 开始，link 正确保存并使 bootstrap 版本失效', async () => {
      const { service, configRepo } = makeService({ managerFindOne: async () => null });
      const saved = await service.addBanner(merchantUser, MERCHANT_ID, STORE_ID, URL, '/pages/detail/index?id=1');
      expect(saved.isDefault).toBe(true);
      expect(saved.sortOrder).toBe(1);
      expect(saved.storeId).toBe(STORE_ID);
      expect(saved.link).toBe('/pages/detail/index?id=1');
      expect(configRepo.save).toHaveBeenCalledWith(expect.objectContaining({ merchantId: MERCHANT_ID, configVersion: 2, updatedBy: 'u-1' }));
    });

    it('已有 10 张图片时拒绝继续新增', async () => {
      const { service } = makeService({ banners: Array.from({ length: 10 }, (_, index) => baseBanner({ id: `banner-${index}` })) });
      await expect(service.addBanner(merchantUser, MERCHANT_ID, STORE_ID, URL)).rejects.toThrow('每个门店最多上传 10 张首页图片');
    });
  });

  describe('replaceBanner', () => {
    it('替换不存在的轮播图返回 404', async () => {
      const { service } = makeService({ managerFindOne: async () => null });
      await expect(service.replaceBanner(merchantUser, MERCHANT_ID, STORE_ID, BANNER_ID, URL)).rejects.toThrow(NotFoundException);
    });

    it('正常替换更新 url/link 并写审计', async () => {
      const { service, auditWriter } = makeService({ managerFindOne: async () => baseBanner() });
      const saved = await service.replaceBanner(merchantUser, MERCHANT_ID, STORE_ID, BANNER_ID, 'https://cdn.example.com/new.jpg', '/pages/vouchers/index');
      expect(saved.url).toBe('https://cdn.example.com/new.jpg');
      expect(saved.link).toBe('/pages/vouchers/index');
      expect(auditWriter.write).toHaveBeenCalledWith(
        'u-1', MERCHANT_ID, 'MERCHANT_BANNER_REPLACED', 'MerchantBanner', BANNER_ID,
        expect.objectContaining({ url: URL }), expect.objectContaining({ url: 'https://cdn.example.com/new.jpg' }), expect.anything(),
      );
    });
  });

  describe('removeBanner', () => {
    it('删除默认图后自动转移默认给 sortOrder 最小者', async () => {
      const next = baseBanner({ id: '33333333-3333-4333-8333-333333333333', sortOrder: 2, isDefault: false });
      let call = 0;
      const { service, manager } = makeService({
        managerFindOne: async () => (call++ === 0 ? baseBanner() : next),
        managerFind: async () => [next],
      });
      await service.removeBanner(merchantUser, MERCHANT_ID, STORE_ID, BANNER_ID);
      expect(manager.delete).toHaveBeenCalled();
      expect(next.isDefault).toBe(true);
    });
  });

  describe('reorderBanners', () => {
    it('ids 与当前列表不一致时报错', async () => {
      const { service } = makeService({ banners: [baseBanner(), baseBanner({ id: '33333333-3333-4333-8333-333333333333', isDefault: false })] });
      await expect(service.reorderBanners(merchantUser, MERCHANT_ID, STORE_ID, ['only-one'])).rejects.toThrow(BadRequestException);
    });

    it('正常排序并设默认', async () => {
      const second = baseBanner({ id: '33333333-3333-4333-8333-333333333333', sortOrder: 2, isDefault: false });
      const { service } = makeService({ banners: [baseBanner(), second] });
      const result = await service.reorderBanners(merchantUser, MERCHANT_ID, STORE_ID, [second.id!, baseBanner().id!], second.id);
      expect(result[0].id).toBe(second.id);
      expect(result[0].sortOrder).toBe(1);
      expect(result[0].isDefault).toBe(true);
      expect(result[1].sortOrder).toBe(2);
      expect(result[1].isDefault).toBe(false);
    });
  });
});
