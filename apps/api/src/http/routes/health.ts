import { HealthResponseSchema, ReadinessResponseSchema } from '@nimbus/contracts';
import { Router } from 'express';

import type { Logger } from '../../logging/logger.js';

export const READINESS_CHECK_TIMEOUT_MS = 2_000;

export interface DependencyCheck {
  name: string;
  run: () => Promise<void>;
}

export interface HealthRouterOptions {
  logger: Logger;
  checks: readonly DependencyCheck[];
  timeoutMs?: number;
}

async function runWithTimeout(check: DependencyCheck, timeoutMs: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;

  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${check.name} did not answer within ${String(timeoutMs)}ms`));
    }, timeoutMs);
  });

  try {
    await Promise.race([check.run(), timeout]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

export function createHealthRouter(options: HealthRouterOptions): Router {
  const router = Router();
  const timeoutMs = options.timeoutMs ?? READINESS_CHECK_TIMEOUT_MS;

  router.get('/health', (_request, response) => {
    response.json(
      HealthResponseSchema.parse({ status: 'ok', uptimeSeconds: Math.floor(process.uptime()) }),
    );
  });

  router.get('/ready', async (_request, response) => {
    const failures: string[] = [];

    await Promise.all(
      options.checks.map(async (check) => {
        try {
          await runWithTimeout(check, timeoutMs);
        } catch (error) {
          failures.push(check.name);
          options.logger.warn({ dependency: check.name, err: error }, 'Readiness check failed');
        }
      }),
    );

    const ready = failures.length === 0;
    response
      .status(ready ? 200 : 503)
      .json(ReadinessResponseSchema.parse({ status: ready ? 'ready' : 'not_ready' }));
  });

  return router;
}
