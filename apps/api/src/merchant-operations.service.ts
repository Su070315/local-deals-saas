import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { randomUUID } from 'crypto';
import { AuditWriterService } from './audit-writer.service';
import {
  CampaignStatus, DistributionPromoter, InventoryBatch, InventoryBatchStatus, InventoryDocument, InventoryDocumentStatus,
  InventoryDocumentType, MarketingCampaign, MemberProfile, MerchantBusinessSetting, MerchantSettingType,
  OperationalLedgerCategory, OperationalLedgerEntry, PromoterStatus,
} from './domain/merchant-operations.entities';
import { DealPackage, PlatformAccessProfile, User } from './domain/entities';
import { MerchantAccessService } from './merchant-access.service';
import {
  SaveDistributionPromoterDto, SaveInventoryBatchDto, SaveInventoryDocumentDto, SaveMarketingCampaignDto,
  SaveMemberProfileDto, SaveMerchantBusinessSettingDto, SaveOperationalLedgerEntryDto,
} from './merchant-operations.dto';

const PLATFORM_PROFILES = [PlatformAccessProfile.OPERATIONS, PlatformAccessProfile.FINANCE];

@Injectable()
export class MerchantOperationsService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly merchantAccess: MerchantAccessService,
    private readonly audit: AuditWriterService,
    @InjectRepository(InventoryBatch) private readonly inventory: Repository<InventoryBatch>,
    @InjectRepository(InventoryDocument) private readonly inventoryDocuments: Repository<InventoryDocument>,
    @InjectRepository(MemberProfile) private readonly members: Repository<MemberProfile>,
    @InjectRepository(MarketingCampaign) private readonly campaigns: Repository<MarketingCampaign>,
    @InjectRepository(DistributionPromoter) private readonly promoters: Repository<DistributionPromoter>,
    @InjectRepository(OperationalLedgerEntry) private readonly ledger: Repository<OperationalLedgerEntry>,
    @InjectRepository(MerchantBusinessSetting) private readonly settings: Repository<MerchantBusinessSetting>,
  ) {}

  async summary(user: User, merchantId: string) {
    await this.authorize(user, merchantId);
    const [inventory, members, campaigns, promoters] = await Promise.all([
      this.inventory.findBy({ merchantId }), this.members.findBy({ merchantId }),
      this.campaigns.findBy({ merchantId }), this.promoters.findBy({ merchantId }),
    ]);
    return {
      inventory: {
        batchCount: inventory.length,
        availableQuantity: inventory.reduce((sum, item) => sum + Math.max(0, item.quantity - item.reservedQuantity), 0),
        warningCount: inventory.filter((item) => ['EXPIRING', 'EXPIRED', 'DISABLED'].includes(item.status)).length,
      },
      members: {
        total: members.length, active: members.filter((item) => item.status === 'ACTIVE').length,
        balanceFen: members.reduce((sum, item) => sum + item.balanceFen, 0), points: members.reduce((sum, item) => sum + item.points, 0),
      },
      campaigns: {
        total: campaigns.length, active: campaigns.filter((item) => item.status === CampaignStatus.ACTIVE).length,
        redemptions: campaigns.reduce((sum, item) => sum + item.redemptions, 0),
      },
      promoters: {
        total: promoters.length, pending: promoters.filter((item) => item.status === PromoterStatus.PENDING).length,
        salesFen: promoters.reduce((sum, item) => sum + item.salesFen, 0), commissionFen: promoters.reduce((sum, item) => sum + item.commissionFen, 0),
      },
    };
  }

  async listInventory(user: User, merchantId: string) {
    await this.authorize(user, merchantId);
    return this.inventory.find({ where: { merchantId }, order: { updatedAt: 'DESC', id: 'DESC' } });
  }

  async saveInventory(user: User, merchantId: string, body: SaveInventoryBatchDto) {
    await this.authorize(user, merchantId);
    if ((body.reservedQuantity || 0) > body.quantity) throw new BadRequestException('预留数量不能大于库存数量');
    return this.dataSource.transaction(async (manager) => {
      const repository = manager.getRepository(InventoryBatch);
      const before = body.id ? await repository.findOneBy({ id: body.id, merchantId }) : null;
      if (body.id && !before) throw new NotFoundException('库存批次不存在');
      const record = repository.create({
        ...(before || {}), merchantId, packageId: body.packageId || null, storeId: body.storeId || null,
        skuCode: body.skuCode.trim(), productName: body.productName.trim(), quantity: body.quantity,
        reservedQuantity: body.reservedQuantity || 0, unitCostFen: body.unitCostFen || 0,
        productionDate: body.productionDate || null, expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
        status: body.status || before?.status, note: body.note?.trim() || '', version: before ? before.version + 1 : 1,
      });
      const saved = await repository.save(record);
      await this.audit.write(user.id, merchantId, before ? 'INVENTORY_BATCH_UPDATED' : 'INVENTORY_BATCH_CREATED', 'InventoryBatch', saved.id, this.snapshot(before), this.snapshot(saved), manager);
      return saved;
    });
  }

  async listInventoryDocuments(user: User, merchantId: string, type?: InventoryDocumentType) {
    await this.authorize(user, merchantId);
    return this.inventoryDocuments.find({ where: { merchantId, ...(type ? { type } : {}) }, order: { occurredAt: 'DESC', createdAt: 'DESC', id: 'DESC' } });
  }

  async saveInventoryDocument(user: User, merchantId: string, body: SaveInventoryDocumentDto) {
    await this.authorize(user, merchantId);
    this.validateInventoryDocument(body);
    return this.dataSource.transaction(async (manager) => {
      const repository = manager.getRepository(InventoryDocument);
      const before = body.id ? await repository.findOneBy({ id: body.id, merchantId }) : null;
      if (body.id && !before) throw new NotFoundException('库存单据不存在');
      if (before && before.status !== InventoryDocumentStatus.DRAFT) throw new BadRequestException('只有草稿单据可以编辑');
      const items = body.items.map((item) => ({
        ...(item.batchId ? { batchId: item.batchId } : {}), skuCode: item.skuCode.trim(), productName: item.productName.trim(),
        quantity: item.quantity, unitCostFen: item.unitCostFen,
      }));
      const record = repository.create({
        ...(before || {}), merchantId, documentNo: before?.documentNo || this.documentNumber(body.type), type: body.type,
        storeId: body.storeId || null, sourceStoreId: body.sourceStoreId || null, targetStoreId: body.targetStoreId || null,
        counterparty: body.counterparty?.trim() || '', items,
        totalQuantity: items.reduce((sum, item) => sum + item.quantity, 0),
        totalAmountFen: items.reduce((sum, item) => sum + item.quantity * item.unitCostFen, 0),
        occurredAt: new Date(body.occurredAt), status: InventoryDocumentStatus.DRAFT, note: body.note?.trim() || '',
        createdBy: before?.createdBy || user.id, confirmedBy: null, confirmedAt: null,
      });
      const saved = await repository.save(record);
      await this.audit.write(user.id, merchantId, before ? 'INVENTORY_DOCUMENT_UPDATED' : 'INVENTORY_DOCUMENT_CREATED', 'InventoryDocument', saved.id, this.documentSnapshot(before), this.documentSnapshot(saved), manager);
      return saved;
    });
  }

  async changeInventoryDocumentStatus(user: User, merchantId: string, documentId: string, status: InventoryDocumentStatus) {
    await this.authorize(user, merchantId);
    return this.dataSource.transaction(async (manager) => {
      const repository = manager.getRepository(InventoryDocument);
      const document = await repository.findOne({ where: { id: documentId, merchantId }, lock: { mode: 'pessimistic_write' } });
      if (!document) throw new NotFoundException('库存单据不存在');
      if (document.status !== InventoryDocumentStatus.DRAFT) throw new BadRequestException('库存单据已经处理，不能重复确认或取消');
      const before = this.documentSnapshot(document);
      if (status === InventoryDocumentStatus.CONFIRMED) await this.applyInventoryDocument(manager.getRepository(InventoryBatch), document);
      document.status = status;
      document.confirmedBy = status === InventoryDocumentStatus.CONFIRMED ? user.id : null;
      document.confirmedAt = status === InventoryDocumentStatus.CONFIRMED ? new Date() : null;
      const saved = await repository.save(document);
      await this.audit.write(user.id, merchantId, status === InventoryDocumentStatus.CONFIRMED ? 'INVENTORY_DOCUMENT_CONFIRMED' : 'INVENTORY_DOCUMENT_CANCELLED', 'InventoryDocument', saved.id, before, this.documentSnapshot(saved), manager);
      return saved;
    });
  }

  async listMembers(user: User, merchantId: string) {
    await this.authorize(user, merchantId);
    return this.members.find({ where: { merchantId }, order: { updatedAt: 'DESC', id: 'DESC' } });
  }

  async saveMember(user: User, merchantId: string, body: SaveMemberProfileDto) {
    await this.authorize(user, merchantId);
    return this.dataSource.transaction(async (manager) => {
      const repository = manager.getRepository(MemberProfile);
      const before = body.id ? await repository.findOneBy({ id: body.id, merchantId }) : null;
      if (body.id && !before) throw new NotFoundException('会员档案不存在');
      const record = repository.create({
        ...(before || {}), merchantId, externalCustomerId: body.externalCustomerId.trim(), name: body.name.trim(),
        phoneMasked: body.phone === undefined ? before?.phoneMasked || '' : this.maskPhone(body.phone),
        level: body.level?.trim() || before?.level || '普通会员', tags: body.tags || before?.tags || [],
        balanceFen: body.balanceFen ?? before?.balanceFen ?? 0, points: body.points ?? before?.points ?? 0,
        status: body.status || before?.status, lastActiveAt: before?.lastActiveAt || new Date(),
      });
      const saved = await repository.save(record);
      await this.audit.write(user.id, merchantId, before ? 'MEMBER_PROFILE_UPDATED' : 'MEMBER_PROFILE_CREATED', 'MemberProfile', saved.id, this.snapshot(before), this.snapshot(saved), manager);
      return saved;
    });
  }

  async listCampaigns(user: User, merchantId: string) {
    await this.authorize(user, merchantId);
    return this.campaigns.find({ where: { merchantId }, order: { updatedAt: 'DESC', id: 'DESC' } });
  }

  async saveCampaign(user: User, merchantId: string, body: SaveMarketingCampaignDto) {
    await this.authorize(user, merchantId);
    const startsAt = body.startsAt ? new Date(body.startsAt) : null;
    const endsAt = body.endsAt ? new Date(body.endsAt) : null;
    if (startsAt && endsAt && startsAt > endsAt) throw new BadRequestException('活动开始时间不能晚于结束时间');
    return this.dataSource.transaction(async (manager) => {
      const repository = manager.getRepository(MarketingCampaign);
      const before = body.id ? await repository.findOneBy({ id: body.id, merchantId }) : null;
      if (body.id && !before) throw new NotFoundException('营销活动不存在');
      const record = repository.create({
        ...(before || {}), merchantId, name: body.name.trim(), type: body.type.trim(),
        scope: body.scope?.trim() || before?.scope || 'ALL_PRODUCTS', rules: body.rules || before?.rules || {},
        startsAt, endsAt, status: body.status || before?.status,
      });
      const saved = await repository.save(record);
      await this.audit.write(user.id, merchantId, before ? 'MARKETING_CAMPAIGN_UPDATED' : 'MARKETING_CAMPAIGN_CREATED', 'MarketingCampaign', saved.id, this.snapshot(before), this.snapshot(saved), manager);
      return saved;
    });
  }

  async listPromoters(user: User, merchantId: string) {
    await this.authorize(user, merchantId);
    return this.promoters.find({ where: { merchantId }, order: { updatedAt: 'DESC', id: 'DESC' } });
  }

  async savePromoter(user: User, merchantId: string, body: SaveDistributionPromoterDto) {
    await this.authorize(user, merchantId);
    return this.dataSource.transaction(async (manager) => {
      const repository = manager.getRepository(DistributionPromoter);
      const before = body.id ? await repository.findOneBy({ id: body.id, merchantId }) : null;
      if (body.id && !before) throw new NotFoundException('一级分销员不存在');
      const record = repository.create({
        ...(before || {}), merchantId, name: body.name.trim(),
        phoneMasked: body.phone === undefined ? before?.phoneMasked || '' : this.maskPhone(body.phone),
        commissionRate: body.commissionRate.toFixed(4), status: body.status || before?.status,
      });
      const saved = await repository.save(record);
      await this.audit.write(user.id, merchantId, before ? 'DISTRIBUTION_PROMOTER_UPDATED' : 'DISTRIBUTION_PROMOTER_CREATED', 'DistributionPromoter', saved.id, this.snapshot(before), this.snapshot(saved), manager);
      return saved;
    });
  }

  async listLedger(user: User, merchantId: string, category: OperationalLedgerCategory) {
    await this.authorize(user, merchantId);
    return this.ledger.find({ where: { merchantId, category }, order: { occurredAt: 'DESC', createdAt: 'DESC', id: 'DESC' } });
  }

  async saveLedgerEntry(user: User, merchantId: string, body: SaveOperationalLedgerEntryDto) {
    await this.authorize(user, merchantId);
    const allowedStatuses: Record<OperationalLedgerCategory, string[]> = {
      [OperationalLedgerCategory.MEMBER_RECHARGE]: ['PENDING', 'COMPLETED', 'REFUNDED'],
      [OperationalLedgerCategory.DISTRIBUTION_COMMISSION]: ['PENDING', 'SETTLED'],
      [OperationalLedgerCategory.DISTRIBUTION_WITHDRAWAL]: ['PENDING', 'APPROVED', 'REJECTED'],
    };
    if (!allowedStatuses[body.category].includes(body.status)) throw new BadRequestException('台账状态与业务类型不匹配');
    return this.dataSource.transaction(async (manager) => {
      const repository = manager.getRepository(OperationalLedgerEntry);
      const before = body.id ? await repository.findOneBy({ id: body.id, merchantId, category: body.category }) : null;
      if (body.id && !before) throw new NotFoundException('业务台账记录不存在');
      if (before && before.status !== 'PENDING') throw new BadRequestException('已完成的台账记录不能修改');
      const record = repository.create({
        ...(before || {}), merchantId, category: body.category,
        referenceNo: before?.referenceNo || this.ledgerReference(body.category), subjectName: body.subjectName.trim(),
        amountFen: body.amountFen, status: body.status, occurredAt: new Date(body.occurredAt), note: body.note?.trim() || '',
        metadata: body.metadata || before?.metadata || {}, createdBy: before?.createdBy || user.id,
      });
      const saved = await repository.save(record);
      await this.audit.write(user.id, merchantId, before ? 'OPERATIONAL_LEDGER_UPDATED' : 'OPERATIONAL_LEDGER_CREATED', 'OperationalLedgerEntry', saved.id, this.snapshot(before), this.snapshot(saved), manager);
      return saved;
    });
  }

  async listSettings(user: User, merchantId: string, type: MerchantSettingType) {
    await this.authorize(user, merchantId);
    return this.settings.find({ where: { merchantId, type }, order: { sortOrder: 'ASC', updatedAt: 'DESC', id: 'DESC' } });
  }

  async saveSetting(user: User, merchantId: string, body: SaveMerchantBusinessSettingDto) {
    await this.authorize(user, merchantId);
    return this.dataSource.transaction(async (manager) => {
      const repository = manager.getRepository(MerchantBusinessSetting);
      const before = body.id ? await repository.findOneBy({ id: body.id, merchantId, type: body.type }) : null;
      if (body.id && !before) throw new NotFoundException('配置记录不存在');
      const record = repository.create({
        ...(before || {}), merchantId, type: body.type, name: body.name.trim(), description: body.description?.trim() || '',
        config: body.config || before?.config || {}, status: body.status || before?.status || 'ACTIVE', sortOrder: body.sortOrder ?? before?.sortOrder ?? 0,
      });
      const saved = await repository.save(record);
      await this.audit.write(user.id, merchantId, before ? 'MERCHANT_SETTING_UPDATED' : 'MERCHANT_SETTING_CREATED', 'MerchantBusinessSetting', saved.id, this.snapshot(before), this.snapshot(saved), manager);
      return saved;
    });
  }

  /**
   * 删除配置项；若为商品分类（PRODUCT_CATEGORY），同步解除其与商品的关联（商品不被删除，仅从商品 categoryIds 中移除该分类）。
   */
  async deleteSetting(user: User, merchantId: string, id: string): Promise<{ ok: true }> {
    await this.authorize(user, merchantId);
    return this.dataSource.transaction(async (manager) => {
      const repository = manager.getRepository(MerchantBusinessSetting);
      const record = await repository.findOneBy({ id, merchantId });
      if (!record) throw new NotFoundException('配置记录不存在');
      if (record.type === MerchantSettingType.PRODUCT_CATEGORY) {
        const packageRepository = manager.getRepository(DealPackage);
        const linked = await packageRepository.createQueryBuilder('p')
          .where('p."merchantId" = :merchantId AND p."categoryIds" LIKE :like', { merchantId, like: `%${id}%` })
          .getMany();
        for (const pkg of linked) {
          if (Array.isArray(pkg.categoryIds) && pkg.categoryIds.includes(id)) {
            pkg.categoryIds = pkg.categoryIds.filter((categoryId) => categoryId !== id);
            await packageRepository.save(pkg);
          }
        }
      }
      await repository.delete({ id, merchantId });
      await this.audit.write(user.id, merchantId, 'MERCHANT_SETTING_DELETED', 'MerchantBusinessSetting', id, this.snapshot(record), null, manager);
      return { ok: true };
    });
  }

  private validateInventoryDocument(body: SaveInventoryDocumentDto): void {
    const requiresStore = [InventoryDocumentType.PURCHASE, InventoryDocumentType.REQUISITION, InventoryDocumentType.INBOUND, InventoryDocumentType.OUTBOUND, InventoryDocumentType.LOSS, InventoryDocumentType.COUNT].includes(body.type);
    if (requiresStore && !body.storeId) throw new BadRequestException('当前库存单据必须选择门店');
    if (body.type === InventoryDocumentType.TRANSFER) {
      if (!body.sourceStoreId || !body.targetStoreId) throw new BadRequestException('库存调拨必须选择调出和调入门店');
      if (body.sourceStoreId === body.targetStoreId) throw new BadRequestException('调出门店和调入门店不能相同');
    }
    const requiresBatch = [InventoryDocumentType.OUTBOUND, InventoryDocumentType.LOSS, InventoryDocumentType.COUNT, InventoryDocumentType.TRANSFER].includes(body.type);
    body.items.forEach((item) => {
      if (!item.skuCode.trim() || !item.productName.trim()) throw new BadRequestException('库存单据商品信息不能为空');
      if (requiresBatch && !item.batchId) throw new BadRequestException('当前库存单据的每个商品都必须选择库存批次');
      if (body.type !== InventoryDocumentType.COUNT && item.quantity < 1) throw new BadRequestException('单据商品数量必须大于 0');
    });
  }

  private async applyInventoryDocument(repository: Repository<InventoryBatch>, document: InventoryDocument): Promise<void> {
    if ([InventoryDocumentType.PURCHASE, InventoryDocumentType.REQUISITION].includes(document.type)) return;
    for (const item of document.items) {
      if (document.type === InventoryDocumentType.INBOUND) {
        const existing = item.batchId ? await this.lockedBatch(repository, document.merchantId, item.batchId, document.storeId) : null;
        if (existing) {
          existing.quantity += item.quantity;
          existing.unitCostFen = item.unitCostFen;
          existing.version += 1;
          await repository.save(existing);
        } else {
          await repository.save(repository.create({
            merchantId: document.merchantId, packageId: null, storeId: document.storeId, skuCode: item.skuCode,
            productName: item.productName, quantity: item.quantity, reservedQuantity: 0, unitCostFen: item.unitCostFen,
            productionDate: null, expiresAt: null, status: InventoryBatchStatus.NORMAL,
            note: `由入库单 ${document.documentNo} 创建`, version: 1,
          }));
        }
        continue;
      }
      const expectedStoreId = document.type === InventoryDocumentType.TRANSFER ? document.sourceStoreId : document.storeId;
      const source = await this.lockedBatch(repository, document.merchantId, item.batchId || '', expectedStoreId);
      if (document.type === InventoryDocumentType.COUNT) {
        if (item.quantity < source.reservedQuantity) throw new BadRequestException(`盘点数量不能小于已预留数量：${source.productName}`);
        source.quantity = item.quantity;
        source.version += 1;
        await repository.save(source);
        continue;
      }
      if (source.quantity - source.reservedQuantity < item.quantity) throw new BadRequestException(`可用库存不足：${source.productName}`);
      source.quantity -= item.quantity;
      source.version += 1;
      await repository.save(source);
      if (document.type === InventoryDocumentType.TRANSFER) {
        const targetStoreId = document.targetStoreId;
        if (!targetStoreId) throw new BadRequestException('调拨单缺少调入门店');
        const target = await repository.findOne({ where: { merchantId: document.merchantId, storeId: targetStoreId, skuCode: source.skuCode }, lock: { mode: 'pessimistic_write' } });
        if (target) {
          target.quantity += item.quantity;
          target.version += 1;
          await repository.save(target);
        } else {
          await repository.save(repository.create({
            merchantId: document.merchantId, packageId: source.packageId, storeId: targetStoreId,
            skuCode: source.skuCode, productName: source.productName, quantity: item.quantity, reservedQuantity: 0,
            unitCostFen: source.unitCostFen, productionDate: source.productionDate, expiresAt: source.expiresAt,
            status: source.status, note: `由调拨单 ${document.documentNo} 创建`, version: 1,
          }));
        }
      }
    }
  }

  private async lockedBatch(repository: Repository<InventoryBatch>, merchantId: string, batchId: string, expectedStoreId: string | null): Promise<InventoryBatch> {
    const batch = await repository.findOne({ where: { id: batchId, merchantId }, lock: { mode: 'pessimistic_write' } });
    if (!batch) throw new NotFoundException('库存批次不存在');
    if (expectedStoreId && batch.storeId !== expectedStoreId) throw new BadRequestException(`库存批次不属于所选门店：${batch.productName}`);
    return batch;
  }

  private documentNumber(type: InventoryDocumentType): string {
    const prefix = ({ PURCHASE: 'CG', REQUISITION: 'YH', INBOUND: 'RK', OUTBOUND: 'CK', LOSS: 'BS', COUNT: 'PD', TRANSFER: 'DB' } as Record<InventoryDocumentType, string>)[type];
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()).replaceAll('-', '');
    return `${prefix}${day}${randomUUID().replaceAll('-', '').slice(0, 8).toUpperCase()}`;
  }

  private ledgerReference(category: OperationalLedgerCategory): string {
    const prefix = ({ MEMBER_RECHARGE: 'CZ', DISTRIBUTION_COMMISSION: 'YJ', DISTRIBUTION_WITHDRAWAL: 'TX' } as Record<OperationalLedgerCategory, string>)[category];
    return `${prefix}${Date.now()}${randomUUID().replaceAll('-', '').slice(0, 5).toUpperCase()}`;
  }

  private documentSnapshot(value: InventoryDocument | null) {
    return value ? { documentNo: value.documentNo, type: value.type, status: value.status, itemCount: value.items.length, totalQuantity: value.totalQuantity, totalAmountFen: value.totalAmountFen, occurredAt: value.occurredAt } : null;
  }

  private authorize(user: User, merchantId: string) { return this.merchantAccess.getForUser(user, merchantId, PLATFORM_PROFILES); }
  private maskPhone(value: string) {
    const digits = value.replace(/\D/g, '');
    return digits.length >= 7 ? `${digits.slice(0, 3)}****${digits.slice(-4)}` : digits ? '***' : '';
  }
  private snapshot(value: object | null) { return value ? JSON.parse(JSON.stringify(value)) as Record<string, unknown> : null; }
}
