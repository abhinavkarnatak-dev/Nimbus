import type { RequestHandler } from 'express';

import type { Logger } from '../../logging/logger.js';

const SLOW_REQUEST_MS = 1_000;

export function createRequestLogger(logger: Logger): RequestHandler {
  return (request, response, next): void => {
    const startedAt = process.hrtime.bigint();

    response.on('finish', () => {
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
      const payload = {
        method: request.method,
        path: request.path,
        statusCode: response.statusCode,
        durationMs: Math.round(durationMs),
      };

      if (response.statusCode >= 500) {
        logger.error(payload, 'Request completed');
        return;
      }
      if (response.statusCode >= 400 || durationMs >= SLOW_REQUEST_MS) {
        logger.warn(payload, 'Request completed');
        return;
      }
      logger.info(payload, 'Request completed');
    });

    next();
  };
}
