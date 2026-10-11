import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { PackageService } from './package.service';
import { MerchantAccessService } from './merchant-access.service';
import { AuditWriterService } from './audit-writer.service';
import { DealPackage, PackageStatus, User, UserRole } from './domain/entities';

/** 商家编辑"已售数量" updateSoldCount 的单元测试（纯 mock，不连数据库） */

function makeService(overrides: {
  packageEntity?: Partial<DealPackage> | null;
  managerFindOne?: () => Promise<Partial<DealPackage> | null>;
  accessError?: unknown;
}) {
  const dataSource = {
    transaction: jest.fn(async (callback: (manager: EntityManager) => Promise<unknown>) => {
      const manager = {
        findOne: jest.fn(async () => overrides.packageEntity ?? overrides.managerFindOne?.() ?? null),
        // 真实签名 save(entityClass, entity)：第二参是实体
        save: jest.fn(async (_cls: unknown, entity: DealPackage) => ({ ...entity })),
      } as unknown as EntityManager;
      return callback(manager);
    }),
  } as unknown as DataSource;
  const merchantAccess = {
    getForUser: jest.fn(async () => {
      if (overrides.accessError) throw overrides.accessError;
    }),
  } as unknown as MerchantAccessService;
  const auditWriter = { write: jest.fn(async () => undefined) } as unknown as AuditWriterService;
  const packageRepo = { findOneByOrFail: jest.fn() } as unknown as Repository<DealPackage>;
  const service = new PackageService(
    dataSource, merchantAccess, auditWriter,
    {} as never, {} as never, packageRepo, {} as never, {} as never, {} as never,
  );
  return { service, dataSource, merchantAccess, auditWriter };
}

const merchantUser = { id: 'u-1', role: UserRole.MERCHANT_ADMIN } as User;
const staffUser = { id: 'u-2', role: UserRole.STORE_STAFF } as User;
const MERCHANT_ID = '11111111-1111-4111-8111-111111111111';
const PACKAGE_ID = '22222222-2222-4222-8222-222222222222';

function basePackage(): Partial<DealPackage> {
  return {
    id: PACKAGE_ID, merchantId: MERCHANT_ID, title: '测试套餐', description: '', priceFen: 9900,
    saleLimit: 100, soldCount: 10, perCustomerLimit: 1, storeIds: [], validFrom: new Date('2026-01-01'),
    validTo: new Date('2026-12-31'), status: PackageStatus.ON_SALE, version: 3,
  } as Partial<DealPackage>;
}

describe('PackageService.updateSoldCount', () => {
  it('拒绝核销员（STORE_STAFF）操作', async () => {
    const { service } = makeService({ packageEntity: basePackage() });
    await expect(service.updateSoldCount(staffUser, MERCHANT_ID, PACKAGE_ID, 20, 3)).rejects.toThrow(ForbiddenException);
  });

  it('拒绝非整数/负数/超上限的已售数量', async () => {
    const { service } = makeService({ packageEntity: basePackage() });
    const merchant = { id: 'u-1', role: UserRole.MERCHANT_ADMIN } as User;
    await expect(service.updateSoldCount(merchant, MERCHANT_ID, PACKAGE_ID, -1, 3)).rejects.toThrow(BadRequestException);
    await expect(service.updateSoldCount(merchant, MERCHANT_ID, PACKAGE_ID, 1.5, 3)).rejects.toThrow(BadRequestException);
    await expect(service.updateSoldCount(merchant, MERCHANT_ID, PACKAGE_ID, 10_000_001, 3)).rejects.toThrow(BadRequestException);
  });

  it('已售数量不能超过总销量上限（saleLimit 联动）', async () => {
    const { service } = makeService({ packageEntity: basePackage() });
    const merchant = { id: 'u-1', role: UserRole.MERCHANT_ADMIN } as User;
    await expect(service.updateSoldCount(merchant, MERCHANT_ID, PACKAGE_ID, 101, 3)).rejects.toThrow(BadRequestException);
  });

  it('套餐不存在返回 404', async () => {
    const { service } = makeService({ packageEntity: null });
    await expect(service.updateSoldCount(merchantUser, MERCHANT_ID, PACKAGE_ID, 20, 3)).rejects.toThrow(NotFoundException);
  });

  it('乐观锁：expectedVersion 不匹配返回 409', async () => {
    const { service } = makeService({ packageEntity: basePackage() });
    await expect(service.updateSoldCount(merchantUser, MERCHANT_ID, PACKAGE_ID, 20, 99)).rejects.toThrow(ConflictException);
  });

  it('正常修改：更新 soldCount、递增版本、写入审计（含前后值）', async () => {
    const { service, auditWriter } = makeService({ packageEntity: basePackage() });
    const saved = await service.updateSoldCount(merchantUser, MERCHANT_ID, PACKAGE_ID, 20, 3);
    expect(saved.soldCount).toBe(20);
    expect(saved.version).toBe(4);
    expect(auditWriter.write).toHaveBeenCalledWith(
      'u-1', MERCHANT_ID, 'PACKAGE_SOLD_COUNT_UPDATED', 'Package', PACKAGE_ID,
      expect.objectContaining({ soldCount: 10 }),
      expect.objectContaining({ soldCount: 20 }),
      expect.anything(),
    );
  });

  it('数值未变化时直接返回，不递增版本、不写审计', async () => {
    const { service, auditWriter } = makeService({ packageEntity: basePackage() });
    const saved = await service.updateSoldCount(merchantUser, MERCHANT_ID, PACKAGE_ID, 10, 3);
    expect(saved.version).toBe(3);
    expect(auditWriter.write).not.toHaveBeenCalled();
  });
});
