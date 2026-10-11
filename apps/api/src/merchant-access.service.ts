import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Merchant, PlatformAccessProfile, User, UserRole } from './domain/entities';

@Injectable()
export class MerchantAccessService {
  constructor(@InjectRepository(Merchant) private readonly merchants: Repository<Merchant>) {}

  profile(user: User): PlatformAccessProfile {
    if (user.role !== UserRole.PLATFORM_ADMIN) throw new ForbiddenException('仅平台账号可执行此操作');
    // B3：平台职责必须显式授权——去掉"空 profile 默认超级管理员"的 break-glass 口子，
    // 防止未配置职责的平台账号意外获得全权；未配职责视为无权执行平台管理操作
    if (!user.platformAccessProfile) throw new ForbiddenException('平台账号未配置职责，无法执行平台管理操作，请联系系统管理员授权');
    return user.platformAccessProfile;
  }

  requirePlatformAccess(user: User, operation: string, allowedProfiles: PlatformAccessProfile[]): void {
    const profile = this.profile(user);
    if (profile === PlatformAccessProfile.SYSTEM_ADMIN || allowedProfiles.includes(profile)) return;
    const labels: Record<PlatformAccessProfile, string> = {
      [PlatformAccessProfile.SYSTEM_ADMIN]: '系统管理员',
      [PlatformAccessProfile.OPERATIONS]: '平台运营',
      [PlatformAccessProfile.FINANCE]: '平台财务',
      [PlatformAccessProfile.COMPLIANCE]: '平台合规',
      [PlatformAccessProfile.SECURITY]: '平台安全',
    };
    throw new ForbiddenException(`当前平台职责无权${operation}，请由${allowedProfiles.map((item) => labels[item]).join('或')}处理`);
  }

  ensure(user: User, merchant: Merchant, stores?: string[], allowedPlatformProfiles: PlatformAccessProfile[] = []): void {
    if (user.role === UserRole.PLATFORM_ADMIN) {
      this.requirePlatformAccess(user, '访问该商家数据', allowedPlatformProfiles);
      return;
    }
    if (user.role === UserRole.AGENCY_ADMIN && user.agencyId === merchant.agencyId) return;
    if (user.role === UserRole.MERCHANT_ADMIN && user.merchantId === merchant.id) return;
    if (user.role === UserRole.STORE_STAFF && user.merchantId === merchant.id && (!stores || stores.every((id) => user.storeIds?.includes(id)))) return;
    throw new ForbiddenException('无权访问该商家数据');
  }

  async getForUser(user: User, merchantId: string, allowedPlatformProfiles: PlatformAccessProfile[] = []): Promise<Merchant> {
    const merchant = await this.merchants.findOneBy({ id: merchantId });
    if (!merchant) throw new NotFoundException('商家不存在');
    this.ensure(user, merchant, undefined, allowedPlatformProfiles);
    return merchant;
  }
}
