import { createTestDatabase, type TestDatabase } from '@nimbus/test-utils';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { LIMITS } from '@nimbus/contracts';

import { MongoAttachmentRecords } from '../../src/attachments/repository.js';
import { HARD_LIMITS } from '../../src/config/limits.js';
import { ensureDatabaseSchema } from '../../src/db/bootstrap.js';
import { sessionsCollection } from '../../src/db/models/session.js';
import { ApiError } from '../../src/http/api-error.js';
import { capturingLogger } from '../../src/llm/llm.fixtures.js';
import { SELECTABLE_TEXT_MODELS } from '../../src/routing/selection.js';
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

describe('the configured step budget, against the real collection', () => {
  it('writes the configured value and reads it back', async () => {
    const tightened = new AgentSessionService({
      records: new MongoSessionRecords(testDatabase.db),
      attachments: new MongoAttachmentRecords(testDatabase.db),
      repositories: new FakeRepositoryDirectory([SHOPFRONT]),
      logger: capturingLogger().logger,
      maxSteps: 7,
    });

    const created = await tightened.create(OWNER_ID, keyed('a'));
    const stored = await sessionsCollection(testDatabase.db).findOne({
      sessionId: created.session.sessionId,
    });

    expect(stored?.maxSteps).toBe(7);
    expect((await tightened.detail(OWNER_ID, created.session.sessionId)).session).toBeDefined();
  });

  it('passes the collection validator at the highest value this build supports', async () => {
    const widest = new AgentSessionService({
      records: new MongoSessionRecords(testDatabase.db),
      attachments: new MongoAttachmentRecords(testDatabase.db),
      repositories: new FakeRepositoryDirectory([SHOPFRONT]),
      logger: capturingLogger().logger,
      maxSteps: HARD_LIMITS.maxAgentSteps,
    });

    const created = await widest.create(OWNER_ID, keyed('a'));
    const stored = await sessionsCollection(testDatabase.db).findOne({
      sessionId: created.session.sessionId,
    });

    expect(stored?.maxSteps).toBe(HARD_LIMITS.maxAgentSteps);
  });

  it('keeps its own budget when a worker picks it up after the configuration changed', async () => {
    const started = new AgentSessionService({
      records: new MongoSessionRecords(testDatabase.db),
      attachments: new MongoAttachmentRecords(testDatabase.db),
      repositories: new FakeRepositoryDirectory([SHOPFRONT]),
      logger: capturingLogger().logger,
      maxSteps: 7,
    });

    const created = await started.create(OWNER_ID, keyed('a'));
    const claimed = await new MongoSessionRecords(testDatabase.db).findClaimable(10);
    const found = claimed.find((one) => one.sessionId === created.session.sessionId);

    expect(found?.maxSteps).toBe(7);
  });
});

describe('a chosen model, against the real collection', () => {
  for (const model of SELECTABLE_TEXT_MODELS) {
    it(`survives the round trip for ${model}`, async () => {
      const created = await service.create(OWNER_ID, {
        ...keyed('a'),
        model: { textModel: model },
      });

      const stored = await sessionsCollection(testDatabase.db).findOne({
        sessionId: created.session.sessionId,
      });

      expect(stored?.model).toEqual({ textModel: model });
    });
  }

  it('is read back by a worker that never saw the request', async () => {
    const created = await service.create(OWNER_ID, {
      ...keyed('a'),
      model: { textModel: 'openai/gpt-oss-120b' },
    });

    const worker = new MongoSessionRecords(testDatabase.db);
    const claimable = await worker.findClaimable(10);
    const found = claimable.find((one) => one.sessionId === created.session.sessionId);

    expect(found?.model).toEqual({ textModel: 'openai/gpt-oss-120b' });
  });

  it('writes null rather than leaving the field out when nobody chose', async () => {
    const created = await service.create(OWNER_ID, keyed('a'));
    const stored = await sessionsCollection(testDatabase.db).findOne({
      sessionId: created.session.sessionId,
    });

    expect(stored?.model).toBeNull();
  });

  it('lets a session written before the field existed keep working', async () => {
    const created = await service.create(OWNER_ID, keyed('a'));

    await sessionsCollection(testDatabase.db).updateOne(
      { sessionId: created.session.sessionId },
      { $unset: { model: '' } },
    );

    const older = await sessionsCollection(testDatabase.db).findOne({
      sessionId: created.session.sessionId,
    });

    expect(older?.model).toBeUndefined();

    const moved = await new MongoSessionRecords(testDatabase.db).finish(
      OWNER_ID,
      created.session.sessionId,
      'cancelled',
      new Date(),
    );

    expect(moved).not.toBeNull();
    expect((await service.detail(OWNER_ID, created.session.sessionId)).session.model).toBeNull();
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

describe('pinning the repository base in the real collection', () => {
  it('keeps the winner when concurrent workers resolve different default heads', async () => {
    const created = await service.create(OWNER_ID, newBody());
    const records = new MongoSessionRecords(testDatabase.db);
    const candidates = ['1'.repeat(40), '2'.repeat(40), '3'.repeat(40)];

    const pinned = await Promise.all(
      candidates.map((candidate) =>
        records.pinBaseCommitSha(created.session.sessionId, candidate, new Date()),
      ),
    );
    const stored = await sessionsCollection(testDatabase.db).findOne({
      sessionId: created.session.sessionId,
    });

    expect(candidates).toContain(stored?.baseCommitSha);
    expect(new Set(pinned)).toEqual(new Set([stored?.baseCommitSha]));
  });

  it('does not write after the session has become terminal', async () => {
    const created = await service.create(OWNER_ID, newBody());
    const records = new MongoSessionRecords(testDatabase.db);
    await records.finish(OWNER_ID, created.session.sessionId, 'cancelled', new Date());

    expect(
      await records.pinBaseCommitSha(created.session.sessionId, '4'.repeat(40), new Date()),
    ).toBeNull();
    expect(
      (
        await sessionsCollection(testDatabase.db).findOne({
          sessionId: created.session.sessionId,
        })
      )?.baseCommitSha,
    ).toBeNull();
  });
});

describe('a conversation kept on a session', () => {
  it('keeps both sides, in the order they were said', async () => {
    const created = await service.create(OWNER_ID, keyed('a'));
    const records = new MongoSessionRecords(testDatabase.db);
    const sessionId = created.session.sessionId;

    await records.addMessage(OWNER_ID, sessionId, 'keep the old link working', new Date());
    await records.addAgentMessage(sessionId, 'I found the redirect.', new Date());

    expect((await records.conversationOf(sessionId)).map((one) => one.role)).toStrictEqual([
      'user',
      'agent',
    ]);
    const ids = (await records.conversationOf(sessionId)).map((one) => one.messageId);
    expect(ids.every((id) => id.startsWith('msg_'))).toBe(true);
    expect(new Set(ids).size).toBe(2);
  });

  it('turns concurrent retries into exactly one message with the winner identity', async () => {
    const created = await service.create(OWNER_ID, keyed('a'));
    const records = new MongoSessionRecords(testDatabase.db);
    const sessionId = created.session.sessionId;
    const idempotencyKey = testId('idk', 'm');

    const results = await Promise.all(
      Array.from({ length: 8 }, (_value, index) =>
        records.writeUserMessage(OWNER_ID, sessionId, {
          messageId: testId('msg', String(index)),
          text: 'keep the old link working',
          sentAt: new Date(),
          idempotencyKey,
        }),
      ),
    );

    expect(results.filter((result) => result.outcome === 'created')).toHaveLength(1);
    expect(results.filter((result) => result.outcome === 'same_request')).toHaveLength(7);
    expect(
      new Set(
        results.map((result) => (result.message === null ? 'none' : result.message.messageId)),
      ).size,
    ).toBe(1);
    expect(await records.conversationOf(sessionId)).toHaveLength(1);
  });

  it('distinguishes a safe retry from the same key carrying different text', async () => {
    const created = await service.create(OWNER_ID, keyed('a'));
    const records = new MongoSessionRecords(testDatabase.db);
    const sessionId = created.session.sessionId;
    const idempotencyKey = testId('idk', 'm');
    const first = {
      messageId: testId('msg', 'a'),
      text: 'keep the old link working',
      sentAt: new Date(),
      idempotencyKey,
    };

    expect((await records.writeUserMessage(OWNER_ID, sessionId, first)).outcome).toBe('created');
    expect((await records.writeUserMessage(OWNER_ID, sessionId, first)).outcome).toBe(
      'same_request',
    );
    expect(
      (
        await records.writeUserMessage(OWNER_ID, sessionId, {
          ...first,
          messageId: testId('msg', 'b'),
          text: 'a different instruction',
        })
      ).outcome,
    ).toBe('conflict');
    expect(await records.conversationOf(sessionId)).toHaveLength(1);
  });

  it('can acknowledge a completed-session retry without creating another message', async () => {
    const created = await service.create(OWNER_ID, keyed('a'));
    const records = new MongoSessionRecords(testDatabase.db);
    const input = {
      messageId: testId('msg', 'a'),
      text: 'keep the old link working',
      sentAt: new Date(),
      idempotencyKey: testId('idk', 'm'),
    };
    const first = await records.writeUserMessage(OWNER_ID, created.session.sessionId, input);
    await records.finish(OWNER_ID, created.session.sessionId, 'cancelled', new Date());
    const retry = await records.writeUserMessage(OWNER_ID, created.session.sessionId, input);

    expect(first.outcome).toBe('created');
    expect(retry.outcome).toBe('same_request');
    expect(retry.message?.messageId).toBe(first.message?.messageId);
  });

  it('comes back on the session detail, so a reload shows it', async () => {
    const created = await service.create(OWNER_ID, keyed('a'));
    const records = new MongoSessionRecords(testDatabase.db);

    await records.addMessage(
      OWNER_ID,
      created.session.sessionId,
      'keep the old link working',
      new Date(),
    );

    const detail = await service.detail(OWNER_ID, created.session.sessionId);

    expect(detail.session.messages).toHaveLength(1);
    expect(detail.session.messages[0]?.role).toBe('user');
  });

  it('accepts a message written before roles existed, and reads it as the person', async () => {
    const created = await service.create(OWNER_ID, keyed('a'));
    const sessionId = created.session.sessionId;

    await sessionsCollection(testDatabase.db).updateOne(
      { sessionId },
      { $push: { messages: { text: 'an older message', sentAt: new Date() } } },
    );

    const records = new MongoSessionRecords(testDatabase.db);
    await records.addAgentMessage(sessionId, 'a newer one', new Date());

    const conversation = await records.conversationOf(sessionId);
    const reread = await records.conversationOf(sessionId);

    expect(conversation.map((one) => one.role)).toStrictEqual(['user', 'agent']);
    expect(conversation[0]?.messageId).toMatch(/^msg_/);
    expect(reread[0]?.messageId).toBe(conversation[0]?.messageId);
  });

  it('keeps the newest turns once it is full, and the validator still accepts it', async () => {
    const created = await service.create(OWNER_ID, keyed('a'));
    const records = new MongoSessionRecords(testDatabase.db);
    const sessionId = created.session.sessionId;

    for (let at = 0; at < LIMITS.maxMessagesPerSession + 3; at += 1) {
      await records.addAgentMessage(sessionId, `turn ${String(at)}`, new Date());
    }

    const conversation = await records.conversationOf(sessionId);

    expect(conversation).toHaveLength(LIMITS.maxMessagesPerSession);
    expect(conversation.at(-1)?.text).toBe(`turn ${String(LIMITS.maxMessagesPerSession + 2)}`);
  });

  it('refuses to keep anything once the session has ended', async () => {
    const created = await service.create(OWNER_ID, keyed('a'));
    const sessionId = created.session.sessionId;

    await service.cancel(OWNER_ID, sessionId);

    const records = new MongoSessionRecords(testDatabase.db);

    expect(await records.addAgentMessage(sessionId, 'too late', new Date())).toBe(false);
    expect(await records.conversationOf(sessionId)).toHaveLength(0);
  });
});
