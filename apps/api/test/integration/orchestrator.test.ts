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
import { leaseResource } from '../../src/orchestrator/claim.js';
import { Orchestrator } from '../../src/orchestrator/orchestrator.js';
import {
  FINISHING_ANSWERS,
  FakeWorkshop,
  RecordingPullRequestGateway,
  RecordingPushGateway,
  sessionDocument,
} from '../../src/orchestrator/orchestrator.fixtures.js';
import { SessionRunner } from '../../src/orchestrator/runner.js';
import { LeaseManager } from '../../src/redis/lease.js';
import { MongoSessionRecords } from '../../src/sessions/repository.js';

let testDatabase: TestDatabase;
let redis: TestRedis;
let records: MongoSessionRecords;
let leases: LeaseManager;

const push = new RecordingPushGateway();
const pullRequests = new RecordingPullRequestGateway();

function workerWith(options: { answers?: readonly { value: unknown }[]; hang?: boolean } = {}): {
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
