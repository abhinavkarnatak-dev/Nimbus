import type { RequestHandler } from 'express';
import helmet from 'helmet';

export const HSTS_MAX_AGE_SECONDS = 63_072_000;

export function createSecurityHeaders(isProduction: boolean): RequestHandler {
  return helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        'default-src': ["'none'"],
        'frame-ancestors': ["'none'"],
        'base-uri': ["'none'"],
        'form-action': ["'none'"],
        ...(isProduction ? { 'upgrade-insecure-requests': [] } : {}),
      },
    },
    crossOriginEmbedderPolicy: false,
    crossOriginOpenerPolicy: { policy: 'same-origin' },
    crossOriginResourcePolicy: { policy: 'same-site' },
    referrerPolicy: { policy: 'no-referrer' },
    hsts: isProduction
      ? { maxAge: HSTS_MAX_AGE_SECONDS, includeSubDomains: true, preload: false }
      : false,
    xFrameOptions: { action: 'deny' },
    xContentTypeOptions: true,
    xDnsPrefetchControl: { allow: false },
    xPoweredBy: true,
  });
}
