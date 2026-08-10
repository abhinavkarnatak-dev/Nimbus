import {
  createTestDatabase,
  createTestRedis,
  type TestDatabase,
  type TestRedis,
} from '@nimbus/test-utils';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { FakeGoogleIdentityProvider, makeFakeIdToken } from '../../src/auth/google-fake.js';
import { GoogleService } from '../../src/auth/google-service.js';
import { GoogleIdentityError } from '../../src/auth/google-identity.js';
import { OtpService } from '../../src/auth/otp-service.js';
import { findOrCreateUserByEmail } from '../../src/auth/user-repository.js';
import { ensureDatabaseSchema } from '../../src/db/bootstrap.js';
import { auditEventsCollection } from '../../src/db/models/audit-event.js';
import { usersCollection } from '../../src/db/models/user.js';
import { CapturingMailer } from '../../src/email/capturing-mailer.js';
import { MailService } from '../../src/email/mail-service.js';
import { ApiError } from '../../src/http/api-error.js';
import { createTestLogger, testConfig } from '../../src/http/http.fixtures.js';

const EMAIL = 'person@example.com';
const IP = '203.0.113.10';
const CODE = 'google-authorization-code';

let db: TestDatabase;
let redis: TestRedis;
let provider: FakeGoogleIdentityProvider;
let google: GoogleService;

function build(): GoogleService {
  const { logger } = createTestLogger();
  provider = new FakeGoogleIdentityProvider();

  return new GoogleService({ redis: redis.client, db: db.db, provider, logger });
}

async function apiErrorFrom(action: Promise<unknown>): Promise<ApiError> {
  try {
    await action;
  } catch (error) {
    if (error instanceof ApiError) {
      return error;
    }
    throw error;
  }
  throw new Error('Expected the action to be refused');
}

beforeAll(async () => {
  db = await createTestDatabase('nimbus_google');
  redis = await createTestRedis();
  await ensureDatabaseSchema(db.db);
});

afterAll(async () => {
  await redis.cleanup();
  await db.cleanup();
});

beforeEach(async () => {
  await redis.client.flushdb();
  await usersCollection(db.db).deleteMany({});
  await auditEventsCollection(db.db).deleteMany({});
  google = build();
});

describe('starting the flow', () => {
  it('sends the browser to Google with a state and a challenge', async () => {
    const started = await google.begin();
    const url = new URL(started.redirectUrl);

    expect(url.origin).toBe('https://accounts.google.com');
    expect(url.searchParams.get('state')).toBe(started.state);
    expect(url.searchParams.get('code_challenge')).toBe(started.codeChallenge);
  });

  it('never puts the PKCE secret or the binding value in the redirect', async () => {
    const started = await google.begin();

    expect(started.redirectUrl).not.toContain(started.codeVerifier);
    expect(started.redirectUrl).not.toContain(started.bindingValue);
  });

  it('gives a different state and binding value every time', async () => {
    const first = await google.begin();
    const second = await google.begin();

    expect(first.state).not.toBe(second.state);
    expect(first.bindingValue).not.toBe(second.bindingValue);
    expect(first.codeVerifier).not.toBe(second.codeVerifier);
  });
});

describe('finishing the flow', () => {
  it('creates an account for a new verified address', async () => {
    const started = await google.begin();
    provider.willReturn(CODE, { email: EMAIL });

    const outcome = await google.complete({
      code: CODE,
      state: started.state,
      bindingValue: started.bindingValue,
      ip: IP,
    });

    expect(outcome.created).toBe(true);
    expect(outcome.user.email).toBe(EMAIL);
    expect(outcome.user.authProviders).toEqual(['google']);
  });

  it('sends the PKCE secret to the exchange, not to the browser', async () => {
    const started = await google.begin();
    provider.willReturn(CODE, { email: EMAIL });

    await google.complete({
      code: CODE,
      state: started.state,
      bindingValue: started.bindingValue,
      ip: IP,
    });

    expect(provider.exchanges[0]?.codeVerifier).toBe(started.codeVerifier);
  });

  it('treats a differently capitalised address as the same person', async () => {
    const started = await google.begin();
    provider.willReturn(CODE, { email: 'Person@Example.COM' });

    const outcome = await google.complete({
      code: CODE,
      state: started.state,
      bindingValue: started.bindingValue,
      ip: IP,
    });

    expect(outcome.user.email).toBe(EMAIL);
  });
});

describe('state mismatch and replay', () => {
  it('refuses a state that was never issued', async () => {
    provider.willReturn(CODE, { email: EMAIL });

    const error = await apiErrorFrom(
      google.complete({
        code: CODE,
        state: 'non_aaaaaaaaaaaaaaaaaaaaa',
        bindingValue: 'anything',
        ip: IP,
      }),
    );

    expect(error.code).toBe('OAUTH_STATE_INVALID');
    expect(provider.exchanges).toHaveLength(0);
  });

  it('refuses an empty state', async () => {
    const error = await apiErrorFrom(
      google.complete({ code: CODE, state: '', bindingValue: '', ip: IP }),
    );

    expect(error.code).toBe('OAUTH_STATE_INVALID');
  });

  it('refuses the same callback used twice', async () => {
    const started = await google.begin();
    provider.willReturn(CODE, { email: EMAIL });

    await google.complete({
      code: CODE,
      state: started.state,
      bindingValue: started.bindingValue,
      ip: IP,
    });

    const error = await apiErrorFrom(
      google.complete({
        code: CODE,
        state: started.state,
        bindingValue: started.bindingValue,
        ip: IP,
      }),
    );

    expect(error.code).toBe('OAUTH_STATE_INVALID');
    expect(await usersCollection(db.db).countDocuments({})).toBe(1);
  });

  it('refuses a state used from a different browser', async () => {
    const attacker = await google.begin();
    const victimBrowser = await google.begin();
    provider.willReturn(CODE, { email: 'attacker@example.com' });

    const error = await apiErrorFrom(
      google.complete({
        code: CODE,
        state: attacker.state,
        bindingValue: victimBrowser.bindingValue,
        ip: IP,
      }),
    );

    expect(error.code).toBe('OAUTH_STATE_INVALID');
    expect(await usersCollection(db.db).countDocuments({})).toBe(0);
    expect(provider.exchanges).toHaveLength(0);
  });

  it('refuses a state when the browser has no binding cookie at all', async () => {
    const started = await google.begin();
    provider.willReturn(CODE, { email: EMAIL });

    const error = await apiErrorFrom(
      google.complete({ code: CODE, state: started.state, bindingValue: '', ip: IP }),
    );

    expect(error.code).toBe('OAUTH_STATE_INVALID');
    expect(await usersCollection(db.db).countDocuments({})).toBe(0);
  });

  it('spends the state even when the binding fails, so it cannot be retried', async () => {
    const started = await google.begin();
    provider.willReturn(CODE, { email: EMAIL });

    await apiErrorFrom(
      google.complete({ code: CODE, state: started.state, bindingValue: 'wrong', ip: IP }),
    );

    const second = await apiErrorFrom(
      google.complete({
        code: CODE,
        state: started.state,
        bindingValue: started.bindingValue,
        ip: IP,
      }),
    );

    expect(second.code).toBe('OAUTH_STATE_INVALID');
  });
});

describe('account confusion', () => {
  it('links a verified Google address to an existing email account', async () => {
    const existing = await findOrCreateUserByEmail(db.db, EMAIL, 'email_otp');
    const started = await google.begin();
    provider.willReturn(CODE, { email: EMAIL });

    const outcome = await google.complete({
      code: CODE,
      state: started.state,
      bindingValue: started.bindingValue,
      ip: IP,
    });

    expect(outcome.created).toBe(false);
    expect(outcome.user.userId).toBe(existing.user.userId);
    expect(outcome.user.authProviders.sort()).toEqual(['email_otp', 'google']);
    expect(await usersCollection(db.db).countDocuments({})).toBe(1);
  });

  it('refuses an unverified address that matches an existing account', async () => {
    const existing = await findOrCreateUserByEmail(db.db, EMAIL, 'email_otp');
    const started = await google.begin();
    provider.willReturn(CODE, { email: EMAIL, emailVerified: false });

    const error = await apiErrorFrom(
      google.complete({
        code: CODE,
        state: started.state,
        bindingValue: started.bindingValue,
        ip: IP,
      }),
    );

    expect(error.code).toBe('FORBIDDEN');

    const untouched = await usersCollection(db.db).findOne({ email: EMAIL });
    expect(untouched?.userId).toBe(existing.user.userId);
    expect(untouched?.authProviders).toEqual(['email_otp']);
  });

  it('refuses an unverified address with no existing account and creates nothing', async () => {
    const started = await google.begin();
    provider.willReturn(CODE, { email: 'stranger@example.com', emailVerified: false });

    const error = await apiErrorFrom(
      google.complete({
        code: CODE,
        state: started.state,
        bindingValue: started.bindingValue,
        ip: IP,
      }),
    );

    expect(error.code).toBe('FORBIDDEN');
    expect(await usersCollection(db.db).countDocuments({})).toBe(0);
  });

  it('keeps one account when the same person uses both doors', async () => {
    const { logger } = createTestLogger();
    const mailer = new CapturingMailer();
    const otp = new OtpService({
      redis: redis.client,
      db: db.db,
      mail: new MailService(mailer, 'Nimbus <noreply@example.com>'),
      logger,
      config: testConfig(),
    });

    const asked = await otp.requestCode({ email: EMAIL, ip: IP });
    const code = /\b[0-9]{8}\b/.exec(mailer.lastMessage?.text ?? '')?.[0] ?? '';
    const viaEmail = await otp.verifyCode({
      requestId: asked.requestId,
      email: EMAIL,
      code,
      ip: IP,
    });

    const started = await google.begin();
    provider.willReturn(CODE, { email: EMAIL });
    const viaGoogle = await google.complete({
      code: CODE,
      state: started.state,
      bindingValue: started.bindingValue,
      ip: IP,
    });

    expect(viaGoogle.user.userId).toBe(viaEmail.user.userId);
    expect(await usersCollection(db.db).countDocuments({})).toBe(1);
  });

  it('refuses a disabled account', async () => {
    await findOrCreateUserByEmail(db.db, EMAIL, 'email_otp');
    await usersCollection(db.db).updateOne({ email: EMAIL }, { $set: { disabledAt: new Date() } });

    const started = await google.begin();
    provider.willReturn(CODE, { email: EMAIL });

    const error = await apiErrorFrom(
      google.complete({
        code: CODE,
        state: started.state,
        bindingValue: started.bindingValue,
        ip: IP,
      }),
    );

    expect(error.code).toBe('ACCOUNT_DISABLED');
  });
});

describe('when Google itself refuses', () => {
  it('reports a failed exchange without leaking detail', async () => {
    const started = await google.begin();
    provider.willFail(
      new GoogleIdentityError('GOOGLE_EXCHANGE_FAILED', 'We could not finish signing you in.'),
    );

    const error = await apiErrorFrom(
      google.complete({
        code: CODE,
        state: started.state,
        bindingValue: started.bindingValue,
        ip: IP,
      }),
    );

    expect(error.code).toBe('OAUTH_STATE_INVALID');
    expect(await usersCollection(db.db).countDocuments({})).toBe(0);
  });

  it('refuses a token meant for another application', async () => {
    const started = await google.begin();
    provider.willReturnRawToken(
      CODE,
      makeFakeIdToken({ email: EMAIL, audience: 'someone-elses-client' }),
    );

    const error = await apiErrorFrom(
      google.complete({
        code: CODE,
        state: started.state,
        bindingValue: started.bindingValue,
        ip: IP,
      }),
    );

    expect(error.code).toBe('OAUTH_STATE_INVALID');
    expect(await usersCollection(db.db).countDocuments({})).toBe(0);
  });
});

describe('what gets written down', () => {
  it('records a success without the address', async () => {
    const started = await google.begin();
    provider.willReturn(CODE, { email: EMAIL });

    await google.complete({
      code: CODE,
      state: started.state,
      bindingValue: started.bindingValue,
      ip: IP,
    });

    const events = await auditEventsCollection(db.db).find({}).toArray();

    expect(events).toHaveLength(1);
    expect(events[0]?.action).toBe('auth.google.callback');
    expect(events[0]?.outcome).toBe('success');
    expect(JSON.stringify(events)).not.toContain(EMAIL);
  });

  it('records why a sign in was refused', async () => {
    provider.willReturn(CODE, { email: EMAIL });

    await apiErrorFrom(
      google.complete({
        code: CODE,
        state: 'non_aaaaaaaaaaaaaaaaaaaaa',
        bindingValue: 'anything',
        ip: IP,
      }),
    );

    const events = await auditEventsCollection(db.db).find({}).toArray();

    expect(events[0]?.outcome).toBe('denied');
    expect(events[0]?.reason).toBe('state_invalid_or_replayed');
    expect(events[0]?.ip).toBe(IP);
  });
});
