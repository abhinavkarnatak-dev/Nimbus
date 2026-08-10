import { z } from 'zod';

import type { GoogleConfig } from '../config/load.js';
import type { Logger } from '../logging/logger.js';
import { redactValue } from '../logging/redact.js';

export const GOOGLE_AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const GOOGLE_SCOPES = 'openid email';
export const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'] as const;
export const EXCHANGE_TIMEOUT_MS = 10_000;
export const CLOCK_SKEW_SECONDS = 60;

export interface GoogleIdentity {
  email: string;
  emailVerified: boolean;
  subject: string;
}

export interface ExchangeRequest {
  code: string;
  codeVerifier: string;
}

export interface GoogleIdentityProvider {
  readonly name: string;
  authorizeUrl(options: { state: string; codeChallenge: string }): string;
  exchange(request: ExchangeRequest): Promise<GoogleIdentity>;
}

export const GOOGLE_IDENTITY_ERROR_CODES = [
  'GOOGLE_EXCHANGE_FAILED',
  'GOOGLE_TOKEN_MALFORMED',
  'GOOGLE_TOKEN_UNTRUSTED',
  'GOOGLE_EMAIL_UNVERIFIED',
] as const;

export type GoogleIdentityErrorCode = (typeof GOOGLE_IDENTITY_ERROR_CODES)[number];

export class GoogleIdentityError extends Error {
  readonly code: GoogleIdentityErrorCode;

  constructor(code: GoogleIdentityErrorCode, message: string, options: { cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'GoogleIdentityError';
    this.code = code;
  }
}

const IdTokenClaimsSchema = z.object({
  iss: z.string().min(1),
  aud: z.union([z.string(), z.array(z.string())]),
  exp: z.number(),
  sub: z.string().min(1),
  email: z.string().min(1),
  email_verified: z.union([z.boolean(), z.string()]).optional(),
});

export function decodeIdTokenPayload(idToken: string): unknown {
  const parts = idToken.split('.');
  const payload = parts[1];

  if (parts.length !== 3 || payload === undefined || payload === '') {
    throw new GoogleIdentityError('GOOGLE_TOKEN_MALFORMED', 'The identity token is not readable.');
  }

  try {
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch (error) {
    throw new GoogleIdentityError('GOOGLE_TOKEN_MALFORMED', 'The identity token is not readable.', {
      cause: error,
    });
  }
}

function audienceIncludes(audience: string | string[], clientId: string): boolean {
  return Array.isArray(audience) ? audience.includes(clientId) : audience === clientId;
}

function verifiedFlag(value: boolean | string | undefined): boolean {
  if (typeof value === 'boolean') {
    return value;
  }
  return value === 'true';
}

export function identityFromIdToken(
  idToken: string,
  clientId: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): GoogleIdentity {
  const parsed = IdTokenClaimsSchema.safeParse(decodeIdTokenPayload(idToken));

  if (!parsed.success) {
    throw new GoogleIdentityError('GOOGLE_TOKEN_MALFORMED', 'The identity token is not readable.');
  }

  const claims = parsed.data;

  if (!GOOGLE_ISSUERS.includes(claims.iss as (typeof GOOGLE_ISSUERS)[number])) {
    throw new GoogleIdentityError('GOOGLE_TOKEN_UNTRUSTED', 'That sign in could not be trusted.');
  }

  if (!audienceIncludes(claims.aud, clientId)) {
    throw new GoogleIdentityError('GOOGLE_TOKEN_UNTRUSTED', 'That sign in could not be trusted.');
  }

  if (claims.exp + CLOCK_SKEW_SECONDS <= nowSeconds) {
    throw new GoogleIdentityError('GOOGLE_TOKEN_UNTRUSTED', 'That sign in has expired.');
  }

  if (!verifiedFlag(claims.email_verified)) {
    throw new GoogleIdentityError(
      'GOOGLE_EMAIL_UNVERIFIED',
      'Google has not confirmed that address belongs to you.',
    );
  }

  return { email: claims.email, emailVerified: true, subject: claims.sub };
}

export interface GoogleProviderOptions {
  google: GoogleConfig;
  logger: Logger;
  timeoutMs?: number;
}

export class GoogleIdentityAdapter implements GoogleIdentityProvider {
  readonly name = 'google';

  private readonly google: GoogleConfig;
  private readonly logger: Logger;
  private readonly timeoutMs: number;

  constructor(options: GoogleProviderOptions) {
    this.google = options.google;
    this.logger = options.logger;
    this.timeoutMs = options.timeoutMs ?? EXCHANGE_TIMEOUT_MS;
  }

  authorizeUrl(options: { state: string; codeChallenge: string }): string {
    const url = new URL(GOOGLE_AUTHORIZE_URL);

    url.searchParams.set('client_id', this.google.clientId);
    url.searchParams.set('redirect_uri', this.google.callbackUrl);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', GOOGLE_SCOPES);
    url.searchParams.set('state', options.state);
    url.searchParams.set('code_challenge', options.codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');
    url.searchParams.set('access_type', 'online');
    url.searchParams.set('prompt', 'select_account');

    return url.toString();
  }

  async exchange(request: ExchangeRequest): Promise<GoogleIdentity> {
    const body = new URLSearchParams({
      client_id: this.google.clientId,
      client_secret: this.google.clientSecret,
      code: request.code,
      code_verifier: request.codeVerifier,
      grant_type: 'authorization_code',
      redirect_uri: this.google.callbackUrl,
    });

    let idToken: string;

    try {
      const response = await fetch(GOOGLE_TOKEN_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body,
        signal: AbortSignal.timeout(this.timeoutMs),
      });

      if (!response.ok) {
        this.logger.error(
          { provider: this.name, status: response.status },
          'Google refused the code exchange',
        );
        throw new GoogleIdentityError(
          'GOOGLE_EXCHANGE_FAILED',
          'We could not finish signing you in with Google.',
        );
      }

      const payload = (await response.json()) as { id_token?: unknown };

      if (typeof payload.id_token !== 'string') {
        throw new GoogleIdentityError(
          'GOOGLE_TOKEN_MALFORMED',
          'We could not finish signing you in with Google.',
        );
      }
      idToken = payload.id_token;
    } catch (error) {
      if (error instanceof GoogleIdentityError) {
        throw error;
      }
      this.logger.error(
        { provider: this.name, err: redactValue(error) },
        'Could not reach Google to finish signing in',
      );
      throw new GoogleIdentityError(
        'GOOGLE_EXCHANGE_FAILED',
        'We could not finish signing you in with Google.',
        { cause: error },
      );
    }

    return identityFromIdToken(idToken, this.google.clientId);
  }
}
