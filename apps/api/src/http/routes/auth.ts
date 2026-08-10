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
import type { BeginResult, CompleteResult } from '../../auth/google-service.js';
import { bindingCookieName, OAUTH_STATE_TTL_SECONDS } from '../../auth/oauth-state.js';
import type { SessionIssuer } from '../../auth/session-service.js';
import { clearSessionCookie, setSessionCookie } from '../cookies.js';
import { ApiError } from '../api-error.js';
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

export interface GoogleSignInService {
  begin(): Promise<BeginResult>;
  complete(input: {
    code: string;
    state: string;
    bindingValue: string;
    ip: string;
  }): Promise<CompleteResult>;
}

export interface AuthRouterOptions {
  otp: OtpRequestService;
  sessions: SessionIssuer;
  isProduction: boolean;
  google?: GoogleSignInService | undefined;
  webOrigin: string;
}

export const SIGN_IN_LANDING_PATH = '/auth/callback';

export function signInRedirect(webOrigin: string, outcome: string, reason?: string): string {
  const url = new URL(SIGN_IN_LANDING_PATH, webOrigin);
  url.searchParams.set('signin', outcome);
  if (reason !== undefined) {
    url.searchParams.set('reason', reason);
  }
  return url.toString();
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

  router.get('/auth/google', async (request, response) => {
    const google = requireGoogle(options.google);
    const started = await google.begin();

    response.cookie(bindingCookieName(options.isProduction), started.bindingValue, {
      httpOnly: true,
      secure: options.isProduction,
      sameSite: 'lax',
      path: '/',
      maxAge: OAUTH_STATE_TTL_SECONDS * 1000,
    });

    response.redirect(302, started.redirectUrl);
  });

  router.get('/auth/google/callback', async (request, response) => {
    const google = requireGoogle(options.google);
    const bindingCookie = bindingCookieName(options.isProduction);
    const jar = request.cookies as Record<string, unknown> | undefined;
    const bindingValue = typeof jar?.[bindingCookie] === 'string' ? jar[bindingCookie] : '';

    response.clearCookie(bindingCookie, {
      httpOnly: true,
      secure: options.isProduction,
      sameSite: 'lax',
      path: '/',
    });

    const query = request.query as Record<string, unknown>;
    const declined = typeof query['error'] === 'string' ? query['error'] : '';
    if (declined !== '') {
      response.redirect(302, signInRedirect(options.webOrigin, 'cancelled'));
      return;
    }

    const code = typeof query['code'] === 'string' ? query['code'] : '';
    const state = typeof query['state'] === 'string' ? query['state'] : '';

    if (code === '' || state === '') {
      response.redirect(302, signInRedirect(options.webOrigin, 'failed', 'OAUTH_STATE_INVALID'));
      return;
    }

    let outcome: CompleteResult;
    try {
      outcome = await google.complete({ code, state, bindingValue, ip: clientIp(request.ip) });
    } catch (error) {
      if (error instanceof ApiError) {
        response.redirect(302, signInRedirect(options.webOrigin, 'failed', error.code));
        return;
      }
      throw error;
    }

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

    response.redirect(302, signInRedirect(options.webOrigin, 'success'));
  });

  return router;
}

function requireGoogle(google: GoogleSignInService | undefined): GoogleSignInService {
  if (google === undefined) {
    throw new ApiError(
      'PROVIDER_UNAVAILABLE',
      'Signing in with Google is not available on this server.',
    );
  }
  return google;
}
