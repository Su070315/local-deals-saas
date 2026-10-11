import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AuditWriterService } from './audit-writer.service';
import { BillStatus, InvoiceStatus, Merchant, MonthlyBill, PlatformAccessProfile, User } from './domain/entities';
import { MerchantAccessService } from './merchant-access.service';

export type CreateDemoBillInput = {
  period: string;
  verifiedAmountFen: number;
  serviceFeeFen: number;
};

/** Local-only fixture creation for repeatable browser workflows; never registered in shared runtimes. */
@Injectable()
export class DemoFixtureService {
  constructor(
    private readonly merchantAccess: MerchantAccessService,
    private readonly auditWriter: AuditWriterService,
    @InjectRepository(Merchant) private readonly merchants: Repository<Merchant>,
    @InjectRepository(MonthlyBill) private readonly bills: Repository<MonthlyBill>,
  ) {}

  async createDisputeWindowBill(user: User, merchantId: string, input: CreateDemoBillInput): Promise<MonthlyBill> {
    this.merchantAccess.requirePlatformAccess(user, '创建演示账单夹具', [PlatformAccessProfile.FINANCE]);
    await this.merchantAccess.getForUser(user, merchantId, [PlatformAccessProfile.FINANCE]);
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(input.period)) throw new BadRequestException('账期格式为 YYYY-MM');
    for (const [label, value] of [['核销金额', input.verifiedAmountFen], ['服务费', input.serviceFeeFen]] as const) {
      if (!Number.isSafeInteger(value) || value < 0) throw new BadRequestException(`${label}必须为非负整数分`);
    }
    if (!await this.merchants.existsBy({ id: merchantId })) throw new NotFoundException('商家不存在');
    if (await this.bills.existsBy({ merchantId, period: input.period })) throw new ConflictException('该商家账期已有账单');
    const now = Date.now();
    const bill = await this.bills.save({
      merchantId,
      period: input.period,
      verifiedAmountFen: input.verifiedAmountFen,
      serviceFeeFen: input.serviceFeeFen,
      status: BillStatus.DISPUTE_WINDOW,
      invoiceStatus: InvoiceStatus.PENDING,
      invoiceNumber: null,
      disputeEndsAt: new Date(now + 5 * 86_400_000),
      dueAt: new Date(now + 15 * 86_400_000),
    });
    await this.auditWriter.write(user.id, merchantId, 'DEMO_MONTHLY_BILL_CREATED', 'MonthlyBill', bill.id, null, { period: bill.period, verifiedAmountFen: bill.verifiedAmountFen, serviceFeeFen: bill.serviceFeeFen });
    return bill;
  }
}
