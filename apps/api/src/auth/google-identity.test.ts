import { describe, expect, it } from 'vitest';

import { FAKE_CLIENT_ID, makeFakeIdToken } from './google-fake.js';
import {
  GOOGLE_SCOPES,
  GoogleIdentityAdapter,
  GoogleIdentityError,
  identityFromIdToken,
} from './google-identity.js';
import {
  bindingMatches,
  codeChallengeFor,
  generateBindingValue,
  generateCodeVerifier,
  hashBindingValue,
} from './oauth-state.js';
import { createTestLogger } from '../http/http.fixtures.js';

function tokenFor(overrides: Parameters<typeof makeFakeIdToken>[0]): string {
  return makeFakeIdToken(overrides);
}

describe('reading an identity token', () => {
  it('accepts an ordinary verified token', () => {
    const identity = identityFromIdToken(tokenFor({ email: 'you@example.com' }), FAKE_CLIENT_ID);

    expect(identity.email).toBe('you@example.com');
    expect(identity.emailVerified).toBe(true);
    expect(identity.subject).toBe('google-subject-1');
  });

  it('refuses a token issued for a different application', () => {
    const token = tokenFor({ email: 'you@example.com', audience: 'someone-elses-client-id' });

    expect(() => identityFromIdToken(token, FAKE_CLIENT_ID)).toThrow(GoogleIdentityError);
  });

  it('refuses a token from the wrong issuer', () => {
    const token = tokenFor({ email: 'you@example.com', issuer: 'https://evil.example.com' });

    try {
      identityFromIdToken(token, FAKE_CLIENT_ID);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as GoogleIdentityError).code).toBe('GOOGLE_TOKEN_UNTRUSTED');
    }
  });

  it('refuses an expired token', () => {
    const token = tokenFor({ email: 'you@example.com', expiresInSeconds: -3_600 });

    try {
      identityFromIdToken(token, FAKE_CLIENT_ID);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as GoogleIdentityError).code).toBe('GOOGLE_TOKEN_UNTRUSTED');
    }
  });

  it('allows a little clock skew rather than failing on the second', () => {
    const token = tokenFor({ email: 'you@example.com', expiresInSeconds: -10 });

    expect(() => identityFromIdToken(token, FAKE_CLIENT_ID)).not.toThrow();
  });

  it('refuses an unverified address', () => {
    const token = tokenFor({ email: 'you@example.com', emailVerified: false });

    try {
      identityFromIdToken(token, FAKE_CLIENT_ID);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as GoogleIdentityError).code).toBe('GOOGLE_EMAIL_UNVERIFIED');
    }
  });

  it('treats a missing verified flag as unverified', () => {
    const payload = Buffer.from(
      JSON.stringify({
        iss: 'https://accounts.google.com',
        aud: FAKE_CLIENT_ID,
        exp: Math.floor(Date.now() / 1000) + 3_600,
        sub: 'google-subject-1',
        email: 'you@example.com',
      }),
      'utf8',
    ).toString('base64url');

    try {
      identityFromIdToken(`header.${payload}.signature`, FAKE_CLIENT_ID);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as GoogleIdentityError).code).toBe('GOOGLE_EMAIL_UNVERIFIED');
    }
  });

  it('accepts the string form of the verified flag that Google sometimes sends', () => {
    const payload = Buffer.from(
      JSON.stringify({
        iss: 'accounts.google.com',
        aud: [FAKE_CLIENT_ID, 'another-audience'],
        exp: Math.floor(Date.now() / 1000) + 3_600,
        sub: 'google-subject-1',
        email: 'you@example.com',
        email_verified: 'true',
      }),
      'utf8',
    ).toString('base64url');

    expect(identityFromIdToken(`header.${payload}.signature`, FAKE_CLIENT_ID).email).toBe(
      'you@example.com',
    );
  });

  it('refuses something that is not a token at all', () => {
    expect(() => identityFromIdToken('not-a-token', FAKE_CLIENT_ID)).toThrow(GoogleIdentityError);
    expect(() => identityFromIdToken('a.b.c', FAKE_CLIENT_ID)).toThrow(GoogleIdentityError);
    expect(() => identityFromIdToken('', FAKE_CLIENT_ID)).toThrow(GoogleIdentityError);
  });

  it('refuses a token missing the claims it needs', () => {
    const payload = Buffer.from(
      JSON.stringify({ iss: 'https://accounts.google.com' }),
      'utf8',
    ).toString('base64url');

    expect(() => identityFromIdToken(`header.${payload}.sig`, FAKE_CLIENT_ID)).toThrow(
      GoogleIdentityError,
    );
  });
});

describe('the authorize url', () => {
  const { logger } = createTestLogger();
  const adapter = new GoogleIdentityAdapter({
    google: {
      clientId: FAKE_CLIENT_ID,
      clientSecret: 'a-secret-that-must-not-appear',
      callbackUrl: 'http://localhost:4000/auth/google/callback',
    },
    logger,
  });

  const built = new URL(adapter.authorizeUrl({ state: 'state-value', codeChallenge: 'challenge' }));

  it('goes to Google with the exact callback we registered', () => {
    expect(built.origin).toBe('https://accounts.google.com');
    expect(built.searchParams.get('redirect_uri')).toBe(
      'http://localhost:4000/auth/google/callback',
    );
  });

  it('asks for the smallest useful set of permissions', () => {
    expect(built.searchParams.get('scope')).toBe(GOOGLE_SCOPES);
    expect(built.searchParams.get('scope')).not.toContain('profile');
  });

  it('uses the authorization code flow with PKCE', () => {
    expect(built.searchParams.get('response_type')).toBe('code');
    expect(built.searchParams.get('code_challenge')).toBe('challenge');
    expect(built.searchParams.get('code_challenge_method')).toBe('S256');
  });

  it('never puts the client secret in the browser', () => {
    expect(built.toString()).not.toContain('a-secret-that-must-not-appear');
  });
});

describe('PKCE', () => {
  it('makes a long verifier and a different challenge', () => {
    const verifier = generateCodeVerifier();
    const challenge = codeChallengeFor(verifier);

    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(challenge).not.toBe(verifier);
  });

  it('produces the same challenge for the same verifier', () => {
    const verifier = generateCodeVerifier();

    expect(codeChallengeFor(verifier)).toBe(codeChallengeFor(verifier));
  });

  it('cannot be reversed back into the verifier', () => {
    const verifier = generateCodeVerifier();

    expect(codeChallengeFor(verifier)).not.toContain(verifier);
  });
});

describe('the browser binding value', () => {
  it('matches only itself', () => {
    const value = generateBindingValue();
    const hash = hashBindingValue(value);

    expect(bindingMatches(hash, value)).toBe(true);
    expect(bindingMatches(hash, generateBindingValue())).toBe(false);
  });

  it('refuses an empty or truncated value', () => {
    const value = generateBindingValue();
    const hash = hashBindingValue(value);

    expect(bindingMatches(hash, '')).toBe(false);
    expect(bindingMatches(hash, value.slice(0, -1))).toBe(false);
  });

  it('stores only a hash, never the value', () => {
    const value = generateBindingValue();

    expect(hashBindingValue(value)).not.toContain(value);
  });
});
