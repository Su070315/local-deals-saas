import { AgencyCooperationService } from './agency-cooperation.service';
import { Merchant, MerchantRegistration, PublicationEntitlementStatus } from './domain/entities';
import {
  WechatOnboardingEntitlementEventType,
} from './domain/wechat-onboarding-entitlement.entities';

describe('AgencyCooperationService onboarding entitlement events', () => {
  const merchant = { id: 'merchant-1', agencyId: 'agency-1' } as Merchant;
  const registration = {
    id: 'registration-1',
    merchantId: merchant.id,
    publicationEntitlementStatus: PublicationEntitlementStatus.NONE,
  } as MerchantRegistration;

  function service() {
    return new AgencyCooperationService({} as never, {} as never, {} as never, {} as never);
  }

  function managerWithInsertResult(identifiers: Array<Record<string, unknown>>) {
    const queryBuilder = {
      insert: jest.fn().mockReturnThis(),
      into: jest.fn().mockReturnThis(),
      values: jest.fn().mockReturnThis(),
      orIgnore: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue({ identifiers }),
    };
    return { manager: { createQueryBuilder: jest.fn(() => queryBuilder) }, queryBuilder };
  }

  it('executes a newly inserted event once and skips duplicate delivery', async () => {
    const first = service();
    const reserve = jest.spyOn(first, 'reserveForSubmission').mockResolvedValue();
    const firstManager = managerWithInsertResult([{ id: 'event-1' }]);

    await expect(first.applyOnboardingEntitlementEvent(
      firstManager.manager as never,
      merchant,
      registration,
      WechatOnboardingEntitlementEventType.STARTED,
    )).resolves.toBe(true);
    expect(reserve).toHaveBeenCalledTimes(1);

    const duplicate = service();
    const duplicateReserve = jest.spyOn(duplicate, 'reserveForSubmission').mockResolvedValue();
    const duplicateManager = managerWithInsertResult([]);

    await expect(duplicate.applyOnboardingEntitlementEvent(
      duplicateManager.manager as never,
      merchant,
      registration,
      WechatOnboardingEntitlementEventType.STARTED,
    )).resolves.toBe(false);
    expect(duplicateReserve).not.toHaveBeenCalled();
  });

  it('propagates entitlement failure so the surrounding transaction can roll back', async () => {
    const instance = service();
    const failure = new Error('quota unavailable');
    jest.spyOn(instance, 'reserveForSubmission').mockRejectedValue(failure);
    const { manager } = managerWithInsertResult([{ id: 'event-1' }]);

    await expect(instance.applyOnboardingEntitlementEvent(
      manager as never,
      merchant,
      registration,
      WechatOnboardingEntitlementEventType.STARTED,
    )).rejects.toBe(failure);
  });
});
