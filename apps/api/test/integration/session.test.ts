import {
  createTestDatabase,
  createTestRedis,
  type TestDatabase,
  type TestRedis,
} from '@nimbus/test-utils';
import type { AuthenticatedUser } from '@nimbus/contracts';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { OtpService } from '../../src/auth/otp-service.js';
import { SessionService, type ActiveSession } from '../../src/auth/session-service.js';
import { findOrCreateUserByEmail } from '../../src/auth/user-repository.js';
import { ensureDatabaseSchema } from '../../src/db/bootstrap.js';
import { githubInstallationsCollection } from '../../src/db/models/github-installation.js';
import { makeInstallation, makeSession } from '../../src/db/models/model.fixtures.js';
import { sessionsCollection } from '../../src/db/models/session.js';
import { usersCollection } from '../../src/db/models/user.js';
import { CapturingMailer } from '../../src/email/capturing-mailer.js';
import { MailService } from '../../src/email/mail-service.js';
import { createTestLogger, testConfig } from '../../src/http/http.fixtures.js';

const EMAIL = 'person@example.com';
const OTHER_EMAIL = 'other@example.com';
const PLACEHOLDER_CSRF = 'a'.repeat(43);

let db: TestDatabase;
let redis: TestRedis;
let sessions: SessionService;

function buildSessions(overrides: { absoluteLifetimeSeconds?: number } = {}): SessionService {
  const { logger } = createTestLogger();

  return new SessionService({
    redis: redis.client,
    db: db.db,
    config: testConfig(),
    logger,
    ...(overrides.absoluteLifetimeSeconds === undefined
      ? {}
      : { absoluteLifetimeSeconds: overrides.absoluteLifetimeSeconds }),
  });
}

function requireActive(session: ActiveSession | null): ActiveSession {
  if (session === null) {
    throw new Error('Expected the session to be loadable');
  }
  return session;
}

async function makeUser(email = EMAIL): Promise<AuthenticatedUser> {
  const { user } = await findOrCreateUserByEmail(db.db, email, 'email_otp');
  return user;
}

beforeAll(async () => {
  db = await createTestDatabase('nimbus_session');
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
  await githubInstallationsCollection(db.db).deleteMany({});
  await sessionsCollection(db.db).deleteMany({});
  sessions = buildSessions();
});

describe('starting a session', () => {
  it('hands back an identifier that is long and unguessable', async () => {
    const user = await makeUser();

    const started = await sessions.start(user.userId);

    expect(started.sessionId.length).toBeGreaterThanOrEqual(40);
    expect(started.csrfToken.length).toBeGreaterThanOrEqual(40);
    expect(started.sessionId).not.toBe(started.csrfToken);
  });

  it('never stores the identifier itself in Redis', async () => {
    const user = await makeUser();
    const started = await sessions.start(user.userId);

    const keys = await redis.client.keys('nimbus:session:*');

    expect(keys.length).toBeGreaterThan(0);
    expect(keys.some((key) => key.includes(started.sessionId))).toBe(false);
    expect(JSON.stringify(await redis.client.mget(...keys))).not.toContain(started.sessionId);
  });

  it('loads back the person it belongs to', async () => {
    const user = await makeUser();
    const started = await sessions.start(user.userId);

    const loaded = await sessions.load(started.sessionId);

    expect(loaded?.user.userId).toBe(user.userId);
    expect(loaded?.csrfToken).toBe(started.csrfToken);
  });

  it('gives two sessions for one person different identifiers', async () => {
    const user = await makeUser();

    const first = await sessions.start(user.userId);
    const second = await sessions.start(user.userId);

    expect(first.sessionId).not.toBe(second.sessionId);
    expect(await sessions.countForUser(user.userId)).toBe(2);
    expect(await sessions.load(first.sessionId)).not.toBeNull();
  });
});

describe('session fixation', () => {
  it('throws away the identifier the caller already had', async () => {
    const user = await makeUser();
    const planted = await sessions.start(user.userId);

    const replacement = await sessions.start(user.userId, planted.sessionId);

    expect(replacement.sessionId).not.toBe(planted.sessionId);
    expect(await sessions.load(planted.sessionId)).toBeNull();
    expect(await sessions.load(replacement.sessionId)).not.toBeNull();
  });

  it('gives the new session a different CSRF token as well', async () => {
    const user = await makeUser();
    const planted = await sessions.start(user.userId);

    const replacement = await sessions.start(user.userId, planted.sessionId);

    expect(replacement.csrfToken).not.toBe(planted.csrfToken);
  });
});

describe('rejecting what should be rejected', () => {
  it('refuses an invented identifier', async () => {
    expect(await sessions.load('completely-made-up-identifier')).toBeNull();
  });

  it('refuses an empty identifier', async () => {
    expect(await sessions.load('')).toBeNull();
  });

  it('refuses a session whose person no longer exists', async () => {
    const user = await makeUser();
    const started = await sessions.start(user.userId);

    await usersCollection(db.db).deleteMany({});

    expect(await sessions.load(started.sessionId)).toBeNull();
  });
});

describe('expiry', () => {
  it('refreshes the idle clock while the caller is active', async () => {
    const user = await makeUser();
    const started = await sessions.start(user.userId);
    const sessionKey = sessions.keyFor(started.sessionId);

    await redis.client.expire(`nimbus:session:${sessionKey}`, 5);
    expect(await redis.client.ttl(`nimbus:session:${sessionKey}`)).toBeLessThanOrEqual(5);

    await sessions.load(started.sessionId);

    expect(await redis.client.ttl(`nimbus:session:${sessionKey}`)).toBeGreaterThan(60);
  });

  it('forgets a session once the idle clock runs out', async () => {
    const user = await makeUser();
    const started = await sessions.start(user.userId);

    await redis.client.del(`nimbus:session:${sessions.keyFor(started.sessionId)}`);

    expect(await sessions.load(started.sessionId)).toBeNull();
  });

  it('refuses a session past its absolute lifetime even if it stayed busy', async () => {
    const user = await makeUser();
    const shortLived = buildSessions({ absoluteLifetimeSeconds: 1 });
    const started = await shortLived.start(user.userId);

    expect(await shortLived.load(started.sessionId)).not.toBeNull();

    await new Promise((resolve) => setTimeout(resolve, 1_200));

    expect(await shortLived.load(started.sessionId)).toBeNull();
  });

  it('removes the record when the absolute lifetime is reached', async () => {
    const user = await makeUser();
    const shortLived = buildSessions({ absoluteLifetimeSeconds: 1 });
    const started = await shortLived.start(user.userId);

    await new Promise((resolve) => setTimeout(resolve, 1_200));
    await shortLived.load(started.sessionId);

    expect(
      await redis.client.exists(`nimbus:session:${shortLived.keyFor(started.sessionId)}`),
    ).toBe(0);
  });
});

describe('cross site request forgery tokens', () => {
  it('accepts the token that belongs to the session', async () => {
    const user = await makeUser();
    const started = await sessions.start(user.userId);
    const loaded = requireActive(await sessions.load(started.sessionId));

    expect(sessions.csrfMatches(loaded, started.csrfToken)).toBe(true);
  });

  it('refuses an empty or wrong token', async () => {
    const user = await makeUser();
    const started = await sessions.start(user.userId);
    const loaded = requireActive(await sessions.load(started.sessionId));

    expect(sessions.csrfMatches(loaded, '')).toBe(false);
    expect(sessions.csrfMatches(loaded, 'not-the-token')).toBe(false);
    expect(sessions.csrfMatches(loaded, started.csrfToken.slice(0, -1))).toBe(false);
  });

  it('refuses one person token used with another person session', async () => {
    const mine = await makeUser();
    const theirs = await makeUser(OTHER_EMAIL);

    const myStart = await sessions.start(mine.userId);
    const theirStart = await sessions.start(theirs.userId);
    const myLoaded = requireActive(await sessions.load(myStart.sessionId));

    expect(sessions.csrfMatches(myLoaded, theirStart.csrfToken)).toBe(false);
  });

  it('stays the same across repeated reads, so two browser tabs do not fight', async () => {
    const user = await makeUser();
    const started = await sessions.start(user.userId);

    const first = await sessions.load(started.sessionId);
    const second = await sessions.load(started.sessionId);

    expect(first?.csrfToken).toBe(started.csrfToken);
    expect(second?.csrfToken).toBe(started.csrfToken);
  });
});

describe('ending sessions', () => {
  it('ends one and leaves the others alone', async () => {
    const user = await makeUser();
    const first = await sessions.start(user.userId);
    const second = await sessions.start(user.userId);

    expect(await sessions.end(first.sessionId)).toBe(true);

    expect(await sessions.load(first.sessionId)).toBeNull();
    expect(await sessions.load(second.sessionId)).not.toBeNull();
  });

  it('is safe to end the same session twice', async () => {
    const user = await makeUser();
    const started = await sessions.start(user.userId);

    expect(await sessions.end(started.sessionId)).toBe(true);
    expect(await sessions.end(started.sessionId)).toBe(false);
  });

  it('ends every session a person has', async () => {
    const user = await makeUser();
    const first = await sessions.start(user.userId);
    const second = await sessions.start(user.userId);
    const third = await sessions.start(user.userId);

    expect(await sessions.endAllForUser(user.userId)).toBe(3);

    expect(await sessions.load(first.sessionId)).toBeNull();
    expect(await sessions.load(second.sessionId)).toBeNull();
    expect(await sessions.load(third.sessionId)).toBeNull();
  });

  it('does not touch another person sessions', async () => {
    const mine = await makeUser();
    const theirs = await makeUser(OTHER_EMAIL);
    const myStart = await sessions.start(mine.userId);
    const theirStart = await sessions.start(theirs.userId);

    await sessions.endAllForUser(mine.userId);

    expect(await sessions.load(myStart.sessionId)).toBeNull();
    expect(await sessions.load(theirStart.sessionId)).not.toBeNull();
  });
});

describe('a disabled account', () => {
  it('stops working on the very next request', async () => {
    const user = await makeUser();
    const started = await sessions.start(user.userId);

    expect(await sessions.load(started.sessionId)).not.toBeNull();

    await usersCollection(db.db).updateOne(
      { userId: user.userId },
      { $set: { disabledAt: new Date() } },
    );

    expect(await sessions.load(started.sessionId)).toBeNull();
  });

  it('ends every session that person had, not just the one that was used', async () => {
    const user = await makeUser();
    const first = await sessions.start(user.userId);
    const second = await sessions.start(user.userId);

    await usersCollection(db.db).updateOne(
      { userId: user.userId },
      { $set: { disabledAt: new Date() } },
    );

    await sessions.load(first.sessionId);

    expect(await sessions.load(second.sessionId)).toBeNull();
  });
});

describe('the session context', () => {
  it('reports no installation and no active work for a fresh account', async () => {
    const user = await makeUser();
    const started = await sessions.start(user.userId);

    const context = await sessions.context(user, started.csrfToken);

    expect(context.hasActiveInstallation).toBe(false);
    expect(context.hasActiveSession).toBe(false);
    expect(context.user.userId).toBe(user.userId);
  });

  it('notices a connected installation', async () => {
    const user = await makeUser();
    await githubInstallationsCollection(db.db).insertOne(makeInstallation(user.userId));

    const context = await sessions.context(user, PLACEHOLDER_CSRF);

    expect(context.hasActiveInstallation).toBe(true);
  });

  it('ignores an installation that was removed', async () => {
    const user = await makeUser();
    await githubInstallationsCollection(db.db).insertOne(
      makeInstallation(user.userId, { status: 'removed' }),
    );

    const context = await sessions.context(user, PLACEHOLDER_CSRF);

    expect(context.hasActiveInstallation).toBe(false);
  });

  it('notices work in progress and ignores work that finished', async () => {
    const user = await makeUser();
    await sessionsCollection(db.db).insertOne(makeSession(user.userId, { status: 'working' }));

    expect((await sessions.context(user, PLACEHOLDER_CSRF)).hasActiveSession).toBe(true);

    await sessionsCollection(db.db).updateMany({}, { $set: { status: 'pr_created' } });

    expect((await sessions.context(user, PLACEHOLDER_CSRF)).hasActiveSession).toBe(false);
  });

  it('does not report another person work as yours', async () => {
    const mine = await makeUser();
    const theirs = await makeUser(OTHER_EMAIL);
    await sessionsCollection(db.db).insertOne(makeSession(theirs.userId, { status: 'working' }));

    expect((await sessions.context(mine, PLACEHOLDER_CSRF)).hasActiveSession).toBe(false);
  });
});

describe('a complete sign in', () => {
  it('goes from asking for a code to holding a working session', async () => {
    const { logger } = createTestLogger();
    const mailer = new CapturingMailer();
    const otp = new OtpService({
      redis: redis.client,
      db: db.db,
      mail: new MailService(mailer, 'Nimbus <noreply@example.com>'),
      logger,
      config: testConfig(),
    });

    const asked = await otp.requestCode({ email: EMAIL, ip: '203.0.113.10' });
    const code = /\b[0-9]{8}\b/.exec(mailer.lastMessage?.text ?? '')?.[0] ?? '';

    const verified = await otp.verifyCode({
      requestId: asked.requestId,
      email: EMAIL,
      code,
      ip: '203.0.113.10',
    });

    const started = await sessions.start(verified.user.userId);
    const loaded = await sessions.load(started.sessionId);

    expect(verified.created).toBe(true);
    expect(loaded?.user.email).toBe(EMAIL);

    await sessions.end(started.sessionId);
    expect(await sessions.load(started.sessionId)).toBeNull();
  });
});
