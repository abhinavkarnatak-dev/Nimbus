import {
  LogoutResponseSchema,
  MeResponseSchema,
  OtpRequestBodySchema,
  OtpRequestResponseSchema,
  OtpVerifyBodySchema,
  OtpVerifyResponseSchema,
} from '@nimbus/contracts';
import { Router } from 'express';

import type {
  RequestCodeInput,
  RequestCodeResult,
  VerifyCodeInput,
} from '../../auth/otp-service.js';
import type { SessionIssuer } from '../../auth/session-service.js';
import { clearSessionCookie, setSessionCookie } from '../cookies.js';
import { validateBody, validatedBody } from '../middleware/validate.js';
import {
  createRequireAuth,
  createRequireCsrf,
  readSessionCookie,
  requireSession,
} from '../middleware/session.js';
import type { VerifyCodeResult } from '../../auth/otp-service.js';

export const UNKNOWN_CLIENT_IP = 'unknown';

export interface OtpRequestService {
  requestCode(input: RequestCodeInput): Promise<RequestCodeResult>;
  verifyCode(input: VerifyCodeInput): Promise<VerifyCodeResult>;
}

export interface AuthRouterOptions {
  otp: OtpRequestService;
  sessions: SessionIssuer;
  isProduction: boolean;
}

export function clientIp(ip: string | undefined): string {
  return ip === undefined || ip === '' ? UNKNOWN_CLIENT_IP : ip;
}

export function createAuthRouter(options: AuthRouterOptions): Router {
  const router = Router();
  const requireAuth = createRequireAuth();
  const requireCsrf = createRequireCsrf(options.sessions);

  router.post(
    '/auth/otp/request',
    validateBody(OtpRequestBodySchema),
    async (request, response) => {
      const body = validatedBody(request, OtpRequestBodySchema);

      const result = await options.otp.requestCode({
        email: body.email,
        ip: clientIp(request.ip),
      });

      response.status(202).json(OtpRequestResponseSchema.parse(result));
    },
  );

  router.post('/auth/otp/verify', validateBody(OtpVerifyBodySchema), async (request, response) => {
    const body = validatedBody(request, OtpVerifyBodySchema);

    const outcome = await options.otp.verifyCode({
      requestId: body.requestId,
      email: body.email,
      code: body.code,
      ip: clientIp(request.ip),
    });

    const established = await options.sessions.start(
      outcome.user.userId,
      readSessionCookie(request, options.isProduction),
    );

    setSessionCookie(
      response,
      options.isProduction,
      established.sessionId,
      established.expiresInSeconds,
    );

    const context = await options.sessions.context(outcome.user, established.csrfToken);
    response.status(200).json(OtpVerifyResponseSchema.parse(context));
  });

  router.get('/auth/me', requireAuth, async (request, response) => {
    const session = requireSession(request);
    const context = await options.sessions.context(session.user, session.csrfToken);

    response.status(200).json(MeResponseSchema.parse(context));
  });

  router.post('/auth/logout', requireAuth, requireCsrf, async (request, response) => {
    const session = requireSession(request);

    await options.sessions.end(session.sessionId);
    clearSessionCookie(response, options.isProduction);

    response.status(200).json(LogoutResponseSchema.parse({ loggedOut: true }));
  });

  return router;
}
