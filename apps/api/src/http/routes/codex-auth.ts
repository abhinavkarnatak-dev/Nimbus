import { Router } from 'express';
import { CodexDeviceChallengeSchema, CodexAuthStatusSchema } from '@nimbus/contracts';

import type { CsrfChecker } from '../../auth/session-service.js';
import { ApiError } from '../api-error.js';
import { createRequireAuth, createRequireCsrf, requireSession } from '../middleware/session.js';
import type { CodexAuthService } from '../../llm/codex-auth.js';
import type { Logger } from '../../logging/logger.js';

export function createCodexAuthRouter(options: {
  auth: CodexAuthService;
  sessions: CsrfChecker;
  logger?: Logger;
}): Router {
  const router = Router();
  const requireAuth = createRequireAuth();
  const requireCsrf = createRequireCsrf(options.sessions);

  router.get('/codex-auth', requireAuth, async (request, response) => {
    const account = requireSession(request);
    const connected = await options.auth.connected(account.user.userId);
    options.logger?.debug({ userId: account.user.userId, connected }, 'Codex auth status checked');
    response.status(200).json(CodexAuthStatusSchema.parse({ connected }));
  });
  router.post('/codex-auth/device', requireAuth, requireCsrf, async (request, response) => {
    const account = requireSession(request);
    try {
      response.status(200).json(
        CodexDeviceChallengeSchema.parse(await options.auth.start(account.user.userId)),
      );
    } catch (error) {
      options.logger?.error(
        { userId: account.user.userId, error: String(error) },
        'Codex device login could not be started',
      );
      throw new ApiError('PROVIDER_UNAVAILABLE', 'Codex device login could not be started.');
    }
  });
  router.delete('/codex-auth', requireAuth, requireCsrf, async (request, response) => {
    const account = requireSession(request);
    await options.auth.disconnect(account.user.userId);
    options.logger?.info({ userId: account.user.userId }, 'Codex credentials disconnected by user');
    response.status(204).end();
  });
  return router;
}
