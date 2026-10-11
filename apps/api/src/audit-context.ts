import { Injectable, NestMiddleware } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { NextFunction, Request, Response } from 'express';

export type AuditRequestContext = {
  requestId: string;
  ipAddress: string;
  userAgent: string;
  actorRole?: string;
  stepUpVerifiedAt?: string;
};

@Injectable()
export class AuditContextService {
  private readonly storage = new AsyncLocalStorage<AuditRequestContext>();

  run(context: AuditRequestContext, next: () => void): void {
    this.storage.run(context, next);
  }

  current(): AuditRequestContext | undefined {
    return this.storage.getStore();
  }

  setActorRole(actorRole: string): void {
    const context = this.storage.getStore();
    if (context) context.actorRole = actorRole;
  }

  setStepUpVerifiedAt(verifiedAt: Date): void {
    const context = this.storage.getStore();
    if (context) context.stepUpVerifiedAt = verifiedAt.toISOString();
  }
}

@Injectable()
export class AuditContextMiddleware implements NestMiddleware {
  constructor(private readonly auditContext: AuditContextService) {}

  use(request: Request, response: Response, next: NextFunction): void {
    const header = request.headers['x-request-id'];
    const candidate = Array.isArray(header) ? header[0] : header;
    const requestId = candidate && /^[A-Za-z0-9._-]{8,128}$/.test(candidate) ? candidate : randomUUID();
    response.setHeader('X-Request-Id', requestId);
    this.auditContext.run({
      requestId,
      ipAddress: String(request.ip || request.socket.remoteAddress || '').slice(0, 64),
      userAgent: String(request.headers['user-agent'] || '').slice(0, 512),
    }, next);
  }
}
