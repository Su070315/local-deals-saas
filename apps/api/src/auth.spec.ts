import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { AuthGuard, AuthenticatedRequest } from './auth';
import { UserRole } from './domain/entities';
import { OPERATOR_TOKEN_AUDIENCE, TOKEN_ISSUER } from './token-policy';

describe('AuthGuard failure classification', () => {
  const originalSecret = process.env.JWT_SECRET;

  afterEach(() => {
    if (originalSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = originalSecret;
  });

  function context(authorization: string): ExecutionContext {
    const request = { headers: { authorization } } as unknown as AuthenticatedRequest;
    return { switchToHttp: () => ({ getRequest: () => request }) } as unknown as ExecutionContext;
  }

  function token() {
    process.env.JWT_SECRET = randomBytes(48).toString('base64url');
    return jwt.sign(
      { sub: '11111111-1111-4111-8111-111111111111', sid: '22222222-2222-4222-8222-222222222222', sv: 1 },
      process.env.JWT_SECRET,
      { issuer: TOKEN_ISSUER, audience: OPERATOR_TOKEN_AUDIENCE, expiresIn: '5m' },
    );
  }

  it('returns 401 for an invalid bearer token', async () => {
    const guard = new AuthGuard({ findOneBy: jest.fn() } as never, { findOneBy: jest.fn(), update: jest.fn() } as never, { setActorRole: jest.fn() } as never);
    await expect(guard.canActivate(context('Bearer invalid-token'))).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('does not convert a user repository outage into a 401 response', async () => {
    const databaseError = new Error('database unavailable');
    const guard = new AuthGuard({ findOneBy: jest.fn().mockRejectedValue(databaseError) } as never, { findOneBy: jest.fn(), update: jest.fn() } as never, { setActorRole: jest.fn() } as never);
    await expect(guard.canActivate(context(`Bearer ${token()}`))).rejects.toBe(databaseError);
  });

  it('does not convert a session repository outage into a 401 response', async () => {
    const databaseError = new Error('session store unavailable');
    const user = { id: '11111111-1111-4111-8111-111111111111', active: true, sessionVersion: 1, role: UserRole.PLATFORM_ADMIN };
    const guard = new AuthGuard({ findOneBy: jest.fn().mockResolvedValue(user) } as never, { findOneBy: jest.fn().mockRejectedValue(databaseError), update: jest.fn() } as never, { setActorRole: jest.fn() } as never);
    await expect(guard.canActivate(context(`Bearer ${token()}`))).rejects.toBe(databaseError);
  });
});
