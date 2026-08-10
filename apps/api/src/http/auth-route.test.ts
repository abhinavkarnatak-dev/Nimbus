import {
  ApiErrorBodySchema,
  AuthenticatedUserSchema,
  MeResponseSchema,
  OtpRequestResponseSchema,
  type ApiErrorBody,
  type AuthenticatedUser,
  type SessionContext,
} from '@nimbus/contracts';
import type { Express } from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import type {
  RequestCodeInput,
  RequestCodeResult,
  VerifyCodeInput,
  VerifyCodeResult,
} from '../auth/otp-service.js';
import type { ActiveSession, EstablishedSession } from '../auth/session-service.js';
import { createApp } from '../app.js';
import { ApiError } from './api-error.js';
import { SESSION_COOKIE_NAME } from './cookies.js';
import { createTestLogger, testConfig } from './http.fixtures.js';
import { createAttachSession } from './middleware/session.js';
import { clientIp, createAuthRouter, UNKNOWN_CLIENT_IP } from './routes/auth.js';

const REQUEST_ID = 'req_V1StGXR8Z5jdHi6BmyTab';
const SESSION_ID = 'session-id-value';
const CSRF_TOKEN = 'csrf-token-value';

const USER: AuthenticatedUser = AuthenticatedUserSchema.parse({
  userId: 'usr_V1StGXR8Z5jdHi6BmyTab',
  email: 'person@example.com',
  displayName: 'person',
  authProviders: ['email_otp'],
  createdAt: '2026-08-11T00:00:00.000Z',
  lastLoginAt: '2026-08-11T00:00:00.000Z',
});

function activeSession(): ActiveSession {
  return {
    sessionId: SESSION_ID,
    sessionKey: 'hashed',
    csrfToken: CSRF_TOKEN,
    user: USER,
    record: {
      userId: USER.userId,
      createdAt: '2026-08-11T00:00:00.000Z',
      absoluteExpiresAt: '2026-08-12T00:00:00.000Z',
    },
  };
}

interface Harness {
  app: Express;
  requestCalls: RequestCodeInput[];
  verifyCalls: VerifyCodeInput[];
  endedSessions: string[];
  startedFor: { userId: string; replacing: string | undefined }[];
}

function harness(options: { signedIn?: boolean; onRequest?: () => never } = {}): Harness {
  const requestCalls: RequestCodeInput[] = [];
  const verifyCalls: VerifyCodeInput[] = [];
  const endedSessions: string[] = [];
  const startedFor: { userId: string; replacing: string | undefined }[] = [];
  const { logger } = createTestLogger();

  const otp = {
    requestCode: async (input: RequestCodeInput): Promise<RequestCodeResult> => {
      requestCalls.push(input);
      options.onRequest?.();
      await Promise.resolve();
      return { requestId: REQUEST_ID, expiresInSeconds: 600, resendAvailableInSeconds: 60 };
    },
    verifyCode: async (input: VerifyCodeInput): Promise<VerifyCodeResult> => {
      verifyCalls.push(input);
      await Promise.resolve();
      return { user: USER, created: false };
    },
  };

  const sessions = {
    load: async (sessionId: string): Promise<ActiveSession | null> => {
      await Promise.resolve();
      return options.signedIn === true && sessionId === SESSION_ID ? activeSession() : null;
    },
    start: async (userId: string, replacing?: string): Promise<EstablishedSession> => {
      startedFor.push({ userId, replacing });
      await Promise.resolve();
      return { sessionId: SESSION_ID, csrfToken: CSRF_TOKEN, expiresInSeconds: 3_600 };
    },
    end: async (sessionId: string): Promise<boolean> => {
      endedSessions.push(sessionId);
      await Promise.resolve();
      return true;
    },
    context: async (user: AuthenticatedUser, csrfToken: string): Promise<SessionContext> => {
      await Promise.resolve();
      return { user, csrfToken, hasActiveInstallation: false, hasActiveSession: false };
    },
    csrfMatches: (session: ActiveSession, candidate: string): boolean =>
      candidate === session.csrfToken,
  };

  const app = createApp({
    config: testConfig(),
    logger,
    routers: [createAuthRouter({ otp, sessions, isProduction: false })],
    attachSession: createAttachSession(sessions, false),
  });

  return { app, requestCalls, verifyCalls, endedSessions, startedFor };
}

function errorBody(body: unknown): ApiErrorBody {
  return ApiErrorBodySchema.parse(body);
}

function cookieHeader(): string {
  return `${SESSION_COOKIE_NAME}=${SESSION_ID}`;
}

describe('POST /auth/otp/request', () => {
  it('accepts a valid address and answers in the contract shape', async () => {
    const { app } = harness();

    const response = await request(app)
      .post('/auth/otp/request')
      .send({ email: 'person@example.com' });

    expect(response.status).toBe(202);
    expect(() => OtpRequestResponseSchema.parse(response.body)).not.toThrow();
  });

  it('refuses a body that is not an email address', async () => {
    const { app, requestCalls } = harness();

    const response = await request(app).post('/auth/otp/request').send({ email: 'not-an-email' });

    expect(response.status).toBe(400);
    expect(errorBody(response.body).error.code).toBe('VALIDATION_FAILED');
    expect(requestCalls).toHaveLength(0);
  });

  it('refuses a body with unknown fields rather than ignoring them', async () => {
    const { app, requestCalls } = harness();

    const response = await request(app)
      .post('/auth/otp/request')
      .send({ email: 'person@example.com', role: 'admin' });

    expect(response.status).toBe(400);
    expect(requestCalls).toHaveLength(0);
  });

  it('never echoes the submitted address back in an error', async () => {
    const { app } = harness();

    const response = await request(app)
      .post('/auth/otp/request')
      .send({ email: 'probe-me@example.com' });

    expect(JSON.stringify(response.body)).not.toContain('probe-me@example.com');
  });

  it('maps a refusal to 429 and an outage to 503', async () => {
    const limited = harness({
      onRequest: () => {
        throw new ApiError('RATE_LIMITED', 'Slow down.');
      },
    });
    const down = harness({
      onRequest: () => {
        throw new ApiError('PROVIDER_UNAVAILABLE', 'Cannot send just now.');
      },
    });

    expect(
      (await request(limited.app).post('/auth/otp/request').send({ email: 'a@example.com' }))
        .status,
    ).toBe(429);
    expect(
      (await request(down.app).post('/auth/otp/request').send({ email: 'a@example.com' })).status,
    ).toBe(503);
  });

  it('needs no session, since nobody is signed in yet', async () => {
    const { app } = harness();

    const response = await request(app)
      .post('/auth/otp/request')
      .send({ email: 'person@example.com' });

    expect(response.status).toBe(202);
  });
});

describe('POST /auth/otp/verify', () => {
  it('signs the caller in and sets a session cookie', async () => {
    const { app } = harness();

    const response = await request(app)
      .post('/auth/otp/verify')
      .send({ requestId: REQUEST_ID, email: 'person@example.com', code: '12345678' });

    expect(response.status).toBe(200);
    const cookies = response.headers['set-cookie'] as unknown as string[];
    expect(cookies.join(';')).toContain(`${SESSION_COOKIE_NAME}=${SESSION_ID}`);
  });

  it('marks the cookie HttpOnly, SameSite Lax and path wide', async () => {
    const { app } = harness();

    const response = await request(app)
      .post('/auth/otp/verify')
      .send({ requestId: REQUEST_ID, email: 'person@example.com', code: '12345678' });

    const cookie = (response.headers['set-cookie'] as unknown as string[]).join(';');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Path=/');
  });

  it('returns the session context including a CSRF token', async () => {
    const { app } = harness();

    const response = await request(app)
      .post('/auth/otp/verify')
      .send({ requestId: REQUEST_ID, email: 'person@example.com', code: '12345678' });

    const context = MeResponseSchema.parse(response.body);
    expect(context.csrfToken).toBe(CSRF_TOKEN);
    expect(context.user.email).toBe('person@example.com');
    expect(context.hasActiveInstallation).toBe(false);
  });

  it('replaces any session the caller already carried', async () => {
    const { app, startedFor } = harness({ signedIn: true });

    await request(app)
      .post('/auth/otp/verify')
      .set('Cookie', cookieHeader())
      .send({ requestId: REQUEST_ID, email: 'person@example.com', code: '12345678' });

    expect(startedFor[0]?.replacing).toBe(SESSION_ID);
  });

  it('refuses a malformed code without calling the service', async () => {
    const { app, verifyCalls } = harness();

    const response = await request(app)
      .post('/auth/otp/verify')
      .send({ requestId: REQUEST_ID, email: 'person@example.com', code: '123' });

    expect(response.status).toBe(400);
    expect(verifyCalls).toHaveLength(0);
  });

  it('refuses a malformed request id without calling the service', async () => {
    const { app, verifyCalls } = harness();

    const response = await request(app)
      .post('/auth/otp/verify')
      .send({ requestId: 'nope', email: 'person@example.com', code: '12345678' });

    expect(response.status).toBe(400);
    expect(verifyCalls).toHaveLength(0);
  });
});

describe('GET /auth/me', () => {
  it('refuses when there is no session', async () => {
    const { app } = harness();

    const response = await request(app).get('/auth/me');

    expect(response.status).toBe(401);
    expect(errorBody(response.body).error.code).toBe('UNAUTHENTICATED');
  });

  it('refuses a cookie that does not match a session', async () => {
    const { app } = harness({ signedIn: true });

    const response = await request(app)
      .get('/auth/me')
      .set('Cookie', `${SESSION_COOKIE_NAME}=made-up-value`);

    expect(response.status).toBe(401);
  });

  it('says who you are when signed in', async () => {
    const { app } = harness({ signedIn: true });

    const response = await request(app).get('/auth/me').set('Cookie', cookieHeader());

    expect(response.status).toBe(200);
    expect(MeResponseSchema.parse(response.body).user.userId).toBe(USER.userId);
  });

  it('needs no CSRF token, because reading changes nothing', async () => {
    const { app } = harness({ signedIn: true });

    const response = await request(app).get('/auth/me').set('Cookie', cookieHeader());

    expect(response.status).toBe(200);
  });
});

describe('POST /auth/logout', () => {
  it('refuses without a session', async () => {
    const { app } = harness();

    const response = await request(app).post('/auth/logout');

    expect(response.status).toBe(401);
  });

  it('refuses without a CSRF token', async () => {
    const { app, endedSessions } = harness({ signedIn: true });

    const response = await request(app).post('/auth/logout').set('Cookie', cookieHeader());

    expect(response.status).toBe(403);
    expect(errorBody(response.body).error.code).toBe('CSRF_TOKEN_INVALID');
    expect(endedSessions).toHaveLength(0);
  });

  it('refuses a wrong CSRF token', async () => {
    const { app, endedSessions } = harness({ signedIn: true });

    const response = await request(app)
      .post('/auth/logout')
      .set('Cookie', cookieHeader())
      .set('X-CSRF-Token', 'not-the-token');

    expect(response.status).toBe(403);
    expect(endedSessions).toHaveLength(0);
  });

  it('ends the session and clears the cookie with the right token', async () => {
    const { app, endedSessions } = harness({ signedIn: true });

    const response = await request(app)
      .post('/auth/logout')
      .set('Cookie', cookieHeader())
      .set('X-CSRF-Token', CSRF_TOKEN);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ loggedOut: true });
    expect(endedSessions).toEqual([SESSION_ID]);

    const cookie = (response.headers['set-cookie'] as unknown as string[]).join(';');
    expect(cookie).toContain(`${SESSION_COOKIE_NAME}=;`);
  });
});

describe('working out the caller address', () => {
  it('falls back to a placeholder rather than an empty string', () => {
    expect(clientIp(undefined)).toBe(UNKNOWN_CLIENT_IP);
    expect(clientIp('')).toBe(UNKNOWN_CLIENT_IP);
    expect(clientIp('203.0.113.10')).toBe('203.0.113.10');
  });
});
