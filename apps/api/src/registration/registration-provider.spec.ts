import { UnavailableRegistrationProvider } from './registration-provider';

describe('RegistrationProvider production boundary', () => {
  it('fails closed until a contracted provider is configured', async () => {
    const provider = new UnavailableRegistrationProvider();
    expect(provider.enabled).toBe(false);
    await expect(provider.submit({ merchantId: '00000000-0000-4000-8000-000000000001', legalSubjectReference: 'controlled-reference', idempotencyKey: 'registration-idempotency' })).rejects.toThrow('尚未签约并启用');
    await expect(provider.query('provider-case')).rejects.toThrow('尚未签约并启用');
  });
});
