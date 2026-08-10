import { createTestDatabase, type TestDatabase } from '@nimbus/test-utils';
import type { MongoServerError } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ensureDatabaseSchema } from '../../src/db/bootstrap.js';
import { newPrefixedId } from '../../src/lib/id.js';
import {
  auditEventsCollection,
  buildAuditEvent,
  githubInstallationsCollection,
  normalizeEmail,
  repoIndexesCollection,
  sessionsCollection,
  usersCollection,
} from '../../src/db/models/index.js';
import {
  makeCommitSha,
  makeInstallation,
  makeRepoIndex,
  makeSession,
  makeUser,
} from '../../src/db/models/model.fixtures.js';

const DUPLICATE_KEY = 11_000;
const VALIDATION_FAILED = 121;

let testDatabase: TestDatabase;

beforeAll(async () => {
  testDatabase = await createTestDatabase('nimbus_models');
  await ensureDatabaseSchema(testDatabase.db);
});

afterAll(async () => {
  await testDatabase.cleanup();
});

function errorCode(error: unknown): number | undefined {
  return (error as MongoServerError | undefined)?.code as number | undefined;
}

async function captureError(action: Promise<unknown>): Promise<unknown> {
  try {
    await action;
    return undefined;
  } catch (error) {
    return error;
  }
}

describe('users', () => {
  it('accepts a well formed user', async () => {
    const result = await usersCollection(testDatabase.db).insertOne(makeUser());
    expect(result.acknowledged).toBe(true);
  });

  it('refuses a second user with the same email', async () => {
    const email = normalizeEmail('Duplicate.Person@Example.com');
    await usersCollection(testDatabase.db).insertOne(makeUser({ email }));

    const error = await captureError(
      usersCollection(testDatabase.db).insertOne(makeUser({ email })),
    );

    expect(errorCode(error)).toBe(DUPLICATE_KEY);
  });

  it('refuses a second user with the same public id', async () => {
    const userId = newPrefixedId('usr');
    await usersCollection(testDatabase.db).insertOne(makeUser({ userId }));

    const error = await captureError(
      usersCollection(testDatabase.db).insertOne(makeUser({ userId })),
    );

    expect(errorCode(error)).toBe(DUPLICATE_KEY);
  });

  it('refuses an email that was never normalized', async () => {
    const error = await captureError(
      usersCollection(testDatabase.db).insertOne(makeUser({ email: 'Shouty@Example.com' })),
    );

    expect(errorCode(error)).toBe(VALIDATION_FAILED);
  });

  it('refuses a user id that does not match the public id shape', async () => {
    const error = await captureError(
      usersCollection(testDatabase.db).insertOne(makeUser({ userId: 'usr_short' })),
    );

    expect(errorCode(error)).toBe(VALIDATION_FAILED);
  });

  it('refuses a user with no login provider', async () => {
    const error = await captureError(
      usersCollection(testDatabase.db).insertOne(makeUser({ authProviders: [] })),
    );

    expect(errorCode(error)).toBe(VALIDATION_FAILED);
  });

  it('refuses a field the model does not declare', async () => {
    const user = { ...makeUser(), passwordHash: 'nope' };

    const error = await captureError(usersCollection(testDatabase.db).insertOne(user));

    expect(errorCode(error)).toBe(VALIDATION_FAILED);
  });

  it('refuses a missing required field', async () => {
    const user = makeUser();
    const withoutDisplayName: Record<string, unknown> = { ...user };
    delete withoutDisplayName['displayName'];

    const error = await captureError(
      testDatabase.db.collection('users').insertOne(withoutDisplayName),
    );

    expect(errorCode(error)).toBe(VALIDATION_FAILED);
  });
});

describe('github installations', () => {
  it('refuses two records for the same github installation id', async () => {
    const userId = newPrefixedId('usr');
    const installationId = 55_000_001;
    await githubInstallationsCollection(testDatabase.db).insertOne(
      makeInstallation(userId, { installationId }),
    );

    const error = await captureError(
      githubInstallationsCollection(testDatabase.db).insertOne(
        makeInstallation(newPrefixedId('usr'), { installationId }),
      ),
    );

    expect(errorCode(error)).toBe(DUPLICATE_KEY);
  });

  it('allows one user to hold several distinct installations', async () => {
    const userId = newPrefixedId('usr');

    await githubInstallationsCollection(testDatabase.db).insertOne(makeInstallation(userId));
    const second = await githubInstallationsCollection(testDatabase.db).insertOne(
      makeInstallation(userId),
    );

    expect(second.acknowledged).toBe(true);
  });

  it('refuses an unknown status', async () => {
    const installation = { ...makeInstallation(newPrefixedId('usr')), status: 'exploded' };

    const error = await captureError(
      testDatabase.db.collection('github_installations').insertOne(installation),
    );

    expect(errorCode(error)).toBe(VALIDATION_FAILED);
  });
});

describe('one active session per user', () => {
  it('allows the first active session', async () => {
    const result = await sessionsCollection(testDatabase.db).insertOne(
      makeSession(newPrefixedId('usr')),
    );
    expect(result.acknowledged).toBe(true);
  });

  it('refuses a second active session for the same user', async () => {
    const userId = newPrefixedId('usr');
    await sessionsCollection(testDatabase.db).insertOne(makeSession(userId, { status: 'working' }));

    const error = await captureError(
      sessionsCollection(testDatabase.db).insertOne(makeSession(userId, { status: 'queued' })),
    );

    expect(errorCode(error)).toBe(DUPLICATE_KEY);
  });

  it('lets exactly one of five simultaneous creations win', async () => {
    const userId = newPrefixedId('usr');

    const outcomes = await Promise.allSettled([
      sessionsCollection(testDatabase.db).insertOne(makeSession(userId)),
      sessionsCollection(testDatabase.db).insertOne(makeSession(userId)),
      sessionsCollection(testDatabase.db).insertOne(makeSession(userId)),
      sessionsCollection(testDatabase.db).insertOne(makeSession(userId)),
      sessionsCollection(testDatabase.db).insertOne(makeSession(userId)),
    ]);

    const succeeded = outcomes.filter((outcome) => outcome.status === 'fulfilled');
    const rejected = outcomes.filter((outcome) => outcome.status === 'rejected');

    expect(succeeded).toHaveLength(1);
    expect(rejected).toHaveLength(4);
    expect(rejected.every((outcome) => errorCode(outcome.reason) === DUPLICATE_KEY)).toBe(true);

    const stored = await sessionsCollection(testDatabase.db).countDocuments({ userId });
    expect(stored).toBe(1);
  });

  it('frees the slot once the session reaches a terminal status', async () => {
    const userId = newPrefixedId('usr');
    const first = makeSession(userId, { status: 'working' });
    await sessionsCollection(testDatabase.db).insertOne(first);

    await sessionsCollection(testDatabase.db).updateOne(
      { sessionId: first.sessionId },
      { $set: { status: 'pr_created', completedAt: new Date() } },
    );

    const second = await sessionsCollection(testDatabase.db).insertOne(makeSession(userId));
    expect(second.acknowledged).toBe(true);
  });

  it('keeps unlimited finished sessions in history', async () => {
    const userId = newPrefixedId('usr');

    for (const status of ['pr_created', 'failed', 'cancelled', 'pr_created'] as const) {
      await sessionsCollection(testDatabase.db).insertOne(
        makeSession(userId, { status, completedAt: new Date() }),
      );
    }

    const stored = await sessionsCollection(testDatabase.db).countDocuments({ userId });
    expect(stored).toBe(4);
  });

  it('does not restrict different users working at the same time', async () => {
    const outcomes = await Promise.all([
      sessionsCollection(testDatabase.db).insertOne(makeSession(newPrefixedId('usr'))),
      sessionsCollection(testDatabase.db).insertOne(makeSession(newPrefixedId('usr'))),
      sessionsCollection(testDatabase.db).insertOne(makeSession(newPrefixedId('usr'))),
    ]);

    expect(outcomes.every((outcome) => outcome.acknowledged)).toBe(true);
  });

  it('refuses a repeated idempotency key for the same user', async () => {
    const userId = newPrefixedId('usr');
    const idempotencyKey = newPrefixedId('idk');

    await sessionsCollection(testDatabase.db).insertOne(
      makeSession(userId, { idempotencyKey, status: 'cancelled', completedAt: new Date() }),
    );

    const error = await captureError(
      sessionsCollection(testDatabase.db).insertOne(
        makeSession(userId, { idempotencyKey, status: 'cancelled', completedAt: new Date() }),
      ),
    );

    expect(errorCode(error)).toBe(DUPLICATE_KEY);
  });

  it('refuses a status the state machine does not define', async () => {
    const session = { ...makeSession(newPrefixedId('usr')), status: 'banana' };

    const error = await captureError(testDatabase.db.collection('sessions').insertOne(session));

    expect(errorCode(error)).toBe(VALIDATION_FAILED);
  });

  it('refuses a base commit sha that is not a real sha', async () => {
    const error = await captureError(
      sessionsCollection(testDatabase.db).insertOne(
        makeSession(newPrefixedId('usr'), { baseCommitSha: 'not-a-sha' }),
      ),
    );

    expect(errorCode(error)).toBe(VALIDATION_FAILED);
  });

  it('accepts a real commit sha', async () => {
    const result = await sessionsCollection(testDatabase.db).insertOne(
      makeSession(newPrefixedId('usr'), { baseCommitSha: makeCommitSha() }),
    );

    expect(result.acknowledged).toBe(true);
  });
});

describe('repository indexes', () => {
  it('keys an index by repository and commit together', async () => {
    const identity = { repositoryId: 900_001, commitSha: makeCommitSha() };

    await repoIndexesCollection(testDatabase.db).insertOne(makeRepoIndex(identity));

    const error = await captureError(
      repoIndexesCollection(testDatabase.db).insertOne(makeRepoIndex(identity)),
    );

    expect(errorCode(error)).toBe(DUPLICATE_KEY);
  });

  it('allows the same repository at a different commit', async () => {
    const repositoryId = 900_002;

    await repoIndexesCollection(testDatabase.db).insertOne(makeRepoIndex({ repositoryId }));
    const second = await repoIndexesCollection(testDatabase.db).insertOne(
      makeRepoIndex({ repositoryId }),
    );

    expect(second.acknowledged).toBe(true);
  });

  it('allows the same commit under a different embedding model', async () => {
    const identity = { repositoryId: 900_003, commitSha: makeCommitSha() };

    await repoIndexesCollection(testDatabase.db).insertOne(makeRepoIndex(identity));
    const second = await repoIndexesCollection(testDatabase.db).insertOne(
      makeRepoIndex({ ...identity, embeddingModel: 'text-embedding-fake-2' }),
    );

    expect(second.acknowledged).toBe(true);
  });
});

describe('audit events', () => {
  it('stores an event and strips secrets on the way in', async () => {
    const event = buildAuditEvent({
      action: 'github.token.minted',
      outcome: 'success',
      actorType: 'system',
      repositoryId: 1_296_269,
      metadata: { accessToken: 'ghs_abcdefghijklmnopqrstuvwxyz012345', permissions: 'contents' },
    });

    await auditEventsCollection(testDatabase.db).insertOne(event);

    const stored = await auditEventsCollection(testDatabase.db).findOne({
      auditEventId: event.auditEventId,
    });

    expect(stored).not.toBeNull();
    expect(JSON.stringify(stored?.metadata)).not.toContain('ghs_abcdefghijklmnopqrstuvwxyz012345');
    expect(stored?.metadata['permissions']).toBe('contents');
  });

  it('refuses an action that is not in the known list', async () => {
    const event = {
      ...buildAuditEvent({ action: 'auth.login', outcome: 'success', actorType: 'user' }),
      action: 'made.up.action',
    };

    const error = await captureError(testDatabase.db.collection('audit_events').insertOne(event));

    expect(errorCode(error)).toBe(VALIDATION_FAILED);
  });
});
