import type { IncomingMessage } from 'node:http';

import type { ActiveSession, SessionReader } from '../auth/session-service.js';
import { sessionCookieName } from '../http/cookies.js';

export const HANDSHAKE_REFUSALS = ['wrong_origin', 'no_cookie', 'no_login'] as const;

export type HandshakeRefusal = (typeof HANDSHAKE_REFUSALS)[number];

export const REFUSAL_STATUS: Readonly<Record<HandshakeRefusal, number>> = {
  wrong_origin: 403,
  no_cookie: 401,
  no_login: 401,
};

export interface HandshakeOptions {
  sessions: SessionReader;
  allowedOrigin: string;
  isProduction: boolean;
}

export type HandshakeResult =
  { ok: true; session: ActiveSession } | { ok: false; refusal: HandshakeRefusal };

export function originAllowed(origin: string | undefined, allowed: string): boolean {
  return origin !== undefined && origin === allowed;
}

export function readCookie(header: string | undefined, name: string): string {
  if (header === undefined) {
    return '';
  }

  for (const part of header.split(';')) {
    const at = part.indexOf('=');

    if (at === -1) {
      continue;
    }

    if (part.slice(0, at).trim() === name) {
      return decodeURIComponent(part.slice(at + 1).trim());
    }
  }
  return '';
}

export async function checkHandshake(
  request: IncomingMessage,
  options: HandshakeOptions,
): Promise<HandshakeResult> {
  const origin = request.headers.origin;

  if (!originAllowed(origin, options.allowedOrigin)) {
    return { ok: false, refusal: 'wrong_origin' };
  }

  const sessionId = readCookie(request.headers.cookie, sessionCookieName(options.isProduction));

  if (sessionId === '') {
    return { ok: false, refusal: 'no_cookie' };
  }

  const session = await options.sessions.load(sessionId);

  if (session === null) {
    return { ok: false, refusal: 'no_login' };
  }
  return { ok: true, session };
}
