import { VERSION_NEUTRAL, VersioningType } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

export const API_V1 = '1' as const;
export const API_LEGACY_PATH = '/api';
export const API_V1_PATH = '/api/v1';
export const API_LEGACY_SUNSET = 'Wed, 21 Jul 2027 00:00:00 GMT';

/** Keep the unversioned surface during the migration window while exposing the first stable URI contract. */
export const API_CONTROLLER_VERSION: Array<string | typeof VERSION_NEUTRAL> = [API_V1, VERSION_NEUTRAL];

export function configureApiVersioning(app: INestApplication): void {
  app.use((request: Request, response: Response, next: NextFunction) => {
    const path = String(request.path || request.url || '').split('?')[0];
    const legacyBusinessPath = path.startsWith(`${API_LEGACY_PATH}/`)
      && !/^\/api\/v\d+(?:\/|$)/.test(path)
      && !path.startsWith(`${API_LEGACY_PATH}/payments/webhooks/`);
    if (legacyBusinessPath) {
      response.setHeader('Deprecation', 'true');
      response.setHeader('Sunset', API_LEGACY_SUNSET);
      response.setHeader('Link', `<${API_V1_PATH}>; rel="successor-version"`);
    }
    next();
  });
  app.enableVersioning({ type: VersioningType.URI, prefix: 'v', defaultVersion: VERSION_NEUTRAL });
}
