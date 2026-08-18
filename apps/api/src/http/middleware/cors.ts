import type { RequestHandler } from 'express';

export const ALLOWED_METHODS = 'GET,POST,PATCH,DELETE,OPTIONS';
export const ALLOWED_HEADERS = 'Content-Type,X-CSRF-Token,X-Request-Id';
export const EXPOSED_HEADERS = 'X-Request-Id';
export const PREFLIGHT_MAX_AGE_SECONDS = 600;

export function createCorsMiddleware(allowedOrigin: string): RequestHandler {
  return (request, response, next): void => {
    response.setHeader('Vary', 'Origin');

    const origin = request.headers.origin;

    if (origin === undefined) {
      if (request.method === 'OPTIONS') {
        response.status(204).end();
        return;
      }
      next();
      return;
    }

    if (origin !== allowedOrigin) {
      if (request.method === 'OPTIONS') {
        response.status(403).end();
        return;
      }
      next();
      return;
    }

    response.setHeader('Access-Control-Allow-Origin', allowedOrigin);
    response.setHeader('Access-Control-Allow-Credentials', 'true');
    response.setHeader('Access-Control-Expose-Headers', EXPOSED_HEADERS);

    if (request.method === 'OPTIONS') {
      response.setHeader('Access-Control-Allow-Methods', ALLOWED_METHODS);
      response.setHeader('Access-Control-Allow-Headers', ALLOWED_HEADERS);
      response.setHeader('Access-Control-Max-Age', String(PREFLIGHT_MAX_AGE_SECONDS));
      response.status(204).end();
      return;
    }

    next();
  };
}
