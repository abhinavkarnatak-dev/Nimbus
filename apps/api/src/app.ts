import cookieParser from 'cookie-parser';
import express, { type Express, type Router, type RequestHandler } from 'express';

import type { AppConfig } from './config/load.js';
import { createCorsMiddleware } from './http/middleware/cors.js';
import { createErrorHandler } from './http/middleware/error-handler.js';
import { createNotFoundHandler } from './http/middleware/not-found.js';
import { createRequestContextMiddleware } from './http/middleware/request-context.js';
import { createRequestLogger } from './http/middleware/request-logger.js';
import { createSecurityHeaders } from './http/middleware/security-headers.js';
import { createHealthRouter, type DependencyCheck } from './http/routes/health.js';
import type { Logger } from './logging/logger.js';

export const JSON_BODY_LIMIT = '100kb';

export const RAW_BODY_LIMIT = '1mb';

export const RAW_BODY_PATHS = ['/github/webhook'] as const;

export interface AppDependencies {
  config: AppConfig;
  logger: Logger;
  checks?: readonly DependencyCheck[];
  routers?: readonly Router[];
  attachSession?: RequestHandler;
}

function needsRawBody(path: string): boolean {
  return RAW_BODY_PATHS.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

export function createApp(dependencies: AppDependencies): Express {
  const { config, logger } = dependencies;
  const app = express();

  app.disable('x-powered-by');
  app.disable('etag');
  app.set('trust proxy', config.api.trustProxyHops);
  app.set('query parser', 'simple');

  app.use(createRequestContextMiddleware(config.api.trustProxyHops > 0));
  app.use(createSecurityHeaders(config.isProduction));
  app.use(createCorsMiddleware(config.api.webOrigin));

  const jsonParser = express.json({ limit: JSON_BODY_LIMIT });
  const rawParser = express.raw({ type: '*/*', limit: RAW_BODY_LIMIT });
  app.use((request, response, next) => {
    if (needsRawBody(request.path)) {
      rawParser(request, response, next);
      return;
    }
    jsonParser(request, response, next);
  });

  app.use(cookieParser());
  app.use(createRequestLogger(logger));

  if (dependencies.attachSession !== undefined) {
    app.use(dependencies.attachSession);
  }

  app.use(createHealthRouter({ logger, checks: dependencies.checks ?? [] }));

  for (const router of dependencies.routers ?? []) {
    app.use(router);
  }

  app.use(createNotFoundHandler());
  app.use(createErrorHandler(logger));

  return app;
}
