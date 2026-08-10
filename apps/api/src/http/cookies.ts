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
  response.cookie(
    sessionCookieName(isProduction),
    sessionId,
    sessionCookieOptions(isProduction, maxAgeSeconds),
  );
}

export function clearSessionCookie(response: Response, isProduction: boolean): void {
  response.clearCookie(sessionCookieName(isProduction), {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'lax',
    path: '/',
  });
}
