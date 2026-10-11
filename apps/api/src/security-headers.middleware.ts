import { Injectable, NestMiddleware } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';
import { releaseId } from './runtime-config';

/**
 * Baseline browser protections for every API response. The API intentionally
 * serves no HTML, scripts, or embedded assets, so a deny-by-default CSP is safe.
 */
@Injectable()
export class SecurityHeadersMiddleware implements NestMiddleware {
  // See HealthService: a response header identifies the running process, not
  // the latest mutable process environment value.
  private readonly currentReleaseId = releaseId();

  use(_request: Request, response: Response, next: NextFunction): void {
    response.removeHeader('X-Powered-By');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    response.setHeader('Content-Security-Policy', "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
    // Safe to expose: it contains a validated deployment label, never a
    // commit URL, secret, customer identifier, or environment variable dump.
    response.setHeader('X-Release-Id', this.currentReleaseId);
    // API responses can include session-scoped or tenant-scoped business data.
    // Keep the direct API path as strict as the reverse-proxy path.
    response.setHeader('Cache-Control', 'no-store');
    if (process.env.NODE_ENV === 'production') {
      response.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
    next();
  }
}
