import { SecurityHeadersMiddleware } from './security-headers.middleware';

describe('SecurityHeadersMiddleware', () => {
  const originalReleaseId = process.env.RELEASE_ID;

  afterEach(() => {
    if (originalReleaseId === undefined) delete process.env.RELEASE_ID;
    else process.env.RELEASE_ID = originalReleaseId;
  });

  it('returns the safe release identity with every API response', () => {
    process.env.RELEASE_ID = 'security-header-test';
    const middleware = new SecurityHeadersMiddleware();
    const response = { removeHeader: jest.fn(), setHeader: jest.fn() };
    const next = jest.fn();
    middleware.use({} as never, response as never, next);
    expect(response.setHeader).toHaveBeenCalledWith('X-Release-Id', 'security-header-test');
    expect(next).toHaveBeenCalledTimes(1);
  });
});
