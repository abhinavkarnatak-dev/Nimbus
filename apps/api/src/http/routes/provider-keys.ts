import {
  LlmProviderSchema,
  ProviderKeysResponseSchema,
  SaveProviderKeyBodySchema,
  type LlmProviderName,
  type ProviderKeysResponse,
} from '@nimbus/contracts';
import { Router } from 'express';

import type { CsrfChecker } from '../../auth/session-service.js';
import { ApiError } from '../api-error.js';
import { createRequireAuth, createRequireCsrf, requireSession } from '../middleware/session.js';
import { validateBody, validatedBody } from '../middleware/validate.js';
import { clientIp } from './auth.js';

export interface ProviderKeyStore {
  list(userId: string): Promise<ProviderKeysResponse>;
  save(input: {
    userId: string;
    provider: LlmProviderName;
    apiKey: string;
    ip: string;
  }): Promise<ProviderKeysResponse>;
  remove(userId: string, provider: LlmProviderName, ip: string): Promise<ProviderKeysResponse>;
}

export interface ProviderKeysRouterOptions {
  keys: ProviderKeyStore;
  sessions: CsrfChecker;
}

function readProvider(value: unknown): LlmProviderName {
  const parsed = LlmProviderSchema.safeParse(value);

  if (!parsed.success) {
    throw new ApiError('NOT_FOUND', 'Nimbus does not know that provider.');
  }
  return parsed.data;
}

export function createProviderKeysRouter(options: ProviderKeysRouterOptions): Router {
  const router = Router();
  const requireAuth = createRequireAuth();
  const requireCsrf = createRequireCsrf(options.sessions);

  router.get('/provider-keys', requireAuth, async (request, response) => {
    const account = requireSession(request);

    response
      .status(200)
      .json(ProviderKeysResponseSchema.parse(await options.keys.list(account.user.userId)));
  });

  router.post(
    '/provider-keys',
    requireAuth,
    requireCsrf,
    validateBody(SaveProviderKeyBodySchema),
    async (request, response) => {
      const account = requireSession(request);
      const body = validatedBody(request, SaveProviderKeyBodySchema);

      const saved = await options.keys.save({
        userId: account.user.userId,
        provider: body.provider,
        apiKey: body.apiKey,
        ip: clientIp(request.ip),
      });

      response.status(200).json(ProviderKeysResponseSchema.parse(saved));
    },
  );

  router.delete('/provider-keys/:provider', requireAuth, requireCsrf, async (request, response) => {
    const account = requireSession(request);
    const provider = readProvider(request.params['provider']);

    const left = await options.keys.remove(account.user.userId, provider, clientIp(request.ip));

    response.status(200).json(ProviderKeysResponseSchema.parse(left));
  });

  return router;
}
