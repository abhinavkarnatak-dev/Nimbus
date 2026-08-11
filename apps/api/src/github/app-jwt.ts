import { createSign } from 'node:crypto';

export const JWT_BACKDATE_SECONDS = 60;
export const JWT_LIFETIME_SECONDS = 540;
export const JWT_MAX_LIFETIME_SECONDS = 600;

export interface AppJwtClaims {
  iat: number;
  exp: number;
  iss: string;
}

export class AppJwtError extends Error {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'AppJwtError';
  }
}

function encodeSegment(value: object): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

export function buildAppJwtClaims(
  appId: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): AppJwtClaims {
  const issuedAt = nowSeconds - JWT_BACKDATE_SECONDS;

  return {
    iat: issuedAt,
    exp: issuedAt + JWT_LIFETIME_SECONDS,
    iss: appId,
  };
}

export function createAppJwt(appId: string, privateKeyPem: string, nowSeconds?: number): string {
  const claims = buildAppJwtClaims(appId, nowSeconds);
  const header = encodeSegment({ alg: 'RS256', typ: 'JWT' });
  const payload = encodeSegment(claims);
  const signingInput = `${header}.${payload}`;

  let signature: string;
  try {
    signature = createSign('RSA-SHA256').update(signingInput).sign(privateKeyPem, 'base64url');
  } catch (error) {
    throw new AppJwtError('Could not sign the GitHub App token with the configured key.', {
      cause: error,
    });
  }

  return `${signingInput}.${signature}`;
}
