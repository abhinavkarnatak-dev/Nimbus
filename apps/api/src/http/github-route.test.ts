import {
  ApiErrorBodySchema,
  AuthenticatedUserSchema,
  GitHubConnectResponseSchema,
  InstallationSummarySchema,
  RepositoriesResponseSchema,
  type ApiErrorBody,
  type AuthenticatedUser,
  type InstallationSummary,
} from '@nimbus/contracts';
import type { Express } from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import type { RepositoriesResult } from '../github/installation-service.js';
import type { ActiveSession } from '../auth/session-service.js';
import { createApp } from '../app.js';
import { ApiError } from './api-error.js';
import { SESSION_COOKIE_NAME } from './cookies.js';
import { createTestLogger, testConfig } from './http.fixtures.js';
import { createAttachSession } from './middleware/session.js';
import { createGitHubRouter, parseInstallationId, setupRedirect } from './routes/github.js';

const SESSION_ID = 'session-id-value';
const WEB_ORIGIN = 'http://localhost:5173';
const INSTALLATION_ID = 152_851_946;

const USER: AuthenticatedUser = AuthenticatedUserSchema.parse({
  userId: 'usr_V1StGXR8Z5jdHi6BmyTab',
  email: 'person@example.com',
  displayName: 'person',
  authProviders: ['email_otp'],
  createdAt: '2026-08-11T00:00:00.000Z',
  lastLoginAt: '2026-08-11T00:00:00.000Z',
});

const INSTALLATION: InstallationSummary = InstallationSummarySchema.parse({
  installationRecordId: 'ins_V1StGXR8Z5jdHi6BmyTab',
  installationId: INSTALLATION_ID,
  accountLogin: 'octocat',
  accountType: 'User',
  status: 'active',
  connectedAt: '2026-08-11T00:00:00.000Z',
});

function activeSession(): ActiveSession {
  return {
    sessionId: SESSION_ID,
    sessionKey: 'hashed',
    csrfToken: 'csrf-token-value',
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
  setups: { userId: string; installationId: number; state: string; code: string }[];
  listedFor: string[];
}

function harness(
  options: { signedIn?: boolean; onSetup?: () => never; onList?: () => never } = {},
): Harness {
  const setups: { userId: string; installationId: number; state: string; code: string }[] = [];
  const listedFor: string[] = [];
  const { logger } = createTestLogger();

  const sessions = {
    load: async (sessionId: string): Promise<ActiveSession | null> => {
      await Promise.resolve();
      return options.signedIn !== false && sessionId === SESSION_ID ? activeSession() : null;
    },
  };

  const installations = {
    beginConnect: async (): Promise<{ redirectUrl: string; state: string }> => {
      await Promise.resolve();
      return {
        redirectUrl: 'https://github.com/apps/nimbus-test/installations/new?state=non_abc',
        state: 'non_abc',
      };
    },
    completeSetup: async (input: {
      userId: string;
      installationId: number;
      state: string;
      code: string;
      ip: string;
    }): Promise<InstallationSummary> => {
      setups.push({
        userId: input.userId,
        installationId: input.installationId,
        state: input.state,
        code: input.code,
      });
      await Promise.resolve();
      options.onSetup?.();
      return INSTALLATION;
    },
    listRepositories: async (userId: string): Promise<RepositoriesResult> => {
      listedFor.push(userId);
      await Promise.resolve();
      options.onList?.();
      return { installation: INSTALLATION, repositories: [] };
    },
  };

  const app = createApp({
    config: testConfig(),
    logger,
    routers: [createGitHubRouter({ installations, webOrigin: WEB_ORIGIN })],
    attachSession: createAttachSession(sessions, false),
  });

  return { app, setups, listedFor };
}

function errorBody(body: unknown): ApiErrorBody {
  return ApiErrorBodySchema.parse(body);
}

const cookie = `${SESSION_COOKIE_NAME}=${SESSION_ID}`;

describe('GET /github/connect', () => {
  it('refuses when nobody is signed in', async () => {
    const { app } = harness({ signedIn: false });

    const response = await request(app).get('/github/connect');

    expect(response.status).toBe(401);
    expect(errorBody(response.body).error.code).toBe('UNAUTHENTICATED');
  });

  it('gives the frontend a url rather than redirecting itself', async () => {
    const { app } = harness();

    const response = await request(app).get('/github/connect').set('Cookie', cookie);

    expect(response.status).toBe(200);
    const body = GitHubConnectResponseSchema.parse(response.body);
    expect(body.redirectUrl).toContain('github.com/apps/');
  });
});

describe('GET /github/setup/callback', () => {
  it('refuses when nobody is signed in', async () => {
    const { app, setups } = harness({ signedIn: false });

    const response = await request(app).get(
      `/github/setup/callback?installation_id=${String(INSTALLATION_ID)}&state=non_abc`,
    );

    expect(response.status).toBe(401);
    expect(setups).toHaveLength(0);
  });

  it('associates the installation and sends the browser to the frontend', async () => {
    const { app, setups } = harness();

    const response = await request(app)
      .get(`/github/setup/callback?installation_id=${String(INSTALLATION_ID)}&state=non_abc`)
      .set('Cookie', cookie);

    expect(response.status).toBe(302);
    expect(response.headers['location']).toBe(`${WEB_ORIGIN}/github/callback?github=connected`);
    expect(setups[0]?.installationId).toBe(INSTALLATION_ID);
    expect(setups[0]?.userId).toBe(USER.userId);
  });

  it('passes the installer proof through to the service', async () => {
    const { app, setups } = harness();

    await request(app)
      .get(
        `/github/setup/callback?installation_id=${String(INSTALLATION_ID)}&state=non_abc&code=install-code`,
      )
      .set('Cookie', cookie);

    expect(setups[0]?.code).toBe('install-code');
  });

  it('passes an empty proof when GitHub sends none, so the service can refuse', async () => {
    const { app, setups } = harness();

    await request(app)
      .get(`/github/setup/callback?installation_id=${String(INSTALLATION_ID)}&state=non_abc`)
      .set('Cookie', cookie);

    expect(setups[0]?.code).toBe('');
  });

  it('takes the account from the session, never from the query', async () => {
    const { app, setups } = harness();

    await request(app)
      .get(
        `/github/setup/callback?installation_id=${String(INSTALLATION_ID)}&state=non_abc&userId=usr_somebodyelse`,
      )
      .set('Cookie', cookie);

    expect(setups[0]?.userId).toBe(USER.userId);
  });

  it('handles the person cancelling at GitHub', async () => {
    const { app, setups } = harness();

    const response = await request(app)
      .get('/github/setup/callback?setup_action=cancel')
      .set('Cookie', cookie);

    expect(response.headers['location']).toBe(`${WEB_ORIGIN}/github/callback?github=cancelled`);
    expect(setups).toHaveLength(0);
  });

  it('lets the service work out the installation when GitHub sends none', async () => {
    const { app, setups } = harness();

    await request(app)
      .get('/github/setup/callback?state=non_abc&code=install-code')
      .set('Cookie', cookie);

    expect(setups[0]?.installationId).toBe(0);
  });

  it('refuses a state that is missing entirely', async () => {
    const { app, setups } = harness();

    const response = await request(app).get('/github/setup/callback?code=x').set('Cookie', cookie);

    expect(response.headers['location']).toContain('github=failed');
    expect(setups).toHaveLength(0);
  });

  it('never passes on an installation id that is not a plain number', async () => {
    const { app, setups } = harness();

    for (const value of ['abc', '-1', '1e5', '12.5', '  12  ', '1;DROP']) {
      await request(app)
        .get(`/github/setup/callback?installation_id=${encodeURIComponent(value)}&state=non_abc`)
        .set('Cookie', cookie);
    }

    expect(setups.every((setup) => setup.installationId === 0)).toBe(true);
  });

  it('turns a refusal into a redirect carrying the reason', async () => {
    const { app } = harness({
      onSetup: () => {
        throw new ApiError('FORBIDDEN', 'Already connected elsewhere.');
      },
    });

    const response = await request(app)
      .get(`/github/setup/callback?installation_id=${String(INSTALLATION_ID)}&state=non_abc`)
      .set('Cookie', cookie);

    expect(response.status).toBe(302);
    expect(response.headers['location']).toBe(
      `${WEB_ORIGIN}/github/callback?github=failed&reason=FORBIDDEN`,
    );
  });

  it('never sends the browser anywhere but the configured frontend', async () => {
    const { app } = harness();

    const responses = [
      await request(app).get('/github/setup/callback?setup_action=cancel').set('Cookie', cookie),
      await request(app).get('/github/setup/callback').set('Cookie', cookie),
      await request(app)
        .get(`/github/setup/callback?installation_id=${String(INSTALLATION_ID)}&state=non_abc`)
        .set('Cookie', cookie),
    ];

    for (const response of responses) {
      expect(String(response.headers['location']).startsWith(WEB_ORIGIN)).toBe(true);
    }
  });
});

describe('GET /github/repositories', () => {
  it('refuses when nobody is signed in', async () => {
    const { app, listedFor } = harness({ signedIn: false });

    const response = await request(app).get('/github/repositories');

    expect(response.status).toBe(401);
    expect(listedFor).toHaveLength(0);
  });

  it('answers in the contract shape', async () => {
    const { app } = harness();

    const response = await request(app).get('/github/repositories').set('Cookie', cookie);

    expect(response.status).toBe(200);
    expect(() => RepositoriesResponseSchema.parse(response.body)).not.toThrow();
  });

  it('resolves the account from the session, not from anything sent', async () => {
    const { app, listedFor } = harness();

    await request(app)
      .get('/github/repositories?userId=usr_somebodyelse&installation_id=999')
      .set('Cookie', cookie);

    expect(listedFor).toEqual([USER.userId]);
  });

  it('says not connected rather than returning an empty list', async () => {
    const { app } = harness({
      onList: () => {
        throw new ApiError('GITHUB_NOT_CONNECTED', 'Connect a GitHub account first.');
      },
    });

    const response = await request(app).get('/github/repositories').set('Cookie', cookie);

    expect(response.status).toBe(409);
    expect(errorBody(response.body).error.code).toBe('GITHUB_NOT_CONNECTED');
  });
});

describe('reading an installation id from a query string', () => {
  it('accepts a plain positive number', () => {
    expect(parseInstallationId('152851946')).toBe(152_851_946);
  });

  it('refuses anything else', () => {
    for (const value of [
      '',
      'abc',
      '-1',
      '0',
      '1.5',
      '1e5',
      ' 12',
      '12 ',
      '0x10',
      '9'.repeat(20),
    ]) {
      expect(parseInstallationId(value)).toBeNull();
    }
    expect(parseInstallationId(undefined)).toBeNull();
    expect(parseInstallationId(152_851_946)).toBeNull();
  });
});

describe('the setup redirect', () => {
  it('always lands on the configured frontend', () => {
    expect(setupRedirect(WEB_ORIGIN, 'connected')).toBe(
      `${WEB_ORIGIN}/github/callback?github=connected`,
    );
  });

  it('carries a reason when there is one', () => {
    expect(setupRedirect(WEB_ORIGIN, 'failed', 'FORBIDDEN')).toContain('reason=FORBIDDEN');
  });
});
