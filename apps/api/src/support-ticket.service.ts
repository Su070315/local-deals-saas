import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash } from 'crypto';
import { DataSource, EntityManager, In, Repository } from 'typeorm';
import {
  Merchant, ExceptionRefundApprovalStatus, PlatformAccessProfile, SupportReplyVisibility, SupportTicket, SupportTicketReply,
  SupportTicketSource, SupportTicketStatus, SupportTicketType, User, UserRole, Voucher, VoucherStatus,
} from './domain/entities';
import { AuditWriterService } from './audit-writer.service';
import { MerchantAccessService } from './merchant-access.service';
import { MerchantQueryScopeService } from './merchant-query-scope.service';
import { SensitiveDataService } from './sensitive-data.service';
import { NotificationAudienceService } from './notifications/notification-audience.service';
import { ChinaOperationalCalendar, chinaOperationalCalendar, nextChinaOperationalWorkday } from './runtime-config';
import type { CustomerIdentity, Paginated, SupportTicketListItem, SupportTicketReplyListItem, TransactionListQuery } from './app-service.core-types';

type CustomerSupportTicketListItem = Pick<SupportTicket, 'id' | 'merchantId' | 'voucherId' | 'content' | 'status' | 'resolutionNote' | 'firstResponseDueAt' | 'firstRespondedAt' | 'createdAt' | 'resolvedAt'> & {
  replies: SupportTicketReplyListItem[];
};

@Injectable()
export class SupportTicketService {
  private readonly operationalCalendar: ChinaOperationalCalendar = chinaOperationalCalendar();

  constructor(
    private readonly dataSource: DataSource,
    private readonly merchantAccess: MerchantAccessService,
    private readonly auditWriter: AuditWriterService,
    private readonly sensitiveData: SensitiveDataService,
    private readonly notificationAudience: NotificationAudienceService,
    private readonly merchantScope: MerchantQueryScopeService,
    @InjectRepository(Merchant) private readonly merchants: Repository<Merchant>,
    @InjectRepository(Voucher) private readonly vouchers: Repository<Voucher>,
    @InjectRepository(SupportTicket) private readonly supportTickets: Repository<SupportTicket>,
    @InjectRepository(SupportTicketReply) private readonly supportTicketReplies: Repository<SupportTicketReply>,
  ) {}

  async createSupportTicket(customer: CustomerIdentity, input: { merchantId: string; voucherId?: string; content: string; contactPhone?: string; idempotencyKey?: string }) {
    const merchant = await this.merchants.findOneBy({ id: input.merchantId });
    if (!merchant) throw new NotFoundException('商家不存在');
    const content = this.requiredText(input.content, '问题描述', 1000);
    const contactPhone = this.optionalText(input.contactPhone, '联系电话', 40);
    const idempotencyKey = input.idempotencyKey === undefined ? null : this.requiredText(input.idempotencyKey, '售后提交标识', 128);
    if (idempotencyKey && !/^[A-Za-z0-9_-]{12,128}$/.test(idempotencyKey)) throw new BadRequestException('售后提交标识格式不正确');
    let voucherId: string | null = null;
    if (input.voucherId) {
      const voucher = await this.vouchers.findOneBy({ id: input.voucherId, customerId: customer.id });
      if (!voucher || voucher.merchantId !== merchant.id) throw new NotFoundException('关联券不存在');
      voucherId = voucher.id;
    }
    const requestHash = this.supportTicketRequestHash({ merchantId: merchant.id, voucherId, content });
    try {
      return await this.dataSource.transaction(async (manager) => {
        if (idempotencyKey) {
          const retried = await this.supportTicketForRetry(manager, customer.id, idempotencyKey);
          if (retried) {
            this.assertSameSupportTicketRetry(retried, requestHash);
            return this.customerSupportTicketCreationResult(retried);
          }
        }
        const ticket = await manager.save(SupportTicket, {
          merchantId: merchant.id, customerId: customer.id, source: SupportTicketSource.CUSTOMER, type: SupportTicketType.GENERAL,
          submittedBy: null, voucherId, idempotencyKey, requestHash: idempotencyKey ? requestHash : null,
          contactPhone: this.sensitiveData.encrypt(contactPhone), content, status: SupportTicketStatus.OPEN,
          firstResponseDueAt: this.firstSupportResponseDueAt(), firstRespondedAt: null, firstRespondedBy: null,
          resolutionNote: '', resolvedBy: null, resolvedAt: null,
        });
        await this.auditWriter.write(`customer:${customer.id}`, merchant.id, 'SUPPORT_TICKET_CREATED', 'SupportTicket', ticket.id, null, {
          status: ticket.status, voucherId: ticket.voucherId, firstResponseDueAt: ticket.firstResponseDueAt,
          hasContactPhone: Boolean(contactPhone), idempotentRequest: Boolean(idempotencyKey),
        }, manager);
        await this.notificationAudience.platformAdmins(manager, [PlatformAccessProfile.OPERATIONS], this.notificationAudience.event('SUPPORT_TICKET_CREATED', 'support-ticket-created', merchant.id, 'SupportTicket', ticket.id, { ticketId: ticket.id, merchantId: merchant.id, voucherId: ticket.voucherId, firstResponseDueAt: ticket.firstResponseDueAt }, `support-ticket:${ticket.id}:created`));
        return this.customerSupportTicketCreationResult(ticket);
      });
    } catch (error) {
      if (!idempotencyKey || !this.isUniqueConstraintError(error)) throw error;
      const retried = await this.supportTicketForRetry(this.dataSource.manager, customer.id, idempotencyKey);
      if (!retried) throw error;
      this.assertSameSupportTicketRetry(retried, requestHash);
      return this.customerSupportTicketCreationResult(retried);
    }
  }

  async customerSupportTickets(customer: CustomerIdentity): Promise<CustomerSupportTicketListItem[]> {
    const tickets = await this.supportTickets.find({ where: { customerId: customer.id, source: SupportTicketSource.CUSTOMER }, order: { createdAt: 'DESC' } });
    const replies = tickets.length ? await this.supportTicketReplies.find({ where: { ticketId: In(tickets.map((ticket) => ticket.id)), visibility: SupportReplyVisibility.CUSTOMER }, order: { createdAt: 'ASC' } }) : [];
    const repliesByTicket = new Map<string, SupportTicketReplyListItem[]>();
    for (const reply of replies) {
      const list = repliesByTicket.get(reply.ticketId) || [];
      list.push({ id: reply.id, ticketId: reply.ticketId, authorRole: reply.authorRole, visibility: reply.visibility, content: reply.content, createdAt: reply.createdAt });
      repliesByTicket.set(reply.ticketId, list);
    }
    return tickets.map(({ id, merchantId, voucherId, content, status, resolutionNote, firstResponseDueAt, firstRespondedAt, createdAt, resolvedAt }) => ({
      id, merchantId, voucherId, content, status, resolutionNote, firstResponseDueAt, firstRespondedAt, createdAt, resolvedAt, replies: repliesByTicket.get(id) || [],
    }));
  }

  async listSupportTickets(user: User, query: TransactionListQuery = {}): Promise<Paginated<SupportTicketListItem>> {
    if (user.role === UserRole.STORE_STAFF) throw new ForbiddenException('核销员不可查看售后工单');
    const platformProfile = user.role === UserRole.PLATFORM_ADMIN ? this.merchantAccess.profile(user) : null;
    const { page, pageSize, offset } = this.pageRequest(query);
    const scope = await this.merchantScope.resolve(user, query.merchantId, [PlatformAccessProfile.OPERATIONS, PlatformAccessProfile.FINANCE]);
    const recordsQuery = this.merchantScope.apply(scope, this.supportTickets.createQueryBuilder('ticket'), 'ticket');
    const totalQuery = this.merchantScope.apply(scope, this.supportTickets.createQueryBuilder('ticket'), 'ticket');
    if (platformProfile === PlatformAccessProfile.FINANCE) {
      recordsQuery.andWhere('ticket.source = :ticketSource AND ticket.type = :ticketType', { ticketSource: SupportTicketSource.MERCHANT, ticketType: SupportTicketType.EXCEPTION_REFUND });
      totalQuery.andWhere('ticket.source = :ticketSource AND ticket.type = :ticketType', { ticketSource: SupportTicketSource.MERCHANT, ticketType: SupportTicketType.EXCEPTION_REFUND });
    }
    const [tickets, total] = await Promise.all([
      recordsQuery.orderBy('ticket.createdAt', 'DESC').addOrderBy('ticket.id', 'DESC').skip(offset).take(pageSize).getMany(),
      totalQuery.getCount(),
    ]);
    const replies = tickets.length ? await this.supportTicketReplies.find({ where: { ticketId: In(tickets.map((ticket) => ticket.id)) }, order: { createdAt: 'DESC' } }) : [];
    const replyStats = new Map<string, { count: number; latestAt: Date | null }>();
    for (const reply of replies) {
      const current = replyStats.get(reply.ticketId) || { count: 0, latestAt: null };
      current.count += 1;
      if (!current.latestAt || new Date(reply.createdAt) > new Date(current.latestAt)) current.latestAt = reply.createdAt;
      replyStats.set(reply.ticketId, current);
    }
    return { items: tickets.map((ticket) => this.supportTicketListItem(ticket, user, replyStats.get(ticket.id)?.count || 0, replyStats.get(ticket.id)?.latestAt || null)), page, pageSize, total };
  }

  async createExceptionRefundRequest(user: User, merchantId: string, input: { voucherId: string; content: string }): Promise<SupportTicketListItem> {
    if (user.role !== UserRole.MERCHANT_ADMIN) throw new ForbiddenException('仅商家管理员可提交异常退款申请');
    await this.merchantAccess.getForUser(user, merchantId);
    const content = this.requiredText(input.content, '申请说明', 1000);
    try {
      return await this.dataSource.transaction(async (manager) => {
        const voucher = await manager.findOne(Voucher, { where: { id: input.voucherId, merchantId }, lock: { mode: 'pessimistic_write' } });
        if (!voucher) throw new NotFoundException('关联券不存在');
        if (voucher.status !== VoucherStatus.UNUSED || this.day(voucher.validTo) < this.day()) throw new BadRequestException('仅有效且未使用的券可申请异常退款');
        const existing = await manager.findOneBy(SupportTicket, { merchantId, voucherId: voucher.id, source: SupportTicketSource.MERCHANT, type: SupportTicketType.EXCEPTION_REFUND, status: SupportTicketStatus.OPEN });
        if (existing) throw new BadRequestException('该券已有待处理的异常退款申请');
        const ticket = await manager.save(SupportTicket, {
          merchantId, customerId: null, source: SupportTicketSource.MERCHANT, type: SupportTicketType.EXCEPTION_REFUND,
          submittedBy: user.id, voucherId: voucher.id, contactPhone: '', content, status: SupportTicketStatus.OPEN,
          exceptionRefundApprovalStatus: ExceptionRefundApprovalStatus.PENDING_REVIEW, exceptionRefundApprovedBy: null,
          exceptionRefundApprovalNote: '', exceptionRefundApprovedAt: null, firstResponseDueAt: null,
          firstRespondedAt: null, firstRespondedBy: null, resolutionNote: '', resolvedBy: null, resolvedAt: null,
        });
        await this.auditWriter.write(user.id, merchantId, 'EXCEPTION_REFUND_REQUESTED', 'SupportTicket', ticket.id, null, {
          voucherId: voucher.id, status: ticket.status, type: ticket.type, approvalStatus: ticket.exceptionRefundApprovalStatus,
        }, manager);
        await this.notificationAudience.platformAdmins(manager, [PlatformAccessProfile.FINANCE], this.notificationAudience.event('EXCEPTION_REFUND_REQUESTED', 'exception-refund-requested', merchantId, 'SupportTicket', ticket.id, { ticketId: ticket.id, merchantId, voucherId: voucher.id, approvalStatus: ticket.exceptionRefundApprovalStatus }, `exception-refund:${ticket.id}:requested`));
        return this.supportTicketListItem(ticket, user);
      });
    } catch (error) {
      if (!this.isUniqueConstraintError(error)) throw error;
      const existing = await this.supportTickets.findOneBy({ merchantId, voucherId: input.voucherId, source: SupportTicketSource.MERCHANT, type: SupportTicketType.EXCEPTION_REFUND, status: SupportTicketStatus.OPEN });
      if (!existing) throw error;
      throw new BadRequestException('该券已有待处理的异常退款申请');
    }
  }

  async listSupportTicketReplies(user: User, ticketId: string): Promise<SupportTicketReplyListItem[]> {
    if (user.role === UserRole.STORE_STAFF) throw new ForbiddenException('核销员不可查看售后工单');
    const ticket = await this.supportTickets.findOneBy({ id: ticketId });
    if (!ticket) throw new NotFoundException('售后工单不存在');
    await this.merchantAccess.getForUser(user, ticket.merchantId, [ticket.type === SupportTicketType.EXCEPTION_REFUND ? PlatformAccessProfile.FINANCE : PlatformAccessProfile.OPERATIONS]);
    if (user.role === UserRole.PLATFORM_ADMIN) this.merchantAccess.requirePlatformAccess(user, ticket.type === SupportTicketType.EXCEPTION_REFUND ? '查看异常退款处理记录' : '查看顾客售后回复', [ticket.type === SupportTicketType.EXCEPTION_REFUND ? PlatformAccessProfile.FINANCE : PlatformAccessProfile.OPERATIONS]);
    const replies = await this.supportTicketReplies.find({ where: user.role === UserRole.PLATFORM_ADMIN ? { ticketId } : { ticketId, visibility: SupportReplyVisibility.CUSTOMER }, order: { createdAt: 'ASC' } });
    return replies.map((reply) => ({ id: reply.id, ticketId: reply.ticketId, authorRole: reply.authorRole, visibility: reply.visibility, content: reply.content, createdAt: reply.createdAt }));
  }

  async replySupportTicket(user: User, ticketId: string, content: string): Promise<SupportTicketListItem> {
    if (user.role === UserRole.STORE_STAFF) throw new ForbiddenException('核销员不可处理售后工单');
    const replyContent = this.requiredText(content, '回复内容', 1000);
    return this.dataSource.transaction(async (manager) => {
      const ticket = await manager.findOne(SupportTicket, { where: { id: ticketId }, lock: { mode: 'pessimistic_write' } });
      if (!ticket) throw new NotFoundException('售后工单不存在');
      await this.merchantAccess.getForUser(user, ticket.merchantId, [PlatformAccessProfile.OPERATIONS]);
      if (ticket.type !== SupportTicketType.GENERAL || ticket.source !== SupportTicketSource.CUSTOMER) throw new ForbiddenException('该工单只能由平台按异常流程处理');
      if (user.role === UserRole.PLATFORM_ADMIN) this.merchantAccess.requirePlatformAccess(user, '回复顾客售后', [PlatformAccessProfile.OPERATIONS]);
      if (ticket.status !== SupportTicketStatus.OPEN) throw new BadRequestException('已结案工单不能继续回复');
      const firstResponse = !ticket.firstRespondedAt;
      const reply = await this.appendSupportTicketReply(manager, ticket, user, replyContent, SupportReplyVisibility.CUSTOMER);
      await this.auditWriter.write(user.id, ticket.merchantId, 'SUPPORT_TICKET_REPLIED', 'SupportTicket', ticket.id, null, { replyId: reply.id, firstResponse }, manager);
      if (ticket.customerId) await this.notificationAudience.customerInbox(manager, ticket.customerId, this.notificationAudience.event('SUPPORT_TICKET_REPLIED', 'support-ticket-replied', ticket.merchantId, 'SupportTicket', ticket.id, { ticketId: ticket.id, replyId: reply.id, status: ticket.status }, `support-ticket:${ticket.id}:reply:${reply.id}`));
      return this.supportTicketListItem(ticket, user, 1, reply.createdAt);
    });
  }

  async resolveSupportTicket(user: User, ticketId: string, note: string): Promise<SupportTicketListItem> {
    if (user.role === UserRole.STORE_STAFF) throw new ForbiddenException('核销员不可处理售后工单');
    const resolutionNote = this.requiredText(note, '处理说明', 1000);
    return this.dataSource.transaction(async (manager) => {
      const ticket = await manager.findOne(SupportTicket, { where: { id: ticketId }, lock: { mode: 'pessimistic_write' } });
      if (!ticket) throw new NotFoundException('售后工单不存在');
      await this.merchantAccess.getForUser(user, ticket.merchantId, [PlatformAccessProfile.OPERATIONS]);
      if (ticket.type === SupportTicketType.EXCEPTION_REFUND) throw new ForbiddenException('异常退款申请必须通过独立审批、驳回或执行退款流程处理');
      if (user.role === UserRole.PLATFORM_ADMIN) this.merchantAccess.requirePlatformAccess(user, '结案顾客售后', [PlatformAccessProfile.OPERATIONS]);
      if (ticket.status === SupportTicketStatus.RESOLVED) return this.supportTicketListItem(ticket, user);
      const before = { status: ticket.status, resolutionNote: ticket.resolutionNote, firstRespondedAt: ticket.firstRespondedAt };
      const reply = await this.appendSupportTicketReply(manager, ticket, user, resolutionNote, SupportReplyVisibility.CUSTOMER);
      ticket.status = SupportTicketStatus.RESOLVED;
      ticket.resolutionNote = resolutionNote;
      ticket.resolvedBy = user.id;
      ticket.resolvedAt = new Date();
      const saved = await manager.save(SupportTicket, ticket);
      await this.auditWriter.write(user.id, saved.merchantId, 'SUPPORT_TICKET_RESOLVED', 'SupportTicket', saved.id, before, { status: saved.status, hasResolutionNote: true, replyId: reply.id, firstResponse: Boolean(saved.firstRespondedAt) }, manager);
      if (saved.customerId) await this.notificationAudience.customerInbox(manager, saved.customerId, this.notificationAudience.event('SUPPORT_TICKET_RESOLVED', 'support-ticket-resolved', saved.merchantId, 'SupportTicket', saved.id, { ticketId: saved.id, replyId: reply.id, status: saved.status }, `support-ticket:${saved.id}:resolved`));
      return this.supportTicketListItem(saved, user, 1, reply.createdAt);
    });
  }

  async approveExceptionRefund(user: User, ticketId: string, note: string): Promise<SupportTicketListItem> {
    this.merchantAccess.requirePlatformAccess(user, '审批异常退款', [PlatformAccessProfile.FINANCE]);
    const approvalNote = this.requiredText(note, '审批意见', 1000);
    return this.dataSource.transaction(async (manager) => {
      const ticket = await this.lockExceptionTicket(manager, ticketId, '审批');
      if (ticket.status !== SupportTicketStatus.OPEN || ticket.exceptionRefundApprovalStatus !== ExceptionRefundApprovalStatus.PENDING_REVIEW) throw new BadRequestException('该异常退款申请当前不能审批');
      const before = { status: ticket.status, approvalStatus: ticket.exceptionRefundApprovalStatus };
      ticket.exceptionRefundApprovalStatus = ExceptionRefundApprovalStatus.APPROVED;
      ticket.exceptionRefundApprovedBy = user.id;
      ticket.exceptionRefundApprovalNote = approvalNote;
      ticket.exceptionRefundApprovedAt = new Date();
      const reply = await this.appendSupportTicketReply(manager, ticket, user, approvalNote, SupportReplyVisibility.INTERNAL);
      const saved = await manager.save(SupportTicket, ticket);
      await this.auditWriter.write(user.id, saved.merchantId, 'EXCEPTION_REFUND_APPROVED', 'SupportTicket', saved.id, before, { status: saved.status, approvalStatus: saved.exceptionRefundApprovalStatus, approvedBy: saved.exceptionRefundApprovedBy, replyId: reply.id }, manager);
      await this.notificationAudience.merchantAdmins(manager, saved.merchantId, this.notificationAudience.event('EXCEPTION_REFUND_APPROVED', 'exception-refund-approved', saved.merchantId, 'SupportTicket', saved.id, { ticketId: saved.id, voucherId: saved.voucherId, approvalStatus: saved.exceptionRefundApprovalStatus }, `exception-refund:${saved.id}:approved`));
      return this.supportTicketListItem(saved, user, 1, reply.createdAt);
    });
  }

  async rejectExceptionRefund(user: User, ticketId: string, note: string): Promise<SupportTicketListItem> {
    this.merchantAccess.requirePlatformAccess(user, '驳回异常退款', [PlatformAccessProfile.FINANCE]);
    const rejectionNote = this.requiredText(note, '驳回说明', 1000);
    return this.dataSource.transaction(async (manager) => {
      const ticket = await this.lockExceptionTicket(manager, ticketId, '驳回');
      if (ticket.status !== SupportTicketStatus.OPEN || ticket.exceptionRefundApprovalStatus !== ExceptionRefundApprovalStatus.PENDING_REVIEW) throw new BadRequestException('该异常退款申请当前不能驳回');
      const before = { status: ticket.status, approvalStatus: ticket.exceptionRefundApprovalStatus };
      ticket.exceptionRefundApprovalStatus = ExceptionRefundApprovalStatus.REJECTED;
      ticket.exceptionRefundApprovedBy = user.id;
      ticket.exceptionRefundApprovalNote = rejectionNote;
      ticket.exceptionRefundApprovedAt = new Date();
      ticket.status = SupportTicketStatus.RESOLVED;
      ticket.resolutionNote = '平台已驳回本次异常退款申请。';
      ticket.resolvedBy = user.id;
      ticket.resolvedAt = new Date();
      const reply = await this.appendSupportTicketReply(manager, ticket, user, rejectionNote, SupportReplyVisibility.INTERNAL);
      const saved = await manager.save(SupportTicket, ticket);
      await this.auditWriter.write(user.id, saved.merchantId, 'EXCEPTION_REFUND_REJECTED', 'SupportTicket', saved.id, before, { status: saved.status, approvalStatus: saved.exceptionRefundApprovalStatus, rejectedBy: saved.exceptionRefundApprovedBy, replyId: reply.id }, manager);
      await this.notificationAudience.merchantAdmins(manager, saved.merchantId, this.notificationAudience.event('EXCEPTION_REFUND_REJECTED', 'exception-refund-rejected', saved.merchantId, 'SupportTicket', saved.id, { ticketId: saved.id, voucherId: saved.voucherId, approvalStatus: saved.exceptionRefundApprovalStatus }, `exception-refund:${saved.id}:rejected`));
      return this.supportTicketListItem(saved, user, 1, reply.createdAt);
    });
  }

  async requireApprovedExceptionRefundForRetry(user: User, voucherId: string): Promise<SupportTicket> {
    const ticket = await this.supportTickets.findOneBy({ voucherId, source: SupportTicketSource.MERCHANT, type: SupportTicketType.EXCEPTION_REFUND, status: SupportTicketStatus.OPEN });
    if (!ticket || ticket.exceptionRefundApprovalStatus !== ExceptionRefundApprovalStatus.APPROVED) throw new BadRequestException('异常退款必须先经独立财务审批后才能重新确认');
    if (ticket.exceptionRefundApprovedBy === user.id) throw new ForbiddenException('异常退款的审批人与退款执行人必须为不同财务账号');
    return ticket;
  }

  async prepareApprovedExceptionRefund(user: User, ticketId: string): Promise<SupportTicket> {
    this.merchantAccess.requirePlatformAccess(user, '执行异常退款', [PlatformAccessProfile.FINANCE]);
    return this.dataSource.transaction(async (manager) => {
      const ticket = await this.lockExceptionTicket(manager, ticketId, '执行');
      if (ticket.status !== SupportTicketStatus.OPEN || ticket.exceptionRefundApprovalStatus !== ExceptionRefundApprovalStatus.APPROVED) throw new BadRequestException('该异常退款申请尚未完成独立审批或已处理');
      if (ticket.exceptionRefundApprovedBy === user.id) throw new ForbiddenException('异常退款的审批人与退款执行人必须为不同财务账号');
      return ticket;
    });
  }

  async completeApprovedExceptionRefund(user: User, ticketId: string, executionNote: string): Promise<SupportTicketListItem> {
    return this.dataSource.transaction(async (manager) => {
      const ticket = await this.lockExceptionTicket(manager, ticketId, '完成');
      if (ticket.status !== SupportTicketStatus.OPEN || ticket.exceptionRefundApprovalStatus !== ExceptionRefundApprovalStatus.APPROVED) throw new BadRequestException('该异常退款申请当前不能执行');
      if (ticket.exceptionRefundApprovedBy === user.id) throw new ForbiddenException('异常退款的审批人与退款执行人必须为不同财务账号');
      const before = { status: ticket.status, approvalStatus: ticket.exceptionRefundApprovalStatus };
      ticket.status = SupportTicketStatus.RESOLVED;
      ticket.resolutionNote = '平台已完成本次异常退款处理。';
      ticket.resolvedBy = user.id;
      ticket.resolvedAt = new Date();
      const reply = await this.appendSupportTicketReply(manager, ticket, user, this.requiredText(executionNote, '执行备注', 1000), SupportReplyVisibility.INTERNAL);
      const saved = await manager.save(SupportTicket, ticket);
      await this.auditWriter.write(user.id, saved.merchantId, 'EXCEPTION_REFUND_EXECUTED', 'SupportTicket', saved.id, before, { status: saved.status, approvalStatus: saved.exceptionRefundApprovalStatus, executorId: user.id, replyId: reply.id }, manager);
      await this.notificationAudience.merchantAdmins(manager, saved.merchantId, this.notificationAudience.event('EXCEPTION_REFUND_EXECUTED', 'exception-refund-executed', saved.merchantId, 'SupportTicket', saved.id, { ticketId: saved.id, voucherId: saved.voucherId, status: saved.status }, `exception-refund:${saved.id}:executed`));
      return this.supportTicketListItem(saved, user, 1, reply.createdAt);
    });
  }

  /**
   * 补偿任务（system 上下文）在渠道确认退款成功后结案异常退款工单：
   * recoverStale/retry 兜底路径拿不到审批人 User，用 system 身份直接落 RESOLVED，防工单永卡 OPEN+APPROVED。
   */
  async completeApprovedExceptionRefundBySystem(ticketId: string, executionNote: string): Promise<{ id: string; status: SupportTicketStatus }> {
    return this.dataSource.transaction(async (manager) => {
      const ticket = await this.lockExceptionTicket(manager, ticketId, '完成');
      if (ticket.status !== SupportTicketStatus.OPEN || ticket.exceptionRefundApprovalStatus !== ExceptionRefundApprovalStatus.APPROVED) throw new BadRequestException('该异常退款申请当前不能执行');
      const before = { status: ticket.status, approvalStatus: ticket.exceptionRefundApprovalStatus };
      ticket.status = SupportTicketStatus.RESOLVED;
      ticket.resolutionNote = '平台已完成本次异常退款处理（补偿任务确认）。';
      ticket.resolvedBy = 'system';
      ticket.resolvedAt = new Date();
      await manager.save(SupportTicket, ticket);
      await this.auditWriter.write('system', ticket.merchantId, 'EXCEPTION_REFUND_EXECUTED', 'SupportTicket', ticket.id, before, { status: ticket.status, approvalStatus: ticket.exceptionRefundApprovalStatus, executorId: 'system', note: executionNote }, manager);
      await this.notificationAudience.merchantAdmins(manager, ticket.merchantId, this.notificationAudience.event('EXCEPTION_REFUND_EXECUTED', 'exception-refund-executed', ticket.merchantId, 'SupportTicket', ticket.id, { ticketId: ticket.id, voucherId: ticket.voucherId, status: ticket.status }, `exception-refund:${ticket.id}:executed`));
      return { id: ticket.id, status: ticket.status };
    });
  }

  private async lockExceptionTicket(manager: EntityManager, ticketId: string, action: string): Promise<SupportTicket> {
    const ticket = await manager.findOne(SupportTicket, { where: { id: ticketId }, lock: { mode: 'pessimistic_write' } });
    if (!ticket) throw new NotFoundException('售后工单不存在');
    if (ticket.type !== SupportTicketType.EXCEPTION_REFUND || ticket.source !== SupportTicketSource.MERCHANT || !ticket.voucherId) throw new BadRequestException(`该工单不是商家异常退款申请，不能${action}`);
    return ticket;
  }

  private async appendSupportTicketReply(manager: EntityManager, ticket: SupportTicket, user: User, content: string, visibility: SupportReplyVisibility): Promise<SupportTicketReply> {
    const reply = await manager.save(SupportTicketReply, { ticketId: ticket.id, merchantId: ticket.merchantId, authorId: user.id, authorRole: user.role, visibility, content });
    if (visibility === SupportReplyVisibility.CUSTOMER && !ticket.firstRespondedAt) {
      ticket.firstRespondedAt = reply.createdAt;
      ticket.firstRespondedBy = user.id;
      await manager.save(SupportTicket, ticket);
    }
    return reply;
  }

  private supportTicketListItem(ticket: SupportTicket, user: User, replyCount = 0, latestReplyAt: Date | null = null): SupportTicketListItem {
    const { customerId: _customerId, contactPhone, submittedBy: _submittedBy, idempotencyKey: _idempotencyKey, requestHash: _requestHash, exceptionRefundApprovedBy, exceptionRefundApprovalNote, ...safe } = ticket;
    const canReadExceptionApproval = user.role === UserRole.PLATFORM_ADMIN && [PlatformAccessProfile.SYSTEM_ADMIN, PlatformAccessProfile.FINANCE].includes(this.merchantAccess.profile(user));
    const internalApproval = canReadExceptionApproval ? { exceptionRefundApprovedBy, exceptionRefundApprovalNote } : {};
    const canReadCustomerContact = user.role === UserRole.PLATFORM_ADMIN && [PlatformAccessProfile.SYSTEM_ADMIN, PlatformAccessProfile.OPERATIONS].includes(this.merchantAccess.profile(user));
    return canReadCustomerContact && contactPhone
      ? { ...safe, ...internalApproval, contactPhone: this.sensitiveData.decrypt(contactPhone), replyCount, latestReplyAt }
      : { ...safe, ...internalApproval, replyCount, latestReplyAt };
  }

  private supportTicketRequestHash(input: { merchantId: string; voucherId: string | null; content: string }): string { return createHash('sha256').update(JSON.stringify(input)).digest('hex'); }
  private async supportTicketForRetry(manager: EntityManager, customerId: string, idempotencyKey: string): Promise<SupportTicket | null> {
    return manager.getRepository(SupportTicket).createQueryBuilder('ticket').addSelect(['ticket.idempotencyKey', 'ticket.requestHash']).where('ticket.customerId = :customerId AND ticket.idempotencyKey = :idempotencyKey AND ticket.source = :source', { customerId, idempotencyKey, source: SupportTicketSource.CUSTOMER }).getOne();
  }
  private assertSameSupportTicketRetry(ticket: SupportTicket, requestHash: string): void { if (ticket.requestHash !== requestHash) throw new ConflictException('售后提交标识已用于其他内容，请刷新后重试'); }
  private customerSupportTicketCreationResult(ticket: SupportTicket) { return { id: ticket.id, status: ticket.status, createdAt: ticket.createdAt, firstResponseDueAt: ticket.firstResponseDueAt }; }
  private requiredText(value: unknown, label: string, maxLength = 120): string { if (typeof value !== 'string') throw new BadRequestException(`${label}格式不正确`); const normalized = value.trim(); if (!normalized || normalized.length > maxLength) throw new BadRequestException(`${label}不能为空且不能超过 ${maxLength} 个字符`); return normalized; }
  private optionalText(value: unknown, label: string, maxLength = 500): string { return value === undefined || value === null || value === '' ? '' : this.requiredText(value, label, maxLength); }
  private pageRequest(query: TransactionListQuery): { page: number; pageSize: number; offset: number } { const page = this.requiredInteger(query.page ?? 1, '页码', 1, 10_000); const pageSize = this.requiredInteger(query.pageSize ?? 25, '每页条数', 1, 100); const offset = (page - 1) * pageSize; if (offset >= 100_000) throw new BadRequestException('运营列表仅支持浏览最近 100,000 行，请使用受控导出获取更早明细'); return { page, pageSize, offset }; }
  private requiredInteger(value: unknown, label: string, min: number, max: number): number { const number = Number(value); if (!Number.isInteger(number) || number < min || number > max) throw new BadRequestException(`${label}必须为 ${min} 至 ${max} 的整数`); return number; }
  private day(date: Date | string = new Date()): string { const values = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(date)).filter((part) => part.type !== 'literal').map((part) => [part.type, part.value])); return `${values.year}-${values.month}-${values.day}`; }
  private firstSupportResponseDueAt(createdAt = new Date()): Date { try { const nextWorkday = nextChinaOperationalWorkday(this.day(createdAt), this.operationalCalendar); return new Date(`${nextWorkday}T18:00:00+08:00`); } catch (error) { throw new ServiceUnavailableException(error instanceof Error ? error.message : '售后运营日历不可用'); } }
  private isUniqueConstraintError(error: unknown): boolean { return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === '23505'; }
}
