import {
  createTestDatabase,
  createTestRedis,
  type TestDatabase,
  type TestRedis,
} from '@nimbus/test-utils';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { ensureDatabaseSchema } from '../../src/db/bootstrap.js';
import { sessionsCollection } from '../../src/db/models/session.js';
import { capturingLogger } from '../../src/llm/llm.fixtures.js';
import { RedisCancelAnnouncer, RedisCancelWatcher } from '../../src/orchestrator/cancellation.js';
import { leaseResource } from '../../src/orchestrator/claim.js';
import { Orchestrator } from '../../src/orchestrator/orchestrator.js';
import { LiveEventPublisher } from '../../src/events/publisher.js';
import { MongoEventStore } from '../../src/events/store.js';
import { WAIT_LIMITS } from '../../src/orchestrator/limits.js';
import {
  CLEAR_SCOPE,
  FINISHING_ANSWERS,
  FakeWorkshop,
  NEVER_CLEAR_ANSWERS,
  answer,
  RecordingPullRequestGateway,
  RecordingPushGateway,
  pendingApproval,
  sessionDocument,
} from '../../src/orchestrator/orchestrator.fixtures.js';
import { SessionRunner } from '../../src/orchestrator/runner.js';
import { WaitingSessionSweeper } from '../../src/orchestrator/waiting-sweeper.js';
import { LeaseManager } from '../../src/redis/lease.js';
import { MongoApprovals } from '../../src/sessions/approvals.js';
import { MongoSessionRecords } from '../../src/sessions/repository.js';

let testDatabase: TestDatabase;
let redis: TestRedis;
let records: MongoSessionRecords;
let leases: LeaseManager;

const push = new RecordingPushGateway();
const pullRequests = new RecordingPullRequestGateway();

function workerWith(
  options: { answers?: readonly { value: unknown }[]; hang?: boolean; watchCancels?: boolean } = {},
): {
  orchestrator: Orchestrator;
  workshop: FakeWorkshop;
  logs: () => string;
} {
  const captured = capturingLogger();

  const workshop = new FakeWorkshop({
    logger: captured.logger,
    answers: options.answers ?? FINISHING_ANSWERS,
  });

  const runner = new SessionRunner({
    workshop,
    push,
    pullRequests,
    logger: captured.logger,
    notifyEmailFor: async () => Promise.resolve('person@example.com'),
  });

  return {
    orchestrator: new Orchestrator({
      records,
      leases,
      runner,
      logger: captured.logger,
      heartbeatMs: 60_000,
      leaseSeconds: 2,
      ...(options.watchCancels === true
        ? {
            cancellations: new RedisCancelWatcher({
              redis: redis.client,
              logger: captured.logger,
            }),
          }
        : {}),
    }),
    workshop,
    logs: captured.text,
  };
}

async function settle(): Promise<void> {
  for (let round = 0; round < 60; round += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

beforeAll(async () => {
  testDatabase = await createTestDatabase();
  await ensureDatabaseSchema(testDatabase.db, capturingLogger().logger);

  redis = await createTestRedis();
  records = new MongoSessionRecords(testDatabase.db);
  leases = new LeaseManager(redis.client);
}, 60_000);

afterAll(async () => {
  await testDatabase.cleanup();
  await redis.cleanup();
});

beforeEach(async () => {
  await sessionsCollection(testDatabase.db).deleteMany({});
  await redis.client.flushdb();
  push.calls.length = 0;
  pullRequests.calls.length = 0;
});

describe('two workers reaching for one session', () => {
  it('produces one branch and one pull request', async () => {
    const session = sessionDocument();
    await records.insert(session);

    const first = workerWith();
    const second = workerWith();

    await Promise.all([first.orchestrator.tick(), second.orchestrator.tick()]);
    await settle();

    expect(push.calls).toHaveLength(1);
    expect(pullRequests.calls).toHaveLength(1);
  });

  it('leaves exactly one of them holding the session', async () => {
    const session = sessionDocument();
    await records.insert(session);

    const first = workerWith();
    const second = workerWith();

    const taken = await Promise.all([
      first.orchestrator.take(session),
      second.orchestrator.take(session),
    ]);

    expect(taken.filter(Boolean)).toHaveLength(1);
    await settle();
  });

  it('ends with the session written once and finished', async () => {
    const session = sessionDocument();
    await records.insert(session);

    await Promise.all([workerWith().orchestrator.tick(), workerWith().orchestrator.tick()]);
    await settle();

    const stored = await sessionsCollection(testDatabase.db).findOne({
      sessionId: session.sessionId,
    });

    expect(stored?.status).toBe('pr_created');
    expect(stored?.pullRequest?.number).toBe(1);
  });
});

describe('a worker that dies mid run', () => {
  it('leaves the session behind with a lease that expires', async () => {
    const session = sessionDocument({ status: 'working' });
    await records.insert(session);

    const lease = await leases.acquire(leaseResource(session.sessionId), 1);
    expect(lease).not.toBeNull();

    const other = workerWith();
    const takenWhileHeld = await other.orchestrator.take(session);

    expect(takenWhileHeld).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 1_200));

    const takenAfter = await other.orchestrator.take(session);
    expect(takenAfter).toBe(true);
    await settle();
  });

  it('is resumed by the next worker and still ends in one pull request', async () => {
    const session = sessionDocument({ status: 'working' });
    await records.insert(session);

    const worker = workerWith();
    await worker.orchestrator.tick();
    await settle();

    const stored = await sessionsCollection(testDatabase.db).findOne({
      sessionId: session.sessionId,
    });

    expect(stored?.status).toBe('pr_created');
    expect(push.calls).toHaveLength(1);
    expect(worker.logs()).toContain('left behind by a worker');
  });

  it('counts the recovery on the session, so it cannot loop forever', async () => {
    const session = sessionDocument({ status: 'working' });
    await records.insert(session);

    await workerWith().orchestrator.tick();
    await settle();

    const stored = await sessionsCollection(testDatabase.db).findOne({
      sessionId: session.sessionId,
    });

    expect(stored?.retryCount).toBe(1);
  });
});

describe('a session that has already ended', () => {
  it('is never picked up, because it is not claimable', async () => {
    const session = sessionDocument({ status: 'cancelled', completedAt: new Date() });
    await records.insert(session);

    const worker = workerWith();
    const started = await worker.orchestrator.tick();

    expect(started).toBe(0);
    expect(worker.workshop.prepared).toHaveLength(0);
  });
});

describe('no orphan sandbox', () => {
  it('tears down the machine it rented, whatever the run did', async () => {
    const session = sessionDocument();
    await records.insert(session);

    const worker = workerWith();
    await worker.orchestrator.tick();
    await settle();

    const sandbox = worker.workshop.sandboxes[0];

    expect(sandbox?.status().state).toBe('terminated');
  });

  it('tears it down even when the run never reached a patch', async () => {
    const session = sessionDocument();
    await records.insert(session);

    const worker = workerWith({ answers: [{ value: { clear: true, question: '' } }] });
    await worker.orchestrator.tick();
    await settle();

    expect(worker.workshop.sandboxes[0]?.status().state).toBe('terminated');
  });

  it('tells the sweeper the session is over, so anything left behind is killed', async () => {
    const session = sessionDocument();
    await records.insert(session);

    expect(await records.isLive(session.sessionId)).toBe(true);

    await workerWith().orchestrator.tick();
    await settle();

    expect(await records.isLive(session.sessionId)).toBe(false);
  });
});

describe('what a watcher would have seen, stored in order', () => {
  it('records the run as it happened, with tools before the pull request', async () => {
    const session = sessionDocument();
    await records.insert(session);

    const store = new MongoEventStore(testDatabase.db);
    const captured = capturingLogger();
    const events = new LiveEventPublisher({ store, redis: redis.client, logger: captured.logger });

    const workshop = new FakeWorkshop({
      logger: captured.logger,
      answers: [
        CLEAR_SCOPE,
        answer('read_file', { path: 'README.md' }),
        ...FINISHING_ANSWERS.slice(1),
      ],
      events,
    });

    const runner = new SessionRunner({
      workshop,
      push,
      pullRequests,
      logger: captured.logger,
      events,
      notifyEmailFor: async () => Promise.resolve('person@example.com'),
    });

    await runner.run(session, new AbortController().signal);

    const stored = await store.since(session.sessionId, 0, 200);
    const types = stored.map((one) => one.event.type);

    expect(types).toContain('tool.started');
    expect(types).toContain('tool.output');
    expect(types).toContain('tool.completed');
    expect(types.indexOf('tool.started')).toBeLessThan(types.indexOf('tool.completed'));
    expect(types.indexOf('tool.completed')).toBeLessThan(types.lastIndexOf('pr.created'));
  });

  it('hands every event its own place in the queue, never a shared one', async () => {
    const session = sessionDocument();
    await records.insert(session);

    const store = new MongoEventStore(testDatabase.db);
    const captured = capturingLogger();
    const events = new LiveEventPublisher({ store, redis: redis.client, logger: captured.logger });

    await new SessionRunner({
      workshop: new FakeWorkshop({ logger: captured.logger, answers: FINISHING_ANSWERS, events }),
      push,
      pullRequests,
      logger: captured.logger,
      events,
      notifyEmailFor: async () => Promise.resolve('person@example.com'),
    }).run(session, new AbortController().signal);

    const sequences = (await store.since(session.sessionId, 0, 200)).map((one) => one.sequence);

    expect(new Set(sequences).size).toBe(sequences.length);
    expect([...sequences].sort((left, right) => left - right)).toEqual(sequences);
  });
});

describe('a session waiting for a person, against a real database', () => {
  it('is written as waiting and is not claimable', async () => {
    await records.insert(sessionDocument());

    const worker = workerWith({ answers: NEVER_CLEAR_ANSWERS });
    await worker.orchestrator.tick();
    await settle();

    const stored = await sessionsCollection(testDatabase.db).findOne({});

    expect(stored?.status).toBe('awaiting_user');
    expect(stored?.waitingSince).toBeInstanceOf(Date);
    expect(await records.findClaimable(10)).toEqual([]);
  });

  it('becomes claimable the moment the answer is written', async () => {
    const session = sessionDocument();
    await records.insert(session);

    const worker = workerWith({ answers: NEVER_CLEAR_ANSWERS });
    await worker.orchestrator.tick();
    await settle();

    await records.answerOnce(session.userId, session.sessionId, 'the dashboard', new Date());

    const claimable = await records.findClaimable(10);

    expect(claimable.map((one) => one.sessionId)).toEqual([session.sessionId]);
    expect(claimable[0]?.waitingSince).toBeNull();
  });

  it('becomes claimable the moment an approval is decided', async () => {
    const session = sessionDocument();
    await records.insert(session);

    const approvals = new MongoApprovals({
      db: testDatabase.db,
      sessionId: session.sessionId,
    });

    const asked = await approvals.request('b'.repeat(64), pendingApproval(new Date()).effect);

    await records.recordOutcome(
      session.sessionId,
      { status: 'awaiting_user', currentActivity: null },
      new Date(),
    );

    expect(await records.findClaimable(10)).toEqual([]);

    await approvals.decide(asked.approvalId, 'b'.repeat(64), true);

    expect((await records.findClaimable(10)).map((one) => one.sessionId)).toEqual([
      session.sessionId,
    ]);
  });

  it('is found by the sweeper only once its own timeout has passed', async () => {
    const session = sessionDocument();
    await records.insert(session);

    await records.askQuestion(session.sessionId, 'Which page?', new Date());
    await records.recordOutcome(
      session.sessionId,
      { status: 'awaiting_user', currentActivity: null },
      new Date(Date.now() - WAIT_LIMITS.clarificationMs - 60_000),
    );

    expect(
      await records.findWaitingSince(new Date(Date.now() - WAIT_LIMITS.approvalMs), 10),
    ).toHaveLength(1);

    const sweeper = new WaitingSessionSweeper({ records, logger: capturingLogger().logger });

    expect(await sweeper.sweepOnce()).toEqual([session.sessionId]);

    const stored = await sessionsCollection(testDatabase.db).findOne({});

    expect(stored?.status).toBe('failed');
    expect(stored?.failure?.code).toBe('CLARIFICATION_TIMEOUT');
    expect(stored?.waitingSince).toBeNull();
  });

  it('leaves a session that has never waited out of the sweep, field or no field', async () => {
    const session = sessionDocument();
    await records.insert(session);

    await sessionsCollection(testDatabase.db).updateOne(
      { sessionId: session.sessionId },
      { $unset: { waitingSince: '' } },
    );

    expect(await records.findWaitingSince(new Date(), 10)).toEqual([]);
    expect((await records.findClaimable(10)).map((one) => one.sessionId)).toEqual([
      session.sessionId,
    ]);
  });
});

describe('a cancel raised by one process against a worker in another', () => {
  it('reaches the worker over Redis and stops it before any external write', async () => {
    const session = sessionDocument();
    await records.insert(session);

    const worker = workerWith({ watchCancels: true });
    worker.orchestrator.start();
    await new Promise((resolve) => setTimeout(resolve, 50));

    await worker.orchestrator.take(session);
    expect(worker.orchestrator.holds(session.sessionId)).toBe(true);

    const elsewhere = new RedisCancelAnnouncer({
      redis: redis.client,
      logger: capturingLogger().logger,
    });

    await records.finish(session.userId, session.sessionId, 'cancelled', new Date());
    await elsewhere.announce(session.sessionId, new Date());
    await settle();

    expect(worker.logs()).toContain('told to stop');
    expect(push.calls).toHaveLength(0);
    expect(pullRequests.calls).toHaveLength(0);

    await worker.orchestrator.stop();
  });

  it('stops the run even when the announcement never arrives, from the database alone', async () => {
    const session = sessionDocument();
    await records.insert(session);

    const worker = workerWith();
    await worker.orchestrator.take(session);
    await records.finish(session.userId, session.sessionId, 'cancelled', new Date());
    await settle();

    expect(push.calls).toHaveLength(0);
    expect(pullRequests.calls).toHaveLength(0);
    expect((await sessionsCollection(testDatabase.db).findOne({}))?.status).toBe('cancelled');
  });

  it('releases the lease so nothing is left holding a cancelled session', async () => {
    const session = sessionDocument();
    await records.insert(session);

    const worker = workerWith();
    await worker.orchestrator.take(session);
    await records.finish(session.userId, session.sessionId, 'cancelled', new Date());
    await settle();

    expect(await leases.holderOf(leaseResource(session.sessionId))).toBeNull();
    expect(worker.orchestrator.running).toBe(0);
  });

  it('never lets a late worker write over the cancelled terminal state', async () => {
    const session = sessionDocument();
    await records.insert(session);
    await records.finish(session.userId, session.sessionId, 'cancelled', new Date());

    const written = await records.recordOutcome(
      session.sessionId,
      { status: 'pr_created', currentActivity: null },
      new Date(),
    );

    expect(written).toBeNull();
    expect((await sessionsCollection(testDatabase.db).findOne({}))?.status).toBe('cancelled');
  });
});
