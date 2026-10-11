import { createHash } from 'crypto';
import { BadRequestException, ConflictException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { AuditWriterService } from './audit-writer.service';
import { MerchantAccessService } from './merchant-access.service';
import {
  PlatformAccessProfile, PlatformRuntimeControl, PlatformRuntimeControlCommand, PlatformRuntimeControlStatus, User,
} from './domain/entities';

const SALES_CONTROL_KEY = 'SALES';
type RuntimeControlAction = 'pause' | 'resume-request' | 'resume-approve';

export type PlatformRuntimeControlView = {
  key: string;
  status: PlatformRuntimeControlStatus;
  enabled: boolean;
  reason: string;
  updatedBy: string | null;
  resumeRequestedBy: string | null;
  version: number;
  updatedAt: Date | null;
};

@Injectable()
export class PlatformRuntimeControlService {
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly dataSource: DataSource,
    private readonly auditWriter: AuditWriterService,
    private readonly merchantAccess: MerchantAccessService,
    @InjectRepository(PlatformRuntimeControl) private readonly controls: Repository<PlatformRuntimeControl>,
  ) {}

  async getSalesControl(user: User): Promise<PlatformRuntimeControlView> {
    this.merchantAccess.requirePlatformAccess(user, '查看全局销售控制', [PlatformAccessProfile.OPERATIONS, PlatformAccessProfile.SECURITY]);
    return this.view(await this.controls.findOneBy({ key: SALES_CONTROL_KEY }));
  }

  async assertSalesEnabled(manager: EntityManager): Promise<void> {
    const control = await manager.findOne(PlatformRuntimeControl, { where: { key: SALES_CONTROL_KEY }, lock: { mode: 'pessimistic_read' } });
    if (control && control.status !== PlatformRuntimeControlStatus.ENABLED) {
      throw new ServiceUnavailableException('平台当前已暂停新订单，请稍后再试');
    }
  }

  async pauseSales(user: User, expectedVersion: number, note: string, rawIdempotencyKey?: string): Promise<PlatformRuntimeControlView> {
    this.requireOperator(user, '暂停全局新订单');
    return this.mutate(user, 'pause', expectedVersion, note, rawIdempotencyKey, async (control, manager, normalizedNote) => {
      if (control.status === PlatformRuntimeControlStatus.PAUSED) return null;
      control.reason = normalizedNote;
      control.updatedBy = user.id;
      control.status = PlatformRuntimeControlStatus.PAUSED;
      control.resumeRequestedBy = null;
      return this.persist(control, manager);
    });
  }

  async requestSalesResume(user: User, expectedVersion: number, note: string, rawIdempotencyKey?: string): Promise<PlatformRuntimeControlView> {
    this.requireOperator(user, '申请恢复全局新订单');
    return this.mutate(user, 'resume-request', expectedVersion, note, rawIdempotencyKey, async (control, manager, normalizedNote) => {
      if (control.status === PlatformRuntimeControlStatus.ENABLED) return null;
      if (control.status === PlatformRuntimeControlStatus.RESUME_PENDING) {
        if (control.resumeRequestedBy === user.id) return null;
        throw new ConflictException('已有另一名运营账号提交恢复申请，请由独立账号复核');
      }
      control.reason = normalizedNote;
      control.updatedBy = user.id;
      control.status = PlatformRuntimeControlStatus.RESUME_PENDING;
      control.resumeRequestedBy = user.id;
      return this.persist(control, manager);
    });
  }

  async approveSalesResume(user: User, expectedVersion: number, note: string, rawIdempotencyKey?: string): Promise<PlatformRuntimeControlView> {
    this.requireOperator(user, '复核恢复全局新订单');
    return this.mutate(user, 'resume-approve', expectedVersion, note, rawIdempotencyKey, async (control, manager, normalizedNote) => {
      if (control.status !== PlatformRuntimeControlStatus.RESUME_PENDING || !control.resumeRequestedBy) {
        throw new ConflictException('当前没有待复核的销售恢复申请');
      }
      if (control.resumeRequestedBy === user.id) throw new ConflictException('恢复申请人不能复核自己的申请');
      control.reason = normalizedNote;
      control.updatedBy = user.id;
      control.status = PlatformRuntimeControlStatus.ENABLED;
      control.resumeRequestedBy = null;
      return this.persist(control, manager);
    });
  }

  private async mutate(
    user: User,
    action: RuntimeControlAction,
    expectedVersion: number,
    note: string,
    rawIdempotencyKey: string | undefined,
    operation: (control: PlatformRuntimeControl, manager: EntityManager, note: string) => Promise<PlatformRuntimeControl | null>,
  ): Promise<PlatformRuntimeControlView> {
    const normalizedNote = this.note(note);
    const idempotencyKey = rawIdempotencyKey === undefined ? null : this.requiredKey(rawIdempotencyKey);
    const requestHash = idempotencyKey ? this.commandRequestHash(action, expectedVersion, normalizedNote) : null;
    try {
      return await this.withMutationLock(() => this.dataSource.transaction(async (manager) => {
        let control = await manager.findOne(PlatformRuntimeControl, { where: { key: SALES_CONTROL_KEY }, lock: { mode: 'pessimistic_write' } });
        if (!control) control = manager.create(PlatformRuntimeControl, { key: SALES_CONTROL_KEY, status: PlatformRuntimeControlStatus.ENABLED, reason: '', updatedBy: null, resumeRequestedBy: null, version: 0 });
        if (idempotencyKey && requestHash) {
          const retried = await this.commandForRetry(manager, user.id, idempotencyKey);
          if (retried) {
            this.assertSameCommand(retried, requestHash);
            return this.view(control);
          }
        }
        if (!Number.isInteger(expectedVersion) || expectedVersion < 0 || expectedVersion !== control.version) throw new ConflictException('全局销售状态已更新，请刷新后重试');
        if (idempotencyKey && requestHash) await manager.save(PlatformRuntimeControlCommand, { controlKey: SALES_CONTROL_KEY, requestedBy: user.id, action, expectedVersion, idempotencyKey, requestHash });
        const before = this.snapshot(control);
        const saved = await operation(control, manager, normalizedNote);
        if (!saved) return this.view(control);
        await this.auditWriter.write(user.id, null, saved.status === PlatformRuntimeControlStatus.ENABLED ? 'GLOBAL_SALES_RESUMED' : saved.status === PlatformRuntimeControlStatus.RESUME_PENDING ? 'GLOBAL_SALES_RESUME_REQUESTED' : 'GLOBAL_SALES_PAUSED', 'PlatformRuntimeControl', SALES_CONTROL_KEY, before, this.snapshot(saved), manager);
        return this.view(saved);
      }));
    } catch (error) {
      if (idempotencyKey && requestHash && this.isUniqueConstraintError(error)) {
        const retried = await this.commandForRetry(this.dataSource.manager, user.id, idempotencyKey);
        if (retried) {
          this.assertSameCommand(retried, requestHash);
          return this.view(await this.controls.findOneBy({ key: SALES_CONTROL_KEY }));
        }
      }
      throw error;
    }
  }

  private async persist(control: PlatformRuntimeControl, manager: EntityManager): Promise<PlatformRuntimeControl> {
    control.version += 1;
    return manager.save(PlatformRuntimeControl, control);
  }

  private snapshot(control: PlatformRuntimeControl): Record<string, unknown> {
    return { key: control.key, status: control.status, reason: control.reason, updatedBy: control.updatedBy, resumeRequestedBy: control.resumeRequestedBy, version: control.version };
  }

  private view(control: PlatformRuntimeControl | null): PlatformRuntimeControlView {
    return control ? { ...this.snapshot(control), enabled: control.status === PlatformRuntimeControlStatus.ENABLED, updatedAt: control.updatedAt || null } as PlatformRuntimeControlView
      : { key: SALES_CONTROL_KEY, status: PlatformRuntimeControlStatus.ENABLED, enabled: true, reason: '', updatedBy: null, resumeRequestedBy: null, version: 0, updatedAt: null };
  }

  private requireOperator(user: User, operation: string): void {
    this.merchantAccess.requirePlatformAccess(user, operation, [PlatformAccessProfile.OPERATIONS]);
  }

  private commandRequestHash(action: RuntimeControlAction, expectedVersion: number, note: string): string {
    return createHash('sha256').update(JSON.stringify({ controlKey: SALES_CONTROL_KEY, action, expectedVersion, note })).digest('hex');
  }

  private async commandForRetry(manager: EntityManager, requestedBy: string, idempotencyKey: string): Promise<PlatformRuntimeControlCommand | null> {
    return manager.getRepository(PlatformRuntimeControlCommand).createQueryBuilder('command')
      .addSelect(['command.idempotencyKey', 'command.requestHash'])
      .where('command.controlKey = :controlKey AND command.requestedBy = :requestedBy AND command.idempotencyKey = :idempotencyKey', { controlKey: SALES_CONTROL_KEY, requestedBy, idempotencyKey })
      .getOne();
  }

  private assertSameCommand(command: PlatformRuntimeControlCommand, requestHash: string): void {
    if (command.requestHash !== requestHash) throw new ConflictException('全局销售控制请求标识已用于其他内容，请刷新后重试');
  }

  private requiredKey(value: unknown): string {
    if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{12,128}$/.test(value.trim())) throw new BadRequestException('全局销售控制请求标识格式不正确');
    return value.trim();
  }

  private isUniqueConstraintError(error: unknown): boolean {
    return typeof error === 'object' && error !== null && ('code' in error && (error as { code?: string }).code === '23505' || 'message' in error && /unique|duplicate/i.test(String((error as { message?: unknown }).message)));
  }

  private note(value: unknown): string {
    if (typeof value !== 'string') throw new BadRequestException('操作说明格式不正确');
    const normalized = value.trim();
    if (normalized.length < 3 || normalized.length > 500) throw new BadRequestException('操作说明必须为 3 至 500 个字符');
    return normalized;
  }

  private async withMutationLock<T>(operation: () => Promise<T>): Promise<T> {
    const waiting = this.mutationTail.catch(() => undefined);
    let release: () => void = () => undefined;
    const completed = new Promise<void>((resolve) => { release = resolve; });
    const current = waiting.then(() => completed);
    this.mutationTail = current;
    await waiting;
    try { return await operation(); }
    finally {
      release();
      if (this.mutationTail === current) this.mutationTail = Promise.resolve();
    }
  }
}
