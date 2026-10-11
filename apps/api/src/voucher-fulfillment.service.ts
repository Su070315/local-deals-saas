import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { DealPackage, PlatformAccessProfile, Store, User, Voucher, VoucherStatus } from './domain/entities';
import { AuditWriterService } from './audit-writer.service';
import { MerchantAccessService } from './merchant-access.service';
import { PackageService } from './package.service';
import type { VoucherListItem } from './app-service.core-types';

@Injectable()
export class VoucherFulfillmentService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly auditWriter: AuditWriterService,
    private readonly merchantAccess: MerchantAccessService,
    private readonly packageService: PackageService,
  ) {}

  async transferStore(user: User, voucherId: string, targetStoreId: string): Promise<VoucherListItem> {
    this.merchantAccess.requirePlatformAccess(user, '转移券的核销门店', [PlatformAccessProfile.OPERATIONS]);
    return this.dataSource.transaction((manager) => this.transferStoreWithManager(manager, user.id, voucherId, targetStoreId));
  }

  async transferStoreWithManager(manager: EntityManager, actorId: string, voucherId: string, targetStoreId: string, expectedStoreId?: string, operationId?: string, note?: string): Promise<VoucherListItem> {
    const voucher = await manager.findOne(Voucher, { where: { id: voucherId }, lock: { mode: 'pessimistic_write' } });
    if (!voucher) throw new NotFoundException('券不存在');
    if (expectedStoreId && voucher.storeId !== expectedStoreId) throw new ConflictException('券的当前核销门店已变化，请刷新后重试');
    if (voucher.status !== VoucherStatus.UNUSED || this.day(voucher.validTo) < this.day()) throw new BadRequestException('仅未使用且有效的券可转移门店');
    if (voucher.storeId === targetStoreId) throw new BadRequestException('目标门店与当前核销门店相同');
    const [targetStore, deal] = await Promise.all([
      manager.findOneBy(Store, { id: targetStoreId, merchantId: voucher.merchantId }),
      manager.findOneBy(DealPackage, { id: voucher.packageId, merchantId: voucher.merchantId }),
    ]);
    if (!targetStore?.openForSale || !targetStore.openForVerification) throw new BadRequestException('目标门店不可承接新履约');
    if (!deal) throw new NotFoundException('套餐不存在');
    await this.packageService.assertStoreApplies(manager, deal, targetStore.id);
    const previousStoreId = voucher.storeId;
    voucher.storeId = targetStore.id;
    const saved = await manager.save(Voucher, voucher);
    await this.auditWriter.write(actorId, saved.merchantId, 'VOUCHER_STORE_TRANSFERRED', 'Voucher', saved.id, { storeId: previousStoreId }, { storeId: saved.storeId, targetStoreName: targetStore.name, operationId: operationId || null, note: note || null }, manager);
    return this.listItem(saved);
  }

  private listItem(voucher: Voucher): VoucherListItem {
    const { customerId: _customerId, commissionRateSnapshot: _commissionRateSnapshot, ...safe } = voucher;
    const status = voucher.status === VoucherStatus.UNUSED && this.day(voucher.validTo) < this.day() ? VoucherStatus.EXPIRED : voucher.status;
    return { ...safe, status, refundStatus: null };
  }

  private day(date: Date | string = new Date()): string {
    const values = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(date)).filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
    return `${values.year}-${values.month}-${values.day}`;
  }
}
