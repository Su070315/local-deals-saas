import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { AuditLog, PlatformAccessProfile, Store, User, UserRole } from './domain/entities';
import { AuditWriterService } from './audit-writer.service';
import { MerchantAccessService } from './merchant-access.service';

type StoreConfigSnapshot = {
  version: number;
  name: string;
  address: string;
  phone: string;
  businessHours: string;
  latitude: number | null;
  longitude: number | null;
  openForSale: boolean;
  openForVerification: boolean;
};
export type StoreVersion = StoreConfigSnapshot & { auditId: string; action: string; createdAt: Date };
export type StoreSaveInput = Partial<Store> & { id?: string; expectedVersion?: number; name: string; address: string; fulfillmentChangeReason?: string; isDefault?: boolean };

@Injectable()
export class StoreService {
  /** Keeps local/demo edits aligned with PostgreSQL row-lock serialization. */
  private readonly mutationLocks = new Map<string, Promise<void>>();

  constructor(
    private readonly dataSource: DataSource,
    private readonly auditWriter: AuditWriterService,
    private readonly merchantAccess: MerchantAccessService,
    @InjectRepository(Store) private readonly stores: Repository<Store>,
    @InjectRepository(AuditLog) private readonly audits: Repository<AuditLog>,
  ) {}

  async listStores(user: User, merchantId: string): Promise<Store[]> {
    const merchant = await this.merchantAccess.getForUser(user, merchantId, [PlatformAccessProfile.OPERATIONS]);
    const all = await this.stores.find({ where: { merchantId: merchant.id }, order: { createdAt: 'ASC' } });
    return user.role === UserRole.STORE_STAFF ? all.filter((store) => user.storeIds?.includes(store.id)) : all;
  }

  async saveStore(user: User, merchantId: string, input: StoreSaveInput): Promise<Store> {
    const merchant = await this.merchantAccess.getForUser(user, merchantId, [PlatformAccessProfile.OPERATIONS]);
    if (user.role === UserRole.STORE_STAFF) throw new ForbiddenException('核销员不可管理门店');
    const name = this.requiredText(input.name, '门店名称', 100);
    const address = this.requiredText(input.address, '门店地址', 300);
    const phone = this.optionalText(input.phone, '门店电话', 40);
    const businessHours = this.optionalText(input.businessHours, '营业时间', 80) || '09:00-21:00';
    const coordinates = this.storeCoordinates(input.latitude, input.longitude);
    const fulfillmentStatusRequested = input.openForVerification !== undefined;
    if (fulfillmentStatusRequested) this.merchantAccess.requirePlatformAccess(user, '停止或恢复门店履约', [PlatformAccessProfile.OPERATIONS]);
    if (input.id) {
      return this.withMutationLock(input.id, () => this.dataSource.transaction(async (manager) => {
        const store = await manager.findOne(Store, { where: { id: input.id, merchantId }, lock: { mode: 'pessimistic_write' } });
        if (!store) throw new NotFoundException('门店不存在');
        this.normalizeVersion(store);
        if (input.expectedVersion !== undefined) this.requireVersion(input.expectedVersion, store.version);
        if (fulfillmentStatusRequested && input.expectedVersion === undefined) throw new BadRequestException('变更门店履约状态时必须提供门店版本号');
        const before = this.snapshot(store);
        const openForVerification = input.openForVerification ?? store.openForVerification;
        if (openForVerification !== store.openForVerification) {
          this.requiredText(input.fulfillmentChangeReason, '门店履约状态变更说明', 500);
        } else if (input.fulfillmentChangeReason !== undefined) {
          throw new BadRequestException('门店履约状态未变化，无需填写变更说明');
        }
        Object.assign(store, {
          name,
          address,
          phone: input.phone === undefined ? store.phone : phone,
          businessHours: input.businessHours === undefined ? store.businessHours : businessHours,
          // FIX(2026-08-10)：门店头像/简介（商家体验增强）
          logoUrl: input.logoUrl === undefined ? store.logoUrl : this.optionalText(input.logoUrl, '门店头像地址', 500) || null,
          description: input.description === undefined ? store.description : this.optionalText(input.description, '门店简介', 2000),
          // 总店标记（商家名下仅一家总店，首页展示总店/分店标签与切换）
          isDefault: input.isDefault === undefined ? store.isDefault : input.isDefault === true,
          // 门店评分/附加服务（首页按门店展示，门店可改）
          rating: input.rating === undefined ? store.rating : this.storeRating(input.rating),
          featureTags: input.featureTags === undefined ? store.featureTags : this.storeFeatureTags(input.featureTags),
          openForVerification,
          openForSale: openForVerification ? (input.openForSale ?? store.openForSale) : false,
          version: store.version + 1,
          ...(coordinates === undefined ? {} : coordinates || { latitude: null, longitude: null }),
        });
        const saved = this.normalizeVersion(await manager.save(Store, store));
        await this.auditWriter.write(user.id, merchantId, 'STORE_UPDATED', 'Store', saved.id, before, this.snapshot(saved), manager);
        return saved;
      }));
    }
    const openForVerification = input.openForVerification ?? true;
    if (!openForVerification) {
      this.merchantAccess.requirePlatformAccess(user, '停止或恢复门店履约', [PlatformAccessProfile.OPERATIONS]);
      this.requiredText(input.fulfillmentChangeReason, '门店履约状态变更说明', 500);
    } else if (input.fulfillmentChangeReason !== undefined) {
      throw new BadRequestException('门店履约状态未变化，无需填写变更说明');
    }
    return this.dataSource.transaction(async (manager) => {
      const store = manager.create(Store, {
        merchantId: merchant.id, name, address, phone, businessHours,
        // FIX(2026-08-10)：门店头像/简介（商家体验增强）
        logoUrl: this.optionalText(input.logoUrl, '门店头像地址', 500) || null,
        description: this.optionalText(input.description, '门店简介', 2000),
        // 总店标记（商家名下仅一家总店）
        isDefault: input.isDefault === true,
        // 门店评分/附加服务（首页按门店展示，门店可改）
        rating: this.storeRating(input.rating),
        featureTags: this.storeFeatureTags(input.featureTags),
        openForVerification, openForSale: openForVerification ? (input.openForSale ?? true) : false, version: 1, ...(coordinates || { latitude: null, longitude: null }),
      });
      const saved = this.normalizeVersion(await manager.save(Store, store));
      await this.auditWriter.write(user.id, merchantId, 'STORE_CREATED', 'Store', saved.id, null, this.snapshot(saved), manager);
      return saved;
    });
  }

  async listStoreVersions(user: User, merchantId: string, storeId: string): Promise<StoreVersion[]> {
    await this.merchantAccess.getForUser(user, merchantId, [PlatformAccessProfile.OPERATIONS]);
    if (user.role === UserRole.STORE_STAFF) throw new ForbiddenException('核销员不可查看门店版本');
    if (!(await this.stores.existsBy({ id: storeId, merchantId }))) throw new NotFoundException('门店不存在');
    const records = await this.audits.find({ where: { merchantId, resourceType: 'Store', resourceId: storeId }, order: { createdAt: 'DESC', id: 'DESC' }, take: 100 });
    return records.flatMap((record) => {
      const snapshot = this.snapshotFromAudit(record.after);
      return snapshot ? [{ ...snapshot, auditId: record.id, action: record.action, createdAt: record.createdAt }] : [];
    });
  }

  async restoreStoreVersion(user: User, merchantId: string, storeId: string, auditId: string, expectedVersion: number): Promise<Store> {
    await this.merchantAccess.getForUser(user, merchantId, [PlatformAccessProfile.OPERATIONS]);
    if (user.role === UserRole.STORE_STAFF) throw new ForbiddenException('核销员不可恢复门店版本');
    return this.dataSource.transaction(async (manager) => {
      const store = await manager.findOne(Store, { where: { id: storeId, merchantId }, lock: { mode: 'pessimistic_write' } });
      if (!store) throw new NotFoundException('门店不存在');
      this.normalizeVersion(store);
      this.requireVersion(expectedVersion, store.version);
      const source = await manager.findOneBy(AuditLog, { id: auditId, merchantId, resourceType: 'Store', resourceId: storeId });
      if (!source) throw new NotFoundException('门店历史版本不存在');
      const snapshot = this.snapshotFromAudit(source.after);
      if (!snapshot) throw new BadRequestException('该门店历史记录无法用于恢复');
      const before = this.snapshot(store);
      if (snapshot.openForVerification !== store.openForVerification) this.merchantAccess.requirePlatformAccess(user, '恢复门店履约状态', [PlatformAccessProfile.OPERATIONS]);
      Object.assign(store, { ...snapshot, openForSale: snapshot.openForVerification ? snapshot.openForSale : false, version: store.version + 1 });
      const saved = this.normalizeVersion(await manager.save(Store, store));
      await this.auditWriter.write(user.id, merchantId, 'STORE_VERSION_RESTORED', 'Store', storeId, before, this.snapshot(saved), manager);
      return saved;
    });
  }

  /** 门店评分校验：0-5 一位小数，非法回退默认 */
  private storeRating(value: unknown): string {
    if (typeof value === 'string' && /^([0-4](\.[0-9])?|5(\.0)?)$/.test(value)) return value;
    return '';
  }

  /** 门店附加服务标签：仅保留 1-12 字的字符串，去重限 12 个 */
  private storeFeatureTags(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    const seen = new Set<string>();
    for (const tag of value) {
      if (typeof tag !== 'string') continue;
      const trimmed = tag.trim();
      if (!trimmed || trimmed.length > 12) continue;
      if (seen.size >= 12) break;
      seen.add(trimmed);
    }
    return Array.from(seen);
  }

  private normalizeVersion(store: Store): Store {
    store.version = this.requiredInteger(store.version, '门店版本号', 1, 2_147_483_647);
    store.openForVerification = store.openForVerification !== false;
    return store;
  }

  private requireVersion(expectedVersion: unknown, currentVersion: number): void {
    const expected = this.requiredInteger(expectedVersion, '门店版本号', 1, 2_147_483_647);
    const current = this.requiredInteger(currentVersion, '门店当前版本号', 1, 2_147_483_647);
    if (expected !== current) throw new ConflictException('门店已被其他操作更新，请刷新后重试');
  }

  private snapshot(store: Store): StoreConfigSnapshot {
    return { version: this.requiredInteger(store.version, '门店版本号', 1, 2_147_483_647), name: store.name, address: store.address, phone: store.phone, businessHours: store.businessHours, latitude: store.latitude ?? null, longitude: store.longitude ?? null, openForSale: store.openForSale, openForVerification: store.openForVerification !== false };
  }

  private snapshotFromAudit(value: Record<string, unknown> | null): StoreConfigSnapshot | null {
    if (!value || typeof value !== 'object') return null;
    const snapshot = value as Partial<StoreConfigSnapshot>;
    const coordinatesValid = (snapshot.latitude === null && snapshot.longitude === null) || (
      typeof snapshot.latitude === 'number' && Number.isFinite(snapshot.latitude) && snapshot.latitude >= -90 && snapshot.latitude <= 90 &&
      typeof snapshot.longitude === 'number' && Number.isFinite(snapshot.longitude) && snapshot.longitude >= -180 && snapshot.longitude <= 180
    );
    if (!Number.isInteger(snapshot.version) || snapshot.version! < 1 || typeof snapshot.name !== 'string' || !snapshot.name.trim() || snapshot.name.length > 100 || typeof snapshot.address !== 'string' || !snapshot.address.trim() || snapshot.address.length > 300 || typeof snapshot.phone !== 'string' || snapshot.phone.length > 40 || typeof snapshot.businessHours !== 'string' || !snapshot.businessHours.trim() || snapshot.businessHours.length > 80 || typeof snapshot.openForSale !== 'boolean' || (snapshot.openForVerification !== undefined && typeof snapshot.openForVerification !== 'boolean') || !coordinatesValid) return null;
    return { version: snapshot.version!, name: snapshot.name.trim(), address: snapshot.address.trim(), phone: snapshot.phone.trim(), businessHours: snapshot.businessHours.trim(), latitude: snapshot.latitude === null ? null : snapshot.latitude!, longitude: snapshot.longitude === null ? null : snapshot.longitude!, openForSale: snapshot.openForSale, openForVerification: snapshot.openForVerification !== false };
  }

  private requiredText(value: unknown, label: string, maxLength: number): string {
    if (typeof value !== 'string') throw new BadRequestException(`${label}格式不正确`);
    const normalized = value.trim();
    if (!normalized || normalized.length > maxLength) throw new BadRequestException(`${label}不能为空且不能超过 ${maxLength} 个字符`);
    return normalized;
  }

  private optionalText(value: unknown, label: string, maxLength: number): string {
    return value === undefined || value === null || value === '' ? '' : this.requiredText(value, label, maxLength);
  }

  private requiredInteger(value: unknown, label: string, min: number, max: number): number {
    const number = Number(value);
    if (!Number.isInteger(number) || number < min || number > max) throw new BadRequestException(`${label}必须为 ${min} 至 ${max} 的整数`);
    return number;
  }

  private storeCoordinates(latitude: unknown, longitude: unknown): Pick<Store, 'latitude' | 'longitude'> | null | undefined {
    const latitudeSupplied = latitude !== undefined;
    const longitudeSupplied = longitude !== undefined;
    if (!latitudeSupplied && !longitudeSupplied) return undefined;
    if (!latitudeSupplied || !longitudeSupplied) throw new BadRequestException('门店经纬度必须同时填写');
    if (latitude === null && longitude === null) return null;
    const normalizedLatitude = Number(latitude);
    const normalizedLongitude = Number(longitude);
    if (!Number.isFinite(normalizedLatitude) || normalizedLatitude < -90 || normalizedLatitude > 90) throw new BadRequestException('门店纬度必须在 -90 至 90 之间');
    if (!Number.isFinite(normalizedLongitude) || normalizedLongitude < -180 || normalizedLongitude > 180) throw new BadRequestException('门店经度必须在 -180 至 180 之间');
    return { latitude: normalizedLatitude, longitude: normalizedLongitude };
  }

  private async withMutationLock<T>(storeId: string, operation: () => Promise<T>): Promise<T> {
    const predecessor = this.mutationLocks.get(storeId) || Promise.resolve();
    const waiting = predecessor.catch(() => undefined);
    let release: () => void = () => undefined;
    const completed = new Promise<void>((resolve) => { release = resolve; });
    const current = waiting.then(() => completed);
    this.mutationLocks.set(storeId, current);
    await waiting;
    try { return await operation(); }
    finally {
      release();
      if (this.mutationLocks.get(storeId) === current) this.mutationLocks.delete(storeId);
    }
  }
}
