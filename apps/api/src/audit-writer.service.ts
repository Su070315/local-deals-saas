import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { AuditContextService } from './audit-context';
import { AuditOutboxService } from './audit-outbox.service';

@Injectable()
export class AuditWriterService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly auditContext: AuditContextService,
    private readonly auditOutbox: AuditOutboxService,
  ) {}

  async write(actorId: string, merchantId: string | null, action: string, resourceType: string, resourceId: string, before: Record<string, unknown> | null, after: Record<string, unknown> | null, manager?: EntityManager): Promise<void> {
    const context = this.auditContext.current();
    const enrichedAfter = context?.stepUpVerifiedAt ? { ...(after || {}), stepUpVerifiedAt: context.stepUpVerifiedAt } : after;
    const record = {
      actorId, merchantId, action, resourceType, resourceId, before, after: enrichedAfter,
      requestId: context?.requestId || '', actorRole: context?.actorRole || (actorId === 'system' ? 'SYSTEM' : ''),
      ipAddress: context?.ipAddress || '', userAgent: context?.userAgent || '',
    };
    if (manager) await this.auditOutbox.enqueue(manager, record);
    else await this.dataSource.transaction((transactionManager) => this.auditOutbox.enqueue(transactionManager, record));
  }
}
