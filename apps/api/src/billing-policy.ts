import { BadRequestException, ConflictException } from '@nestjs/common';
import { createHash } from 'crypto';
import {
  BillDispute,
  BillPaymentConfirmationRequest,
  MonthlyBillGenerationCommand,
} from './domain/entities';

export const BILL_DISPUTE_WINDOW_MS = 5 * 24 * 60 * 60_000;
const BILL_PAYMENT_GRACE_MS = 5 * 24 * 60 * 60_000;

export function billDisputeListItem(dispute: BillDispute) {
  return {
    id: dispute.id,
    billId: dispute.billId,
    status: dispute.status,
    content: dispute.content,
    resolutionNote: dispute.resolutionNote,
    createdAt: dispute.createdAt,
    resolvedAt: dispute.resolvedAt,
  };
}

export function billPaymentConfirmationRequestListItem(request: BillPaymentConfirmationRequest) {
  const { idempotencyKey: _idempotencyKey, requestHash: _requestHash, ...safe } = request;
  return safe;
}

export function monthlyBillGenerationRequestHash(period: string): string {
  return createHash('sha256').update(JSON.stringify({ period })).digest('hex');
}

export function billingPeriodRange(period: string): { start: Date; end: Date } {
  const [year, month] = period.split('-').map(Number);
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  return {
    start: new Date(`${period}-01T00:00:00+08:00`),
    end: new Date(`${nextYear}-${String(nextMonth).padStart(2, '0')}-01T00:00:00+08:00`),
  };
}

export function assertSameMonthlyBillGenerationCommand(command: MonthlyBillGenerationCommand, requestHash: string): void {
  if (command.requestHash !== requestHash) throw new ConflictException('月结生成请求标识已用于其他账期，请刷新后重试');
}

export function billPaymentDueAt(existingDueAt: Date, referenceAt: Date): Date {
  return new Date(Math.max(new Date(existingDueAt).getTime(), referenceAt.getTime() + BILL_PAYMENT_GRACE_MS));
}

export function billPaymentConfirmationRequestHash(input: { billId: string; paymentReference: string; note: string }): string {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex');
}

export function assertSameBillPaymentConfirmationRetry(request: BillPaymentConfirmationRequest, requestHash: string): void {
  if (request.requestHash !== requestHash) throw new ConflictException('收款确认请求标识已用于其他内容，请刷新后重试');
}

export function shanghaiDay(date: Date | string = new Date()): string {
  const values = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(new Date(date))
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value]),
  );
  return `${values.year}-${values.month}-${values.day}`;
}

export function requiredText(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== 'string') throw new BadRequestException(`${label}格式不正确`);
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) throw new BadRequestException(`${label}不能为空且不能超过 ${maxLength} 个字符`);
  return normalized;
}

export function optionalText(value: unknown, label: string, maxLength: number): string {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string') throw new BadRequestException(`${label}格式不正确`);
  const normalized = value.trim();
  if (normalized.length > maxLength) throw new BadRequestException(`${label}不能超过 ${maxLength} 个字符`);
  return normalized;
}

export function isUniqueConstraintError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === '23505';
}
