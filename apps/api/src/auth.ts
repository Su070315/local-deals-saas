import {
  CanActivate,
  createParamDecorator,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Request } from 'express';
import jwt from 'jsonwebtoken';
import { Repository } from 'typeorm';
import { AuthSession, User, UserRole } from './domain/entities';
import { AuditContextService } from './audit-context';
import { CUSTOMER_TOKEN_AUDIENCE, OPERATOR_TOKEN_AUDIENCE, TOKEN_ISSUER } from './token-policy';
import { isLocalOrTestEnvironment } from './runtime-config';

export type AuthenticatedRequest = Request & { user: User; sessionId: string; stepUpVerifiedAt?: Date };
export type CustomerAuthenticatedRequest = Request & { customerId: string };
export const Roles = (...roles: UserRole[]) => SetMetadata('roles', roles);
export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext) =>
  (ctx.switchToHttp().getRequest() as AuthenticatedRequest).user,
);

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(@InjectRepository(User) private readonly users: Repository<User>, @InjectRepository(AuthSession) private readonly sessions: Repository<AuthSession>, private readonly auditContext: AuditContextService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const value = request.headers.authorization;
    if (!value?.startsWith('Bearer ')) throw new UnauthorizedException('缺少登录凭证');
    let payload: { sub: string; sid: string; sv: number };
    try {
      payload = jwt.verify(value.slice(7), process.env.JWT_SECRET || 'dev-jwt-secret', { issuer: TOKEN_ISSUER, audience: OPERATOR_TOKEN_AUDIENCE }) as {
        sub: string; sid: string; sv: number;
      };
    } catch {
      throw new UnauthorizedException('登录凭证无效或已过期');
    }
    const user = await this.users.findOneBy({ id: payload.sub });
    if (!user?.active || user.sessionVersion !== payload.sv) throw new UnauthorizedException('会话已失效');
    const session = await this.sessions.findOneBy({ id: payload.sid, userId: user.id });
    if (!session || session.sessionVersion !== user.sessionVersion || session.revokedAt || new Date(session.expiresAt) <= new Date()) throw new UnauthorizedException('会话已失效');
    if (new Date(session.lastSeenAt).getTime() < Date.now() - 5 * 60_000) {
      // FIX: 滑窗续期——仅对长期会话（有效时长 > 24h，网页核销台登录）在剩余 < 7 天时自动延长至 30 天，
      // 实现"核销员扫码一次长期绑定、活跃使用不掉线"；普通 12h 管理端会话不受影响。
      const lifetimeMs = new Date(session.expiresAt).getTime() - new Date(session.createdAt).getTime();
      const remainingMs = new Date(session.expiresAt).getTime() - Date.now();
      if (lifetimeMs > 24 * 60 * 60_000 && remainingMs < 7 * 24 * 60 * 60_000) {
        await this.sessions.update(session.id, { lastSeenAt: new Date(), expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60_000) });
      } else {
        await this.sessions.update(session.id, { lastSeenAt: new Date() });
      }
    }
    request.user = user;
    request.sessionId = session.id;
    // Preserve the historic role label for legacy break-glass accounts while
    // making explicitly scoped platform actions attributable to the exact
    // operational responsibility that authorized them.
    this.auditContext.setActorRole(user.role === UserRole.PLATFORM_ADMIN && user.platformAccessProfile
      ? `${user.role}:${user.platformAccessProfile}`
      : user.role);
    return true;
  }
}

@Injectable()
export class StepUpAuthGuard implements CanActivate {
  constructor(@InjectRepository(AuthSession) private readonly sessions: Repository<AuthSession>, private readonly auditContext: AuditContextService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (isLocalOrTestEnvironment() && process.env.ENFORCE_SENSITIVE_ACTION_STEP_UP !== 'true') return true;
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const session = await this.sessions.findOneBy({ id: request.sessionId, userId: request.user.id });
    const now = new Date();
    const verifiedAt = session?.stepUpVerifiedAt ? new Date(session.stepUpVerifiedAt) : null;
    if (!session || !verifiedAt || now.getTime() - verifiedAt.getTime() > 10 * 60_000) {
      throw new ForbiddenException('此敏感操作需要重新验证当前密码');
    }
    request.stepUpVerifiedAt = verifiedAt;
    this.auditContext.setStepUpVerifiedAt(verifiedAt);
    return true;
  }
}

@Injectable()
export class CustomerAuthGuard implements CanActivate {
  constructor(private readonly auditContext: AuditContextService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<CustomerAuthenticatedRequest>();
    const value = request.headers.authorization;
    if (!value?.startsWith('Bearer ')) throw new UnauthorizedException('缺少顾客登录凭证');
    try {
      const payload = jwt.verify(value.slice(7), process.env.JWT_SECRET || 'dev-jwt-secret', { issuer: TOKEN_ISSUER, audience: CUSTOMER_TOKEN_AUDIENCE }) as { sub?: string; scope?: string };
      if (payload.scope !== 'CUSTOMER' || !payload.sub) throw new Error('invalid customer session');
      request.customerId = payload.sub;
      this.auditContext.setActorRole('CUSTOMER');
      return true;
    } catch {
      throw new UnauthorizedException('顾客登录凭证无效或已过期');
    }
  }
}

@Injectable()
export class RoleGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const required = Reflect.getMetadata('roles', context.getHandler()) as UserRole[] | undefined;
    if (!required?.length) return true;
    const user = (context.switchToHttp().getRequest() as AuthenticatedRequest).user;
    if (!user || !required.includes(user.role)) throw new ForbiddenException('当前角色没有此操作权限');
    return true;
  }
}
