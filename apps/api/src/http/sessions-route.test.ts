import { AuthenticatedUserSchema, type AuthenticatedUser } from '@nimbus/contracts';
import type { Express } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../app.js';
import { CSRF_HEADER } from '../auth/csrf.js';
import type { ActiveSession } from '../auth/session-service.js';
import { InMemorySessionRecords } from '../sessions/repository.js';
import { AgentSessionService } from '../sessions/service.js';
import {
  CLEAR_TASK,
  FakeRepositoryDirectory,
  SHOPFRONT,
  newBody,
  testId,
} from '../sessions/sessions.fixtures.js';
import { InMemoryAttachmentRecords } from '../attachments/repository.js';
import { createTestLogger, testConfig } from './http.fixtures.js';
import { SESSION_COOKIE_NAME } from './cookies.js';
import { createAttachSession } from './middleware/session.js';
import { createSessionsRouter } from './routes/sessions.js';

const LOGIN_ID = 'session-id-value';
const CSRF_TOKEN = 'csrf-token-value';
const COOKIE = `${SESSION_COOKIE_NAME}=${LOGIN_ID}`;

const USER: AuthenticatedUser = AuthenticatedUserSchema.parse({
  userId: 'usr_V1StGXR8Z5jdHi6BmyTab',
  email: 'person@example.com',
  displayName: 'person',
  authProviders: ['email_otp'],
  createdAt: '2026-08-14T00:00:00.000Z',
  lastLoginAt: '2026-08-14T00:00:00.000Z',
});

const OTHER_USER: AuthenticatedUser = AuthenticatedUserSchema.parse({
  ...USER,
  userId: 'usr_TabmyB6iHd5Z8RXGtS1Vx',
  email: 'other@example.com',
});

function sessionFor(user: AuthenticatedUser): ActiveSession {
  return {
    sessionId: LOGIN_ID,
    sessionKey: 'hashed',
    csrfToken: CSRF_TOKEN,
    user,
    record: {
      userId: user.userId,
      createdAt: '2026-08-14T00:00:00.000Z',
      absoluteExpiresAt: '2026-08-15T00:00:00.000Z',
    },
  };
}

let records: InMemorySessionRecords;
let service: AgentSessionService;

beforeEach(() => {
  const { logger } = createTestLogger();
  records = new InMemorySessionRecords();

  service = new AgentSessionService({
    records,
    attachments: new InMemoryAttachmentRecords(),
    repositories: new FakeRepositoryDirectory([SHOPFRONT]),
    logger,
  });
});

function harness(options: { signedIn?: boolean; user?: AuthenticatedUser } = {}): Express {
  const { logger } = createTestLogger();
  const user = options.user ?? USER;

  const auth = {
    load: async (sessionId: string): Promise<ActiveSession | null> => {
      await Promise.resolve();
      return options.signedIn !== false && sessionId === LOGIN_ID ? sessionFor(user) : null;
    },
    csrfMatches: (session: ActiveSession, token: string): boolean => session.csrfToken === token,
  };

  return createApp({
    config: testConfig(),
    logger,
    routers: [createSessionsRouter({ sessions: service, auth })],
    attachSession: createAttachSession(auth, false),
  });
}

async function start(
  app: Express,
  overrides: Parameters<typeof newBody>[0] = {},
): Promise<{ status: number; sessionId: string }> {
  const response = await request(app)
    .post('/sessions')
    .set('Cookie', COOKIE)
    .set(CSRF_HEADER, CSRF_TOKEN)
    .send(newBody(overrides));

  return {
    status: response.status,
    sessionId: (response.body as { session?: { sessionId: string } }).session?.sessionId ?? '',
  };
}

describe('POST /sessions', () => {
  it('starts a session and answers 201', async () => {
    const response = await request(harness())
      .post('/sessions')
      .set('Cookie', COOKIE)
      .set(CSRF_HEADER, CSRF_TOKEN)
      .send(newBody());

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({ session: { status: 'queued', task: CLEAR_TASK } });
  });

  it('answers 200 with the same session when the request is sent again', async () => {
    const app = harness();
    const first = await start(app);
    const second = await start(app);

    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.sessionId).toBe(first.sessionId);
  });

  it('refuses a second session while one is running', async () => {
    const app = harness();
    await start(app);

    const response = await request(app)
      .post('/sessions')
      .set('Cookie', COOKIE)
      .set(CSRF_HEADER, CSRF_TOKEN)
      .send(newBody({ idempotencyKey: testId('idk', 'b') }));

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ error: { code: 'ACTIVE_SESSION_EXISTS' } });
  });

  it('refuses a body that is not the shape we asked for', async () => {
    const response = await request(harness())
      .post('/sessions')
      .set('Cookie', COOKIE)
      .set(CSRF_HEADER, CSRF_TOKEN)
      .send({ repositoryId: SHOPFRONT.repositoryId, task: CLEAR_TASK });

    expect(response.status).toBe(400);
  });

  it('needs a signed in person', async () => {
    const response = await request(harness({ signedIn: false }))
      .post('/sessions')
      .set('Cookie', COOKIE)
      .set(CSRF_HEADER, CSRF_TOKEN)
      .send(newBody());

    expect(response.status).toBe(401);
  });

  it('needs the csrf token, because it changes something', async () => {
    const response = await request(harness())
      .post('/sessions')
      .set('Cookie', COOKIE)
      .send(newBody());

    expect(response.status).toBe(403);
  });
});

describe('GET /sessions', () => {
  it('lists this person and names the active session', async () => {
    const app = harness();
    const started = await start(app);

    const response = await request(app).get('/sessions').set('Cookie', COOKIE);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ activeSessionId: started.sessionId });
  });

  it('shows another person nothing', async () => {
    await start(harness());

    const response = await request(harness({ user: OTHER_USER }))
      .get('/sessions')
      .set('Cookie', COOKIE);

    expect(response.body).toMatchObject({ sessions: [], activeSessionId: null });
  });

  it('needs a signed in person', async () => {
    const response = await request(harness({ signedIn: false })).get('/sessions');

    expect(response.status).toBe(401);
  });
});

describe('GET /sessions/:sessionId', () => {
  it('gives the detail and the sequence a stream replays from', async () => {
    const app = harness();
    const started = await start(app);

    const response = await request(app).get(`/sessions/${started.sessionId}`).set('Cookie', COOKIE);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ lastEventSequence: 0 });
  });

  it('tells another person it does not exist, rather than that it is theirs', async () => {
    const started = await start(harness());

    const response = await request(harness({ user: OTHER_USER }))
      .get(`/sessions/${started.sessionId}`)
      .set('Cookie', COOKIE);

    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({ error: { code: 'NOT_FOUND' } });
  });

  it('answers the same way for an id that is not a session id at all', async () => {
    const response = await request(harness()).get('/sessions/not-an-id').set('Cookie', COOKIE);

    expect(response.status).toBe(404);
  });
});

describe('POST /sessions/:sessionId/cancel', () => {
  it('cancels one that is running', async () => {
    const app = harness();
    const started = await start(app);

    const response = await request(app)
      .post(`/sessions/${started.sessionId}/cancel`)
      .set('Cookie', COOKIE)
      .set(CSRF_HEADER, CSRF_TOKEN);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ status: 'cancelled' });
  });

  it('refuses to cancel one that has already ended', async () => {
    const app = harness();
    const started = await start(app);

    await request(app)
      .post(`/sessions/${started.sessionId}/cancel`)
      .set('Cookie', COOKIE)
      .set(CSRF_HEADER, CSRF_TOKEN);

    const again = await request(app)
      .post(`/sessions/${started.sessionId}/cancel`)
      .set('Cookie', COOKIE)
      .set(CSRF_HEADER, CSRF_TOKEN);

    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({ error: { code: 'SESSION_NOT_ACTIVE' } });
  });

  it('does not let another person cancel it', async () => {
    const started = await start(harness());

    const response = await request(harness({ user: OTHER_USER }))
      .post(`/sessions/${started.sessionId}/cancel`)
      .set('Cookie', COOKIE)
      .set(CSRF_HEADER, CSRF_TOKEN);

    expect(response.status).toBe(404);
    expect(records.documents[0]?.status).toBe('queued');
  });

  it('needs the csrf token', async () => {
    const app = harness();
    const started = await start(app);

    const response = await request(app)
      .post(`/sessions/${started.sessionId}/cancel`)
      .set('Cookie', COOKIE);

    expect(response.status).toBe(403);
  });
});
