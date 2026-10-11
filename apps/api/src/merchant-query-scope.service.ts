import { Injectable } from '@nestjs/common';
import { ObjectLiteral, SelectQueryBuilder } from 'typeorm';
import { Merchant, PlatformAccessProfile, User, UserRole } from './domain/entities';
import { MerchantAccessService } from './merchant-access.service';

export type MerchantQueryScope =
  | { kind: 'platform' }
  | { kind: 'agency'; agencyId: string }
  | { kind: 'merchant'; merchantId: string }
  | { kind: 'none' };

/** Applies tenant visibility inside SQL instead of materializing every merchant id in memory. */
@Injectable()
export class MerchantQueryScopeService {
  constructor(private readonly merchantAccess: MerchantAccessService) {}

  async resolve(user: User, merchantId: string | undefined, allowedPlatformProfiles: PlatformAccessProfile[]): Promise<MerchantQueryScope> {
    if (merchantId) {
      const merchant = await this.merchantAccess.getForUser(user, merchantId, allowedPlatformProfiles);
      return { kind: 'merchant', merchantId: merchant.id };
    }
    if (user.role === UserRole.PLATFORM_ADMIN) {
      this.merchantAccess.requirePlatformAccess(user, '查看商家范围', allowedPlatformProfiles);
      return { kind: 'platform' };
    }
    if (user.role === UserRole.AGENCY_ADMIN) return user.agencyId ? { kind: 'agency', agencyId: user.agencyId } : { kind: 'none' };
    return user.merchantId ? { kind: 'merchant', merchantId: user.merchantId } : { kind: 'none' };
  }

  apply<T extends ObjectLiteral>(scope: MerchantQueryScope, query: SelectQueryBuilder<T>, entityAlias: string): SelectQueryBuilder<T> {
    if (scope.kind === 'platform') return query;
    if (scope.kind === 'none') return query.andWhere('1 = 0');
    if (scope.kind === 'merchant') return query.andWhere(`${entityAlias}.merchantId = :scopeMerchantId`, { scopeMerchantId: scope.merchantId });
    return query
      .innerJoin(Merchant, 'scopeMerchant', `scopeMerchant.id = ${entityAlias}.merchantId`)
      .andWhere('scopeMerchant.agencyId = :scopeAgencyId', { scopeAgencyId: scope.agencyId });
  }

  applyMerchant<T extends ObjectLiteral>(scope: MerchantQueryScope, query: SelectQueryBuilder<T>, entityAlias: string): SelectQueryBuilder<T> {
    if (scope.kind === 'platform') return query;
    if (scope.kind === 'none') return query.andWhere('1 = 0');
    if (scope.kind === 'merchant') return query.andWhere(`${entityAlias}.id = :scopeMerchantId`, { scopeMerchantId: scope.merchantId });
    return query.andWhere(`${entityAlias}.agencyId = :scopeAgencyId`, { scopeAgencyId: scope.agencyId });
  }
}
