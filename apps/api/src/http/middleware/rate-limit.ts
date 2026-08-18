import type { Request, RequestHandler } from 'express';

import { alerting } from '../../logging/alerts.js';
import type { Logger } from '../../logging/logger.js';
import type { RateLimitResult } from '../../redis/rate-limit.js';
import { ApiError } from '../api-error.js';

export interface RequestLimiter {
  consume(subject: string, cost?: number): Promise<RateLimitResult>;
}

export type RateLimitSubject = (request: Request) => string;

export interface RateLimitOptions {
  limiter: RequestLimiter;
  subject: RateLimitSubject;
  message: string;
  logger?: Logger;
}

export function allowEveryRequest(): RequestLimiter {
  return {
    consume: async () =>
      await Promise.resolve({ allowed: true, remaining: Number.MAX_SAFE_INTEGER, retryAfterMs: 0 }),
  };
}

export function retryAfterSeconds(retryAfterMs: number): number {
  return Math.max(1, Math.ceil(retryAfterMs / 1000));
}

export function createRateLimit(options: RateLimitOptions): RequestHandler {
  return (request, response, next) => {
    void options.limiter
      .consume(options.subject(request))
      .then((verdict) => {
        if (verdict.allowed) {
          next();
          return;
        }

        const subject = options.subject(request);

        response.setHeader('Retry-After', String(retryAfterSeconds(verdict.retryAfterMs)));
        options.logger?.warn(
          alerting('rate_limited', { subject, path: request.path }),
          'a request was turned away for going over its rate limit',
        );
        next(new ApiError('RATE_LIMITED', options.message));
      })
      .catch((error: unknown) => {
        next(error);
      });
  };
}
