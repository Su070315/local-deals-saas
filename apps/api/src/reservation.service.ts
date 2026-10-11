import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash } from 'crypto';
import { DataSource, Repository } from 'typeorm';
import { Merchant, PlatformAccessProfile, Reservation, ReservationStatus, Store, User, UserRole } from './domain/entities';
import { MerchantAccessService } from './merchant-access.service';
import { AuditWriterService } from './audit-writer.service';

@Injectable()
export class ReservationService {
  constructor(
    private readonly merchantAccess: MerchantAccessService,
    private readonly dataSource: DataSource,
    private readonly auditWriter: AuditWriterService,
    @InjectRepository(Reservation) private readonly reservations: Repository<Reservation>,
  ) {}

  async create(
    merchantId: string,
    customerId: string,
    input: { storeId?: string; storeName?: string; date: string; timeSlot: string; remark?: string; peopleCount?: number; customerName?: string },
    phoneMasked: string,
    idempotencyKey: string,
  ): Promise<Reservation> {
    const suppliedKey = String(idempotencyKey || '').trim();
    const date = String(input.date || '').trim();
    const timeSlot = String(input.timeSlot || '').trim();
    if (!/^\d{4}-(0[1-9]|1[0-2])-([0-2]\d|3[01])$/.test(date)) throw new BadRequestException('预约日期格式不正确');
    if (!/^\d{2}:\d{2}$/.test(timeSlot)) throw new BadRequestException('预约时段格式不正确');
    const peopleCount = Math.min(50, Math.max(1, Number(input.peopleCount) || 1));
    const storeId = String(input.storeId || '').trim();
    const normalized = {
      storeId,
      date,
      timeSlot,
      peopleCount,
      customerName: String(input.customerName || '').trim().slice(0, 80),
      remark: String(input.remark || '').trim().slice(0, 500),
    };
    const requestHash = createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
    const effectiveKey = suppliedKey || `legacy_${requestHash.slice(0, 24)}`;
    if (!/^[A-Za-z0-9_-]{12,128}$/.test(effectiveKey)) throw new BadRequestException('预约请求标识格式不正确');
    return this.dataSource.transaction(async (manager) => {
      const existing = await manager.findOne(Reservation, { where: { merchantId, customerId, idempotencyKey: effectiveKey }, lock: { mode: 'pessimistic_write' } });
      if (existing) {
        if (existing.requestHash && existing.requestHash !== requestHash) throw new BadRequestException('预约请求标识已用于其他内容');
        return existing;
      }
      const merchant = await manager.findOneBy(Merchant, { id: merchantId });
      if (!merchant) throw new NotFoundException('商户不存在');
      const store = storeId ? await manager.findOne(Store, { where: { id: storeId, merchantId } }) : null;
      if (storeId && !store) throw new BadRequestException('所选门店不存在');
      const reservation = await manager.save(Reservation, {
        merchantId,
        customerId,
        idempotencyKey: effectiveKey,
        requestHash,
        customerName: normalized.customerName,
        customerPhone: phoneMasked,
        storeId: store?.id || '',
        storeName: store?.name || '',
        date,
        timeSlot,
        peopleCount,
        remark: normalized.remark,
        status: ReservationStatus.PENDING,
        handledAt: null,
        handledNote: '',
      });
      await this.auditWriter.write(customerId, merchantId, 'RESERVATION_CREATED', 'Reservation', reservation.id, null, { date, timeSlot, storeName: reservation.storeName, peopleCount }, manager);
      return reservation;
    });
  }

  async mine(customerId: string, merchantId: string): Promise<Reservation[]> {
    return this.reservations.find({ where: { customerId, merchantId }, order: { createdAt: 'DESC', id: 'DESC' }, take: 50 });
  }

  async detailForCustomer(customerId: string, reservationId: string, merchantId?: string): Promise<{ reservation: Reservation; timeline: Array<{ action: string; status: string; note: string; at: Date }> }> {
    const reservation = await this.reservations.findOne({ where: { id: reservationId, customerId, ...(merchantId ? { merchantId } : {}) } });
    if (!reservation) throw new NotFoundException('预约不存在');
    const rows = await this.dataSource.manager.query(
      `SELECT "action", "after", "createdAt" FROM "audit_logs" WHERE "resourceType" = 'Reservation' AND "resourceId" = $1 AND "action" IN ('RESERVATION_CREATED', 'RESERVATION_STATUS_UPDATED') ORDER BY "createdAt" ASC`,
      [reservationId],
    );
    const timeline = (rows || []).map((row: { action: string; after: string | null; createdAt: Date }) => {
      let status = '';
      let note = '';
      try {
        const after = typeof row.after === 'string' ? JSON.parse(row.after) : row.after;
        status = String(after?.status || '');
        note = String(after?.note || '');
      } catch { /* malformed audit data should not hide the reservation */ }
      if (row.action === 'RESERVATION_CREATED' && !status) status = ReservationStatus.PENDING;
      return { action: row.action, status, note, at: row.createdAt };
    });
    return { reservation, timeline };
  }

  async listForMerchant(user: User, merchantId: string, query: { status?: string; date?: string; page?: number; pageSize?: number }): Promise<{ items: Reservation[]; total: number }> {
    await this.merchantAccess.getForUser(user, merchantId, [PlatformAccessProfile.OPERATIONS]);
    if (user.role === UserRole.STORE_STAFF) throw new BadRequestException('核销员不可查看预约单');
    const where: Record<string, unknown> = { merchantId };
    const status = String(query.status || '').toUpperCase();
    if (['PENDING', 'CONFIRMED', 'IN_PROGRESS', 'CANCELLED', 'COMPLETED'].includes(status)) where.status = status as ReservationStatus;
    if (query.date && /^\d{4}-\d{2}-\d{2}$/.test(String(query.date))) where.date = String(query.date);
    const page = Math.max(1, Number(query.page) || 1);
    const pageSize = Math.min(50, Math.max(1, Number(query.pageSize) || 20));
    const [items, total] = await this.reservations.findAndCount({ where, order: { createdAt: 'DESC', id: 'DESC' }, skip: (page - 1) * pageSize, take: pageSize });
    return { items, total };
  }

  async updateStatus(user: User, merchantId: string, reservationId: string, status: ReservationStatus, note?: string): Promise<Reservation> {
    await this.merchantAccess.getForUser(user, merchantId, [PlatformAccessProfile.OPERATIONS]);
    if (user.role === UserRole.STORE_STAFF) throw new BadRequestException('核销员不可处理预约单');
    const transitions: Record<ReservationStatus, ReservationStatus[]> = {
      [ReservationStatus.PENDING]: [ReservationStatus.CONFIRMED, ReservationStatus.CANCELLED],
      [ReservationStatus.CONFIRMED]: [ReservationStatus.IN_PROGRESS, ReservationStatus.CANCELLED],
      [ReservationStatus.IN_PROGRESS]: [ReservationStatus.COMPLETED],
      [ReservationStatus.CANCELLED]: [],
      [ReservationStatus.COMPLETED]: [],
    };
    if (!Object.values(ReservationStatus).includes(status)) throw new BadRequestException('无效的预约处理状态');
    return this.dataSource.transaction(async (manager) => {
      const reservation = await manager.findOne(Reservation, { where: { id: reservationId, merchantId }, lock: { mode: 'pessimistic_write' } });
      if (!reservation) throw new NotFoundException('预约单不存在');
      if (!transitions[reservation.status]?.includes(status)) throw new BadRequestException('预约状态流转不合法');
      const before = reservation.status;
      reservation.status = status;
      reservation.handledAt = new Date();
      reservation.handledNote = String(note || '').trim().slice(0, 500);
      const saved = await manager.save(Reservation, reservation);
      await this.auditWriter.write(user.id, merchantId, 'RESERVATION_STATUS_UPDATED', 'Reservation', saved.id, { status: before }, { status: saved.status, note: saved.handledNote }, manager);
      return saved;
    });
  }
}
