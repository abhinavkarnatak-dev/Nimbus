import { Router } from 'express';
import { CodexDeviceChallengeSchema, CodexAuthStatusSchema } from '@nimbus/contracts';

import type { CsrfChecker } from '../../auth/session-service.js';
import { ApiError } from '../api-error.js';
import { createRequireAuth, createRequireCsrf, requireSession } from '../middleware/session.js';
import type { CodexAuthService } from '../../llm/codex-auth.js';

export function createCodexAuthRouter(options: { auth: CodexAuthService; sessions: CsrfChecker }): Router {
  const router = Router();
  const requireAuth = createRequireAuth();
  const requireCsrf = createRequireCsrf(options.sessions);

  router.get('/codex-auth', requireAuth, async (request, response) => {
    const account = requireSession(request);
    response.status(200).json(
      CodexAuthStatusSchema.parse({ connected: await options.auth.connected(account.user.userId) }),
    );
  });
  router.post('/codex-auth/device', requireAuth, requireCsrf, async (request, response) => {
    const account = requireSession(request);
    try {
      response.status(200).json(
        CodexDeviceChallengeSchema.parse(await options.auth.start(account.user.userId)),
      );
    } catch {
      throw new ApiError('PROVIDER_UNAVAILABLE', 'Codex device login could not be started.');
    }
  });
  router.delete('/codex-auth', requireAuth, requireCsrf, async (request, response) => {
    const account = requireSession(request);
    await options.auth.disconnect(account.user.userId);
    response.status(204).end();
  });
  return router;
}
