import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { AuditLog, PlatformAccessProfile, User, UserRole } from './domain/entities';
import { AuditChainIntegrity, AuditChainService } from './audit-chain.service';
import { AuditOutboxQueueSnapshot, AuditOutboxService } from './audit-outbox.service';
import { MerchantAccessService } from './merchant-access.service';
import type { AuditLogListItem, Paginated, PaginationQuery } from './app-service.core-types';

@Injectable()
export class AuditReadService {
  constructor(
    private readonly merchantAccess: MerchantAccessService,
    private readonly auditChain: AuditChainService,
    private readonly auditOutbox: AuditOutboxService,
    @InjectRepository(AuditLog) private readonly audits: Repository<AuditLog>,
  ) {}

  async listForMerchant(user: User, merchantId: string, query: PaginationQuery = {}): Promise<Paginated<AuditLogListItem>> {
    await this.merchantAccess.getForUser(user, merchantId, [PlatformAccessProfile.SECURITY]);
    if (user.role === UserRole.STORE_STAFF) throw new ForbiddenException('核销员不可查看审计记录');
    const { page, pageSize, offset } = this.pageRequest(query);
    const [items, total] = await this.audits.findAndCount({
      where: { merchantId }, order: { createdAt: 'DESC', id: 'DESC' }, skip: offset, take: pageSize,
    });
    return { items: items.map((record) => this.listItem(record, user)), page, pageSize, total };
  }

  async listForPlatform(user: User, query: PaginationQuery = {}): Promise<Paginated<AuditLogListItem>> {
    this.merchantAccess.requirePlatformAccess(user, '查看平台安全审计', [PlatformAccessProfile.SECURITY]);
    const { page, pageSize, offset } = this.pageRequest(query);
    const [items, total] = await this.audits.findAndCount({
      where: { merchantId: IsNull() }, order: { createdAt: 'DESC', id: 'DESC' }, skip: offset, take: pageSize,
    });
    return { items: items.map((record) => this.listItem(record, user)), page, pageSize, total };
  }

  async integrity(user: User): Promise<AuditChainIntegrity & { outbox: AuditOutboxQueueSnapshot }> {
    this.merchantAccess.requirePlatformAccess(user, '检查审计完整性', [PlatformAccessProfile.SECURITY]);
    const [integrity, outbox] = await Promise.all([this.auditChain.verify(), this.auditOutbox.queueStatus()]);
    if (outbox.quarantined) return { ...integrity, valid: false, reason: integrity.reason || '存在隔离的审计 outbox 事件', outbox };
    return { ...integrity, outbox };
  }

  private pageRequest(query: PaginationQuery): { page: number; pageSize: number; offset: number } {
    const page = this.requiredInteger(query.page ?? 1, '页码', 1, 10_000);
    const pageSize = this.requiredInteger(query.pageSize ?? 25, '每页条数', 1, 100);
    const offset = (page - 1) * pageSize;
    if (offset >= 100_000) throw new BadRequestException('运营列表仅支持浏览最近 100,000 行，请使用受控导出获取更早明细');
    return { page, pageSize, offset };
  }

  private requiredInteger(value: unknown, label: string, min: number, max: number): number {
    const number = Number(value);
    if (!Number.isInteger(number) || number < min || number > max) throw new BadRequestException(`${label}必须为 ${min} 至 ${max} 的整数`);
    return number;
  }

  private listItem(record: AuditLog, user: User): AuditLogListItem {
    const isCustomerAction = record.actorId.startsWith('customer:');
    return {
      id: record.id,
      action: record.action,
      resourceType: record.resourceType,
      resourceId: record.resourceId,
      requestId: record.requestId,
      createdAt: record.createdAt,
      actorId: isCustomerAction ? 'customer' : record.actorId,
      actorRole: isCustomerAction ? 'CUSTOMER' : record.actorRole,
      ...(user.role === UserRole.PLATFORM_ADMIN ? { ipAddress: record.ipAddress, userAgent: record.userAgent } : {}),
    };
  }
}
