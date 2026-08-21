import type { CookieOptions, Response } from 'express';

export const SESSION_COOKIE_NAME = 'nimbus_session';
export const SECURE_SESSION_COOKIE_NAME = '__Host-nimbus_session';

export function sessionCookieName(isProduction: boolean): string {
  return isProduction ? SECURE_SESSION_COOKIE_NAME : SESSION_COOKIE_NAME;
}

export function sessionCookieOptions(isProduction: boolean, maxAgeSeconds: number): CookieOptions {
  return {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'lax',
    path: '/',
    maxAge: maxAgeSeconds * 1000,
  };
}

export function setSessionCookie(
  response: Response,
  isProduction: boolean,
  sessionId: string,
  maxAgeSeconds: number,
): void {
  dropQueuedSessionCookie(response, isProduction);

  response.cookie(
    sessionCookieName(isProduction),
    sessionId,
    sessionCookieOptions(isProduction, maxAgeSeconds),
  );
}

export function dropQueuedSessionCookie(response: Response, isProduction: boolean): void {
  const prefix = `${sessionCookieName(isProduction)}=`;
  const queued = response.getHeader('Set-Cookie');

  if (Array.isArray(queued)) {
    response.setHeader(
      'Set-Cookie',
      queued.filter((value) => !value.startsWith(prefix)),
    );
    return;
  }
  if (typeof queued === 'string' && queued.startsWith(prefix)) {
    response.removeHeader('Set-Cookie');
  }
}

export function clearSessionCookie(response: Response, isProduction: boolean): void {
  dropQueuedSessionCookie(response, isProduction);

  response.clearCookie(sessionCookieName(isProduction), {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'lax',
    path: '/',
  });
}
