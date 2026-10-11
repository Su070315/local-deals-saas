import { ConflictException, ForbiddenException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import bcrypt from 'bcryptjs';
import { Repository } from 'typeorm';
import { AuditWriterService } from './audit-writer.service';
import { AuthService } from './auth.service';
import { PlatformAccessProfile, User, UserRole } from './domain/entities';
import { MerchantAccessService } from './merchant-access.service';

@Injectable()
export class DemoIdentityFixtureService {
  constructor(
    private readonly merchantAccess: MerchantAccessService,
    private readonly authService: AuthService,
    private readonly auditWriter: AuditWriterService,
    @InjectRepository(User) private readonly users: Repository<User>,
  ) {}

  async createFinanceUser(requester: User, input: { name: string; email: string; password: string }) {
    return this.createPlatformUser(requester, input, PlatformAccessProfile.FINANCE, 'DEMO_PLATFORM_FINANCE_CREATED');
  }

  async createOperationsUser(requester: User, input: { name: string; email: string; password: string }) {
    return this.createPlatformUser(requester, input, PlatformAccessProfile.OPERATIONS, 'DEMO_PLATFORM_OPERATIONS_CREATED');
  }

  private async createPlatformUser(
    requester: User,
    input: { name: string; email: string; password: string },
    platformAccessProfile: PlatformAccessProfile,
    auditAction: string,
  ) {
    if (this.merchantAccess.profile(requester) !== PlatformAccessProfile.SYSTEM_ADMIN) throw new ForbiddenException('仅平台系统管理员可创建演示职责账号');
    const name = input.name.trim();
    const email = input.email.trim().toLowerCase();
    this.authService.assertPasswordPolicy(input.password, '演示财务初始密码');
    if (await this.users.existsBy({ email })) throw new ConflictException('演示财务账号已存在');
    const created = await this.users.save({
      email,
      name,
      passwordHash: await bcrypt.hash(input.password, 10),
      role: UserRole.PLATFORM_ADMIN,
      platformAccessProfile,
      agencyId: null,
      merchantId: null,
      storeIds: null,
      active: true,
    });
    await this.auditWriter.write(requester.id, null, auditAction, 'User', created.id, null, { platformAccessProfile: created.platformAccessProfile });
    return { id: created.id, email: created.email, name: created.name, role: created.role, platformAccessProfile: created.platformAccessProfile };
  }
}
