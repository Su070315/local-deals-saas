import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { AuditLog, MerchantBanner, PlatformAccessProfile, Store, User, UserRole } from './domain/entities';
import { MerchantAppConfig } from './domain/app-config.entities';
import { AuditWriterService } from './audit-writer.service';
import { MerchantAccessService } from './merchant-access.service';

const MAX_BANNERS_PER_STORE = 10;

/** 门店顶部图片管理：每个门店独立管理首页图片，按 storeId 隔离存储。 */
@Injectable()
export class BannerService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly merchantAccess: MerchantAccessService,
    private readonly auditWriter: AuditWriterService,
    @InjectRepository(MerchantBanner) private readonly banners: Repository<MerchantBanner>,
    @InjectRepository(Store) private readonly stores: Repository<Store>,
    @InjectRepository(AuditLog) private readonly audits: Repository<AuditLog>,
  ) {}

  /**
   * 门店图片属于 bootstrap 实时数据。写入成功后递增商家配置版本，
   * 使携带 knownVersion 的顾客端下次拉取时不会错误命中 notModified。
   */
  private async bumpConfigVersion(manager: EntityManager, merchantId: string, updatedBy: string): Promise<void> {
    const configs = manager.getRepository(MerchantAppConfig);
    const config = await configs.findOneBy({ merchantId });
    if (config) {
      config.configVersion += 1;
      config.updatedBy = updatedBy;
      await configs.save(config);
      return;
    }
    await configs.save(configs.create({ merchantId, config: {}, configVersion: 2, updatedBy }));
  }

  /** 权限：商家 OPERATIONS 角色，核销员不可操作（与门店管理一致） */
  private async assertCanManage(user: User, merchantId: string): Promise<void> {
    await this.merchantAccess.getForUser(user, merchantId, [PlatformAccessProfile.OPERATIONS]);
    if (user.role === UserRole.STORE_STAFF) throw new ForbiddenException('核销员不可管理轮播图');
  }

  /** 门店归属校验：门店必须属于该商家，防跨店越权 */
  private async assertStoreOwned(user: User, merchantId: string, storeId: string): Promise<void> {
    const store = await this.stores.findOneBy({ id: storeId, merchantId });
    if (!store) throw new NotFoundException('门店不存在');
  }

  private sanitizeUrl(url: string): string {
    const value = String(url || '').trim();
    if (!value) throw new BadRequestException('图片地址不能为空');
    if (!/^https:\/\//i.test(value)) throw new BadRequestException('图片地址必须是 https 链接');
    if (value.length > 500) throw new BadRequestException('图片地址过长');
    return value;
  }

  /** 跳转链接：仅支持小程序内部路径（以 / 开头），空表示不可点击 */
  private sanitizeLink(link: string | undefined): string {
    const value = String(link || '').trim();
    if (!value) return '';
    if (!value.startsWith('/')) throw new BadRequestException('跳转链接仅支持小程序内部路径（以 / 开头）');
    if (value.length > 500) throw new BadRequestException('跳转链接过长');
    return value;
  }

  private findOwned(manager: EntityManager, merchantId: string, storeId: string, bannerId: string): Promise<MerchantBanner | null> {
    return manager.findOne(MerchantBanner, { where: { id: bannerId, storeId, merchantId } });
  }

  /** 门店查询自己的轮播图（按 sortOrder 升序） */
  async listBanners(user: User, merchantId: string, storeId: string): Promise<MerchantBanner[]> {
    await this.assertCanManage(user, merchantId);
    await this.assertStoreOwned(user, merchantId, storeId);
    return this.banners.find({ where: { storeId, merchantId }, order: { sortOrder: 'ASC', createdAt: 'ASC' } });
  }

  /** 新增一条门店轮播图（sortOrder 取当前最大 + 1；首张自动设为默认） */
  async addBanner(user: User, merchantId: string, storeId: string, url: string, link?: string): Promise<MerchantBanner> {
    await this.assertCanManage(user, merchantId);
    await this.assertStoreOwned(user, merchantId, storeId);
    const cleanUrl = this.sanitizeUrl(url);
    const cleanLink = this.sanitizeLink(link);
    return this.dataSource.transaction(async (manager) => {
      const currentCount = await manager.count(MerchantBanner, { where: { storeId, merchantId } });
      if (currentCount >= MAX_BANNERS_PER_STORE) {
        throw new BadRequestException(`每个门店最多上传 ${MAX_BANNERS_PER_STORE} 张首页图片`);
      }
      const last = await manager.findOne(MerchantBanner, { where: { storeId, merchantId }, order: { sortOrder: 'DESC' } });
      const first = !last;
      const entity = manager.create(MerchantBanner, {
        merchantId,
        storeId,
        url: cleanUrl,
        link: cleanLink,
        sortOrder: (last?.sortOrder ?? 0) + 1,
        isDefault: first,
      });
      const saved = await manager.save(MerchantBanner, entity);
      await this.bumpConfigVersion(manager, merchantId, user.id);
      await this.auditWriter.write(user.id, merchantId, 'MERCHANT_BANNER_ADDED', 'MerchantBanner', saved.id, null, { storeId, url: saved.url, link: saved.link, sortOrder: saved.sortOrder, isDefault: saved.isDefault }, manager);
      return saved;
    });
  }

  /** 替换一张轮播图（URL 或跳转链接） */
  async replaceBanner(user: User, merchantId: string, storeId: string, bannerId: string, url: string, link?: string): Promise<MerchantBanner> {
    await this.assertCanManage(user, merchantId);
    await this.assertStoreOwned(user, merchantId, storeId);
    const cleanUrl = this.sanitizeUrl(url);
    const cleanLink = this.sanitizeLink(link);
    return this.dataSource.transaction(async (manager) => {
      const entity = await this.findOwned(manager, merchantId, storeId, bannerId);
      if (!entity) throw new NotFoundException('轮播图不存在');
      const before = { url: entity.url, link: entity.link, sortOrder: entity.sortOrder, isDefault: entity.isDefault };
      entity.url = cleanUrl;
      entity.link = cleanLink;
      const saved = await manager.save(MerchantBanner, entity);
      await this.bumpConfigVersion(manager, merchantId, user.id);
      await this.auditWriter.write(user.id, merchantId, 'MERCHANT_BANNER_REPLACED', 'MerchantBanner', saved.id, before, { url: saved.url, link: saved.link, sortOrder: saved.sortOrder, isDefault: saved.isDefault }, manager);
      return saved;
    });
  }

  /** 删除一张；若删除的是默认图，自动把 sortOrder 最小者设为默认（无剩余则忽略） */
  async removeBanner(user: User, merchantId: string, storeId: string, bannerId: string): Promise<void> {
    await this.assertCanManage(user, merchantId);
    await this.assertStoreOwned(user, merchantId, storeId);
    await this.dataSource.transaction(async (manager) => {
      const entity = await this.findOwned(manager, merchantId, storeId, bannerId);
      if (!entity) throw new NotFoundException('轮播图不存在');
      const wasDefault = entity.isDefault;
      const before = { url: entity.url, link: entity.link, sortOrder: entity.sortOrder, isDefault: entity.isDefault };
      await manager.delete(MerchantBanner, { id: bannerId, storeId, merchantId });
      await this.auditWriter.write(user.id, merchantId, 'MERCHANT_BANNER_REMOVED', 'MerchantBanner', bannerId, before, null, manager);
      if (wasDefault) {
        const next = await manager.findOne(MerchantBanner, { where: { storeId, merchantId }, order: { sortOrder: 'ASC' } });
        if (next) {
          next.isDefault = true;
          await manager.save(MerchantBanner, next);
        }
      }
      await this.bumpConfigVersion(manager, merchantId, user.id);
    });
  }

  /** 排序 + 设默认（一次事务完成；ids 为完整目标顺序） */
  async reorderBanners(user: User, merchantId: string, storeId: string, ids: string[], defaultId?: string): Promise<MerchantBanner[]> {
    await this.assertCanManage(user, merchantId);
    await this.assertStoreOwned(user, merchantId, storeId);
    if (!Array.isArray(ids) || ids.length === 0) throw new BadRequestException('排序列表不能为空');
    return this.dataSource.transaction(async (manager) => {
      const owned = await manager.find(MerchantBanner, { where: { storeId, merchantId }, order: { sortOrder: 'ASC' } });
      const ownedIds = new Set(owned.map((banner) => banner.id));
      if (ids.length !== owned.length || ids.some((id) => !ownedIds.has(id))) {
        throw new BadRequestException('排序列表与当前轮播图不一致');
      }
      const defaultBanner = defaultId ? owned.find((banner) => banner.id === defaultId) : undefined;
      if (defaultId && !defaultBanner) throw new NotFoundException('默认轮播图不存在');
      const before = owned.map((banner) => ({ id: banner.id, sortOrder: banner.sortOrder, isDefault: banner.isDefault }));
      ids.forEach((id, index) => {
        const banner = owned.find((item) => item.id === id);
        if (banner) {
          banner.sortOrder = index + 1;
          banner.isDefault = defaultBanner ? banner.id === defaultBanner.id : banner.isDefault;
        }
      });
      const saved = await manager.save(MerchantBanner, owned);
      await this.bumpConfigVersion(manager, merchantId, user.id);
      await this.auditWriter.write(
        user.id, merchantId, 'MERCHANT_BANNER_REORDERED', 'MerchantBanner', `${storeId}:${merchantId}`,
        { banners: before },
        { banners: saved.map((banner) => ({ id: banner.id, sortOrder: banner.sortOrder, isDefault: banner.isDefault })) },
        manager,
      );
      return saved.sort((left, right) => left.sortOrder - right.sortOrder);
    });
  }
}
