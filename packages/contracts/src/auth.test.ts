import { describe, expect, it } from 'vitest';

import {
  MeResponseSchema,
  OtpRequestBodySchema,
  OtpVerifyBodySchema,
  SessionContextSchema,
} from './auth.js';
import { LIMITS } from './limits.js';
import { VALID_REQUEST_ID, VALID_TIMESTAMP, VALID_USER_ID } from './session.fixtures.js';

describe('OTP request', () => {
  it('accepts a valid email', () => {
    expect(OtpRequestBodySchema.parse({ email: 'dev@example.com' })).toEqual({
      email: 'dev@example.com',
    });
  });

  it('rejects malformed emails', () => {
    for (const email of ['', 'not-an-email', 'a@', '@example.com', 'a b@example.com']) {
      expect(OtpRequestBodySchema.safeParse({ email }).success).toBe(false);
    }
  });

  it('rejects an oversized email', () => {
    const email = `${'a'.repeat(LIMITS.emailMaxChars)}@example.com`;
    expect(OtpRequestBodySchema.safeParse({ email }).success).toBe(false);
  });

  it('rejects unknown keys, so a client cannot smuggle extra fields', () => {
    expect(
      OtpRequestBodySchema.safeParse({ email: 'dev@example.com', redirectTo: 'https://evil.test' })
        .success,
    ).toBe(false);
  });
});

describe('OTP verification', () => {
  const valid = () => ({
    requestId: VALID_REQUEST_ID,
    email: 'dev@example.com',
    code: '12345678',
  });

  it('accepts an eight digit code', () => {
    expect(OtpVerifyBodySchema.parse(valid())).toEqual(valid());
  });

  it('rejects codes of the wrong length or shape', () => {
    for (const code of ['1234567', '123456789', '1234567a', '', '        ', '12 34 56 78']) {
      expect(OtpVerifyBodySchema.safeParse({ ...valid(), code }).success).toBe(false);
    }
  });

  it('rejects a numeric code, which would lose leading zeros', () => {
    expect(OtpVerifyBodySchema.safeParse({ ...valid(), code: 12_345_678 }).success).toBe(false);
  });

  it('rejects a request id that is not a request id', () => {
    expect(OtpVerifyBodySchema.safeParse({ ...valid(), requestId: VALID_USER_ID }).success).toBe(
      false,
    );
  });
});

describe('session context', () => {
  const valid = () => ({
    user: {
      userId: VALID_USER_ID,
      email: 'dev@example.com',
      displayName: 'Dev',
      authProviders: ['email_otp' as const],
      createdAt: VALID_TIMESTAMP,
      lastLoginAt: VALID_TIMESTAMP,
    },
    csrfToken: 'a'.repeat(32),
    hasActiveInstallation: true,
    hasActiveSession: false,
  });

  it('accepts a context without an avatar', () => {
    expect(SessionContextSchema.parse(valid())).toEqual(valid());
    expect(MeResponseSchema.parse(valid())).toEqual(valid());
  });

  it('requires at least one auth provider', () => {
    const context = valid();
    expect(
      SessionContextSchema.safeParse({ ...context, user: { ...context.user, authProviders: [] } })
        .success,
    ).toBe(false);
  });

  it('rejects an unknown auth provider', () => {
    const context = valid();
    expect(
      SessionContextSchema.safeParse({
        ...context,
        user: { ...context.user, authProviders: ['saml'] },
      }).success,
    ).toBe(false);
  });

  it('never carries a token field, even if one is supplied', () => {
    expect(SessionContextSchema.safeParse({ ...valid(), accessToken: 'secret' }).success).toBe(
      false,
    );
  });

  it('rejects a short csrf token', () => {
    expect(SessionContextSchema.safeParse({ ...valid(), csrfToken: 'short' }).success).toBe(false);
  });
});
