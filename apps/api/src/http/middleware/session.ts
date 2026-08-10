import type { Request, RequestHandler } from 'express';

import { CSRF_HEADER } from '../../auth/csrf.js';
import type { ActiveSession, CsrfChecker, SessionReader } from '../../auth/session-service.js';
import { attachToRequestContext } from '../../logging/request-context.js';
import { ApiError } from '../api-error.js';
import { sessionCookieName } from '../cookies.js';

const SESSION = Symbol('nimbus.session');

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

interface RequestWithSession extends Request {
  [SESSION]?: ActiveSession;
}

export function readSessionCookie(request: Request, isProduction: boolean): string {
  const jar = request.cookies as Record<string, unknown> | undefined;
  const value = jar?.[sessionCookieName(isProduction)];

  return typeof value === 'string' ? value : '';
}

export function currentSession(request: Request): ActiveSession | undefined {
  return (request as RequestWithSession)[SESSION];
}

export function requireSession(request: Request): ActiveSession {
  const session = currentSession(request);

  if (session === undefined) {
    throw new ApiError('UNAUTHENTICATED', 'You need to sign in to do that.');
  }
  return session;
}

export function createAttachSession(
  sessions: SessionReader,
  isProduction: boolean,
): RequestHandler {
  return (request, _response, next): void => {
    const sessionId = readSessionCookie(request, isProduction);

    if (sessionId === '') {
      next();
      return;
    }

    sessions.load(sessionId).then(
      (session) => {
        if (session !== null) {
          (request as RequestWithSession)[SESSION] = session;
          attachToRequestContext({ userId: session.user.userId });
        }
        next();
      },
      (error: unknown) => {
        next(error);
      },
    );
  };
}

export function createRequireAuth(): RequestHandler {
  return (request, _response, next): void => {
    if (currentSession(request) === undefined) {
      next(new ApiError('UNAUTHENTICATED', 'You need to sign in to do that.'));
      return;
    }
    next();
  };
}

export function createRequireCsrf(sessions: CsrfChecker): RequestHandler {
  return (request, _response, next): void => {
    if (SAFE_METHODS.has(request.method)) {
      next();
      return;
    }

    const session = currentSession(request);
    if (session === undefined) {
      next(new ApiError('UNAUTHENTICATED', 'You need to sign in to do that.'));
      return;
    }

    const supplied = request.headers[CSRF_HEADER];
    const token = typeof supplied === 'string' ? supplied : '';

    if (!sessions.csrfMatches(session, token)) {
      next(new ApiError('CSRF_TOKEN_INVALID', 'Your session token is missing or out of date.'));
      return;
    }

    next();
  };
}
