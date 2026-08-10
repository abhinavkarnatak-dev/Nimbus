import { createHmac } from 'node:crypto';

import {
  GOOGLE_AUTHORIZE_URL,
  GOOGLE_SCOPES,
  GoogleIdentityError,
  identityFromIdToken,
  type ExchangeRequest,
  type GoogleIdentity,
  type GoogleIdentityProvider,
} from './google-identity.js';

export const FAKE_CLIENT_ID = 'fake-google-client-id.apps.googleusercontent.com';
export const FAKE_CALLBACK_URL = 'http://localhost:4000/auth/google/callback';

export interface FakeIdTokenClaims {
  email: string;
  emailVerified?: boolean;
  subject?: string;
  audience?: string;
  issuer?: string;
  expiresInSeconds?: number;
}

function base64url(value: object): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

export function makeFakeIdToken(claims: FakeIdTokenClaims): string {
  const header = base64url({ alg: 'RS256', typ: 'JWT', kid: 'fake' });
  const payload = base64url({
    iss: claims.issuer ?? 'https://accounts.google.com',
    aud: claims.audience ?? FAKE_CLIENT_ID,
    exp: Math.floor(Date.now() / 1000) + (claims.expiresInSeconds ?? 3_600),
    sub: claims.subject ?? 'google-subject-1',
    email: claims.email,
    email_verified: claims.emailVerified ?? true,
  });
  const signature = createHmac('sha256', 'not-a-real-signing-key')
    .update(`${header}.${payload}`)
    .digest('base64url');

  return `${header}.${payload}.${signature}`;
}

export interface FakeGoogleOptions {
  clientId?: string;
  callbackUrl?: string;
}

export class FakeGoogleIdentityProvider implements GoogleIdentityProvider {
  readonly name = 'google-fake';

  readonly exchanges: ExchangeRequest[] = [];
  readonly authorizeUrls: string[] = [];

  private readonly clientId: string;
  private readonly callbackUrl: string;
  private idTokensByCode = new Map<string, string>();
  private failure: GoogleIdentityError | undefined;

  constructor(options: FakeGoogleOptions = {}) {
    this.clientId = options.clientId ?? FAKE_CLIENT_ID;
    this.callbackUrl = options.callbackUrl ?? FAKE_CALLBACK_URL;
  }

  authorizeUrl(options: { state: string; codeChallenge: string }): string {
    const url = new URL(GOOGLE_AUTHORIZE_URL);

    url.searchParams.set('client_id', this.clientId);
    url.searchParams.set('redirect_uri', this.callbackUrl);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', GOOGLE_SCOPES);
    url.searchParams.set('state', options.state);
    url.searchParams.set('code_challenge', options.codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');

    const built = url.toString();
    this.authorizeUrls.push(built);
    return built;
  }

  async exchange(request: ExchangeRequest): Promise<GoogleIdentity> {
    this.exchanges.push(request);
    await Promise.resolve();

    if (this.failure !== undefined) {
      throw this.failure;
    }

    const idToken = this.idTokensByCode.get(request.code);
    if (idToken === undefined) {
      throw new GoogleIdentityError(
        'GOOGLE_EXCHANGE_FAILED',
        'We could not finish signing you in with Google.',
      );
    }

    return identityFromIdToken(idToken, this.clientId);
  }

  willReturn(code: string, claims: FakeIdTokenClaims): void {
    this.idTokensByCode.set(code, makeFakeIdToken(claims));
  }

  willReturnRawToken(code: string, idToken: string): void {
    this.idTokensByCode.set(code, idToken);
  }

  willFail(error: GoogleIdentityError): void {
    this.failure = error;
  }

  stopFailing(): void {
    this.failure = undefined;
  }

  reset(): void {
    this.idTokensByCode = new Map();
    this.failure = undefined;
    this.exchanges.length = 0;
    this.authorizeUrls.length = 0;
  }
}
