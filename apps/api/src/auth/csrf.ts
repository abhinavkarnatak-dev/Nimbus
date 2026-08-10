import { createHmac, timingSafeEqual } from 'node:crypto';

export const CSRF_HEADER = 'x-csrf-token';
export const CSRF_KEY_INFO = 'nimbus:csrf:v1';
export const SESSION_KEY_INFO = 'nimbus:session:v1';

export function deriveKey(sessionSecret: string, info: string): Buffer {
  return createHmac('sha256', sessionSecret).update(info).digest();
}

export function hashSessionId(key: Buffer, sessionId: string): string {
  return createHmac('sha256', key).update(sessionId).digest('hex');
}

export function csrfTokenFor(key: Buffer, sessionKey: string): string {
  return createHmac('sha256', key).update(sessionKey).digest('base64url');
}

export function tokensMatch(expected: string, candidate: string): boolean {
  const expectedBytes = Buffer.from(expected, 'utf8');
  const candidateBytes = Buffer.from(candidate, 'utf8');

  if (expectedBytes.length !== candidateBytes.length || expectedBytes.length === 0) {
    return false;
  }
  return timingSafeEqual(expectedBytes, candidateBytes);
}
