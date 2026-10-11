import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { AuditLog, DealPackage, MerchantTemplateConfig, PlatformAccessProfile, User, UserRole } from './domain/entities';
import { AuditWriterService } from './audit-writer.service';
import { MerchantAccessService } from './merchant-access.service';

export type MerchantTemplateConfigInput = { expectedVersion: number; homeTitle?: string; homeSubtitle?: string; featuredPackageId?: string | null };
export type MerchantTemplateConfigView = { id: string | null; merchantId: string; homeTitle: string; homeSubtitle: string; featuredPackageId: string | null; version: number; updatedAt: Date | null };
type MerchantTemplateConfigSnapshot = { homeTitle: string; homeSubtitle: string; featuredPackageId: string | null; version: number };
export type MerchantTemplateConfigVersion = MerchantTemplateConfigSnapshot & { auditId: string; action: string; createdAt: Date };

@Injectable()
export class MerchantTemplateService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly auditWriter: AuditWriterService,
    private readonly merchantAccess: MerchantAccessService,
    @InjectRepository(MerchantTemplateConfig) private readonly configs: Repository<MerchantTemplateConfig>,
    @InjectRepository(AuditLog) private readonly audits: Repository<AuditLog>,
  ) {}

  async get(user: User, merchantId: string): Promise<MerchantTemplateConfigView> {
    await this.merchantAccess.getForUser(user, merchantId, [PlatformAccessProfile.OPERATIONS]);
    if (user.role === UserRole.STORE_STAFF) throw new ForbiddenException('核销员不可查看品牌主页配置');
    return this.view(merchantId, await this.configs.findOneBy({ merchantId }));
  }

  async save(user: User, merchantId: string, input: MerchantTemplateConfigInput): Promise<MerchantTemplateConfigView> {
    await this.merchantAccess.getForUser(user, merchantId, [PlatformAccessProfile.OPERATIONS]);
    if (user.role === UserRole.STORE_STAFF) throw new ForbiddenException('核销员不可修改品牌主页配置');
    if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 0) throw new BadRequestException('主页配置版本不正确');
    return this.dataSource.transaction(async (manager) => {
      const current = await manager.findOne(MerchantTemplateConfig, { where: { merchantId }, lock: { mode: 'pessimistic_write' } });
      const currentVersion = current?.version ?? 0;
      if (input.expectedVersion !== currentVersion) throw new ConflictException('品牌主页配置已被其他操作更新，请刷新后重试');
      const homeTitle = input.homeTitle === undefined ? current?.homeTitle || '' : this.optionalText(input.homeTitle, '主页标题', 80);
      const homeSubtitle = input.homeSubtitle === undefined ? current?.homeSubtitle || '' : this.optionalText(input.homeSubtitle, '主页介绍', 240);
      const featuredPackageId = input.featuredPackageId === undefined ? current?.featuredPackageId ?? null : input.featuredPackageId || null;
      if (featuredPackageId && !(await manager.existsBy(DealPackage, { id: featuredPackageId, merchantId }))) throw new BadRequestException('主推套餐不属于当前商家');
      const config = current || manager.create(MerchantTemplateConfig, { merchantId, homeTitle: '', homeSubtitle: '', featuredPackageId: null, version: 0, updatedBy: null });
      const before = current ? this.snapshot(current) : null;
      Object.assign(config, { homeTitle, homeSubtitle, featuredPackageId, version: currentVersion + 1, updatedBy: user.id });
      const saved = await manager.save(MerchantTemplateConfig, config);
      await this.auditWriter.write(user.id, merchantId, 'MERCHANT_TEMPLATE_CONFIG_SAVED', 'MerchantTemplateConfig', saved.id, before, this.snapshot(saved), manager);
      // FIX(2026-08-12)：品牌主页变更时 bump 配置版本——触发小程序端 knownVersion 失配，
      // 强制全量拉取 bootstrap（首页大标题等实时生效，无需等 TTL 缓存过期）
      await manager.query('UPDATE "merchant_app_configs" SET "configVersion" = "configVersion" + 1 WHERE "merchantId" = $1', [merchantId]);
      return this.view(merchantId, saved);
    });
  }

  async versions(user: User, merchantId: string): Promise<MerchantTemplateConfigVersion[]> {
    await this.merchantAccess.getForUser(user, merchantId, [PlatformAccessProfile.OPERATIONS]);
    if (user.role === UserRole.STORE_STAFF) throw new ForbiddenException('核销员不可查看品牌主页版本');
    const config = await this.configs.findOneBy({ merchantId });
    if (!config) return [];
    const records = await this.audits.find({ where: { merchantId, resourceType: 'MerchantTemplateConfig', resourceId: config.id }, order: { createdAt: 'DESC' }, take: 100 });
    return records.flatMap((record) => {
      const snapshot = this.snapshotFromAudit(record.after);
      return snapshot ? [{ ...snapshot, auditId: record.id, action: record.action, createdAt: record.createdAt }] : [];
    });
  }

  async restore(user: User, merchantId: string, auditId: string, expectedVersion: number): Promise<MerchantTemplateConfigView> {
    await this.merchantAccess.getForUser(user, merchantId, [PlatformAccessProfile.OPERATIONS]);
    if (user.role === UserRole.STORE_STAFF) throw new ForbiddenException('核销员不可恢复品牌主页版本');
    return this.dataSource.transaction(async (manager) => {
      const config = await manager.findOne(MerchantTemplateConfig, { where: { merchantId }, lock: { mode: 'pessimistic_write' } });
      if (!config) throw new NotFoundException('品牌主页配置不存在');
      const currentVersion = this.requiredInteger(config.version, '主页配置当前版本号');
      const requestedVersion = this.requiredInteger(expectedVersion, '主页配置版本号');
      if (requestedVersion !== currentVersion) throw new ConflictException('品牌主页配置已被其他操作更新，请刷新后重试');
      const source = await manager.findOneBy(AuditLog, { id: auditId, merchantId, resourceType: 'MerchantTemplateConfig', resourceId: config.id });
      if (!source) throw new NotFoundException('品牌主页历史版本不存在');
      const snapshot = this.snapshotFromAudit(source.after);
      if (!snapshot) throw new BadRequestException('该历史记录无法用于恢复');
      if (snapshot.featuredPackageId && !(await manager.existsBy(DealPackage, { id: snapshot.featuredPackageId, merchantId }))) throw new BadRequestException('历史主推套餐已删除或不属于当前商家，无法恢复');
      const before = this.snapshot(config);
      Object.assign(config, { homeTitle: snapshot.homeTitle, homeSubtitle: snapshot.homeSubtitle, featuredPackageId: snapshot.featuredPackageId, version: currentVersion + 1, updatedBy: user.id });
      const saved = await manager.save(MerchantTemplateConfig, config);
      await this.auditWriter.write(user.id, merchantId, 'MERCHANT_TEMPLATE_CONFIG_VERSION_RESTORED', 'MerchantTemplateConfig', saved.id, before, this.snapshot(saved), manager);
      return this.view(merchantId, saved);
    });
  }

  private view(merchantId: string, config: MerchantTemplateConfig | null): MerchantTemplateConfigView { return config ? { id: config.id, merchantId, homeTitle: config.homeTitle, homeSubtitle: config.homeSubtitle, featuredPackageId: config.featuredPackageId, version: config.version, updatedAt: config.updatedAt } : { id: null, merchantId, homeTitle: '', homeSubtitle: '', featuredPackageId: null, version: 0, updatedAt: null }; }
  private snapshot(config: MerchantTemplateConfig): MerchantTemplateConfigSnapshot { return { homeTitle: config.homeTitle, homeSubtitle: config.homeSubtitle, featuredPackageId: config.featuredPackageId, version: config.version }; }
  private snapshotFromAudit(value: Record<string, unknown> | null): MerchantTemplateConfigSnapshot | null {
    if (!value || typeof value !== 'object') return null;
    const snapshot = value as Partial<MerchantTemplateConfigSnapshot>;
    if (!Number.isInteger(snapshot.version) || snapshot.version! < 1 || typeof snapshot.homeTitle !== 'string' || snapshot.homeTitle.length > 80 || typeof snapshot.homeSubtitle !== 'string' || snapshot.homeSubtitle.length > 240 || !(snapshot.featuredPackageId === null || typeof snapshot.featuredPackageId === 'string')) return null;
    return { version: snapshot.version!, homeTitle: snapshot.homeTitle, homeSubtitle: snapshot.homeSubtitle, featuredPackageId: snapshot.featuredPackageId };
  }
  private optionalText(value: unknown, label: string, maximum: number): string { if (value === undefined || value === null || value === '') return ''; if (typeof value !== 'string' || !value.trim() || value.trim().length > maximum) throw new BadRequestException(`${label}不能为空且不能超过 ${maximum} 个字符`); return value.trim(); }
  private requiredInteger(value: unknown, label: string): number { const number = Number(value); if (!Number.isInteger(number) || number < 1 || number > 2_147_483_647) throw new BadRequestException(`${label}必须为 1 至 2147483647 的整数`); return number; }
}
