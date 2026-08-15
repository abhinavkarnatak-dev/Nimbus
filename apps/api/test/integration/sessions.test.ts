import { createTestDatabase, type TestDatabase } from '@nimbus/test-utils';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { MongoAttachmentRecords } from '../../src/attachments/repository.js';
import { ensureDatabaseSchema } from '../../src/db/bootstrap.js';
import { sessionsCollection } from '../../src/db/models/session.js';
import { ApiError } from '../../src/http/api-error.js';
import { capturingLogger } from '../../src/llm/llm.fixtures.js';
import { MongoSessionRecords } from '../../src/sessions/repository.js';
import { AgentSessionService } from '../../src/sessions/service.js';
import {
  CLEAR_TASK,
  FakeRepositoryDirectory,
  OTHER_ID,
  OWNER_ID,
  SHOPFRONT,
  newBody,
  testId,
} from '../../src/sessions/sessions.fixtures.js';

let testDatabase: TestDatabase;
let service: AgentSessionService;

function keyed(letter: string): ReturnType<typeof newBody> {
  return newBody({ idempotencyKey: testId('idk', letter) });
}

async function codeOf(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (error) {
    return error instanceof ApiError ? error.code : 'NOT_AN_API_ERROR';
  }
  return 'NO_ERROR';
}

beforeAll(async () => {
  testDatabase = await createTestDatabase();
  await ensureDatabaseSchema(testDatabase.db, capturingLogger().logger);

  service = new AgentSessionService({
    records: new MongoSessionRecords(testDatabase.db),
    attachments: new MongoAttachmentRecords(testDatabase.db),
    repositories: new FakeRepositoryDirectory([SHOPFRONT]),
    logger: capturingLogger().logger,
  });
}, 60_000);

afterAll(async () => {
  await testDatabase.cleanup();
});

beforeEach(async () => {
  await sessionsCollection(testDatabase.db).deleteMany({});
});

describe('many people pressing start at once', () => {
  it('leaves exactly one active session, whoever wins', async () => {
    const attempts = Array.from({ length: 8 }, (_value, index) =>
      service.create(OWNER_ID, keyed(String.fromCharCode(97 + index))),
    );

    const settled = await Promise.allSettled(attempts);
    const started = settled.filter((one) => one.status === 'fulfilled');

    expect(started).toHaveLength(1);
    expect(await sessionsCollection(testDatabase.db).countDocuments({ userId: OWNER_ID })).toBe(1);
  });

  it('refuses every loser with the same answer', async () => {
    const attempts = Array.from({ length: 6 }, (_value, index) =>
      codeOf(service.create(OWNER_ID, keyed(String.fromCharCode(97 + index)))),
    );

    const codes = await Promise.all(attempts);
    const refused = codes.filter((code) => code !== 'NO_ERROR');

    expect(refused).toHaveLength(5);
    expect(new Set(refused)).toEqual(new Set(['ACTIVE_SESSION_EXISTS']));
  });

  it('lets two different people each start one at the same time', async () => {
    const settled = await Promise.allSettled([
      service.create(OWNER_ID, keyed('a')),
      service.create(OTHER_ID, keyed('b')),
    ]);

    expect(settled.filter((one) => one.status === 'fulfilled')).toHaveLength(2);
  });
});

describe('the same request arriving twice at once', () => {
  it('writes one row and answers with the same session both times', async () => {
    const settled = await Promise.allSettled([
      service.create(OWNER_ID, keyed('a')),
      service.create(OWNER_ID, keyed('a')),
    ]);

    const ids = settled
      .filter((one) => one.status === 'fulfilled')
      .map((one) => (one as PromiseFulfilledResult<{ session: { sessionId: string } }>).value)
      .map((one) => one.session.sessionId);

    expect(new Set(ids).size).toBe(1);
    expect(await sessionsCollection(testDatabase.db).countDocuments({})).toBe(1);
  });

  it('is told apart from a genuinely second request', async () => {
    await service.create(OWNER_ID, keyed('a'));

    const same = await service.create(OWNER_ID, keyed('a'));
    const different = await codeOf(service.create(OWNER_ID, keyed('b')));

    expect(same.created).toBe(false);
    expect(different).toBe('ACTIVE_SESSION_EXISTS');
  });

  it('answers a retry even though both unique rules are broken at once', async () => {
    const first = await service.create(OWNER_ID, keyed('a'));
    const retry = await service.create(OWNER_ID, keyed('a'));

    expect(retry.session.sessionId).toBe(first.session.sessionId);
  });

  it('still refuses a retry once that session has finished and another is running', async () => {
    const first = await service.create(OWNER_ID, keyed('a'));
    await service.cancel(OWNER_ID, first.session.sessionId);
    await service.create(OWNER_ID, keyed('b'));

    const retry = await service.create(OWNER_ID, keyed('a'));

    expect(retry.created).toBe(false);
    expect(retry.session.sessionId).toBe(first.session.sessionId);
  });
});

describe('a real session, read back', () => {
  it('stores everything the detail route needs', async () => {
    const created = await service.create(OWNER_ID, keyed('a'));
    const detail = await service.detail(OWNER_ID, created.session.sessionId);

    expect(detail.session.task).toBe(CLEAR_TASK);
    expect(detail.session.repository.repositoryId).toBe(SHOPFRONT.repositoryId);
    expect(detail.lastEventSequence).toBe(0);
  });

  it('passes the collection validator, which is the real shape check', async () => {
    const created = await service.create(OWNER_ID, keyed('a'));
    const stored = await sessionsCollection(testDatabase.db).findOne({
      sessionId: created.session.sessionId,
    });

    expect(stored).not.toBeNull();
    expect(stored?.status).toBe('queued');
  });

  it('is not visible to anybody else', async () => {
    const created = await service.create(OWNER_ID, keyed('a'));

    expect(await codeOf(service.detail(OTHER_ID, created.session.sessionId))).toBe('NOT_FOUND');
    expect(await codeOf(service.cancel(OTHER_ID, created.session.sessionId))).toBe('NOT_FOUND');
  });
});

describe('cancelling for real', () => {
  it('frees the slot so the next session can start', async () => {
    const created = await service.create(OWNER_ID, keyed('a'));
    await service.cancel(OWNER_ID, created.session.sessionId);

    expect((await service.create(OWNER_ID, keyed('b'))).created).toBe(true);
  });

  it('changes one session even when two cancels arrive together', async () => {
    const created = await service.create(OWNER_ID, keyed('a'));

    const codes = await Promise.all([
      codeOf(service.cancel(OWNER_ID, created.session.sessionId)),
      codeOf(service.cancel(OWNER_ID, created.session.sessionId)),
    ]);

    expect(codes.filter((code) => code === 'NO_ERROR')).toHaveLength(1);
    expect(codes.filter((code) => code === 'SESSION_NOT_ACTIVE')).toHaveLength(1);
  });

  it('never moves a session that has already ended', async () => {
    const created = await service.create(OWNER_ID, keyed('a'));
    const cancelled = await service.cancel(OWNER_ID, created.session.sessionId);

    await codeOf(service.cancel(OWNER_ID, created.session.sessionId));

    const stored = await sessionsCollection(testDatabase.db).findOne({
      sessionId: created.session.sessionId,
    });

    expect(stored?.completedAt?.toISOString()).toBe(cancelled.completedAt);
  });
});
