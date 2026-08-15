import {
  ApprovalDecisionBodySchema,
  CancelSessionResponseSchema,
  CreateSessionBodySchema,
  CreateSessionResponseSchema,
  PostMessageBodySchema,
  SessionIdSchema,
} from '@nimbus/contracts';
import { Router } from 'express';

import type { CsrfChecker } from '../../auth/session-service.js';
import type { AgentSessionService } from '../../sessions/service.js';
import { ApiError } from '../api-error.js';
import { createRequireAuth, createRequireCsrf, requireSession } from '../middleware/session.js';
import { validateBody, validatedBody } from '../middleware/validate.js';

export interface SessionsRouterOptions {
  sessions: AgentSessionService;
  auth: CsrfChecker;
}

function readSessionId(value: unknown): string {
  const parsed = SessionIdSchema.safeParse(value);

  if (!parsed.success) {
    throw new ApiError('NOT_FOUND', 'We could not find that session.');
  }
  return parsed.data;
}

export function createSessionsRouter(options: SessionsRouterOptions): Router {
  const router = Router();
  const requireAuth = createRequireAuth();
  const requireCsrf = createRequireCsrf(options.auth);

  router.post(
    '/sessions',
    requireAuth,
    requireCsrf,
    validateBody(CreateSessionBodySchema),
    async (request, response) => {
      const account = requireSession(request);
      const body = validatedBody(request, CreateSessionBodySchema);
      const created = await options.sessions.create(account.user.userId, body);

      response
        .status(created.created ? 201 : 200)
        .json(CreateSessionResponseSchema.parse({ session: created.session }));
    },
  );

  router.get('/sessions', requireAuth, async (request, response) => {
    const account = requireSession(request);

    response.status(200).json(await options.sessions.list(account.user.userId));
  });

  router.get('/sessions/:sessionId', requireAuth, async (request, response) => {
    const account = requireSession(request);
    const sessionId = readSessionId(request.params['sessionId']);

    response.status(200).json(await options.sessions.detail(account.user.userId, sessionId));
  });

  router.post(
    '/sessions/:sessionId/cancel',
    requireAuth,
    requireCsrf,
    async (request, response) => {
      const account = requireSession(request);
      const sessionId = readSessionId(request.params['sessionId']);
      const cancelled = await options.sessions.cancel(account.user.userId, sessionId);

      response.status(200).json(
        CancelSessionResponseSchema.parse({
          sessionId: cancelled.sessionId,
          status: cancelled.status,
        }),
      );
    },
  );

  router.post(
    '/sessions/:sessionId/messages',
    requireAuth,
    requireCsrf,
    validateBody(PostMessageBodySchema),
    async (request, response) => {
      const account = requireSession(request);
      const sessionId = readSessionId(request.params['sessionId']);
      const body = validatedBody(request, PostMessageBodySchema);
      const said = await options.sessions.say(account.user.userId, sessionId, body.message);

      response.status(202).json(CreateSessionResponseSchema.parse({ session: said }));
    },
  );

  router.post(
    '/sessions/:sessionId/answer',
    requireAuth,
    requireCsrf,
    validateBody(PostMessageBodySchema),
    async (request, response) => {
      const account = requireSession(request);
      const sessionId = readSessionId(request.params['sessionId']);
      const body = validatedBody(request, PostMessageBodySchema);
      const answered = await options.sessions.answer(account.user.userId, sessionId, body.message);

      response.status(202).json(CreateSessionResponseSchema.parse({ session: answered }));
    },
  );

  router.post(
    '/sessions/:sessionId/approvals',
    requireAuth,
    requireCsrf,
    validateBody(ApprovalDecisionBodySchema),
    async (request, response) => {
      const account = requireSession(request);
      const sessionId = readSessionId(request.params['sessionId']);
      const body = validatedBody(request, ApprovalDecisionBodySchema);
      const decided = await options.sessions.decide(account.user.userId, sessionId, body);

      response.status(200).json({ approval: decided });
    },
  );

  return router;
}
