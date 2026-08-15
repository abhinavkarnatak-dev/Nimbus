import { describe, expect, it } from 'vitest';

import { InMemorySessionRecords } from '../sessions/repository.js';
import { leaseResource } from './claim.js';
import { Orchestrator } from './orchestrator.js';
import {
  FINISHING_ANSWERS,
  FakeWorkshop,
  InMemoryLeases,
  RecordingPullRequestGateway,
  RecordingPushGateway,
  orchestratorLogger,
  sessionDocument,
} from './orchestrator.fixtures.js';
import { SessionRunner } from './runner.js';

interface Harness {
  orchestrator: Orchestrator;
  records: InMemorySessionRecords;
  leases: InMemoryLeases;
  workshop: FakeWorkshop;
  push: RecordingPushGateway;
  pullRequests: RecordingPullRequestGateway;
  logs: () => string;
}

function harness(
  options: {
    answers?: readonly { value: unknown }[];
    maxRecoveries?: number;
    runningConcurrently?: number;
    failWith?: Error;
  } = {},
): Harness {
  const captured = orchestratorLogger();
  const records = new InMemorySessionRecords();
  const leases = new InMemoryLeases();
  const push = new RecordingPushGateway();
  const pullRequests = new RecordingPullRequestGateway();

  const workshop = new FakeWorkshop({
    logger: captured.logger,
    answers: options.answers ?? FINISHING_ANSWERS,
    ...(options.failWith === undefined ? {} : { failWith: options.failWith }),
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
      ...(options.maxRecoveries === undefined ? {} : { maxRecoveries: options.maxRecoveries }),
      ...(options.runningConcurrently === undefined
        ? {}
        : { runningConcurrently: options.runningConcurrently }),
    }),
    records,
    leases,
    workshop,
    push,
    pullRequests,
    logs: captured.text,
  };
}

async function settle(): Promise<void> {
  for (let round = 0; round < 40; round += 1) {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

describe('a session that finishes', () => {
  it('is taken, run, pushed and opened as a pull request', async () => {
    const held = harness();
    const session = sessionDocument();
    await held.records.insert(session);

    await held.orchestrator.tick();
    await settle();

    expect(held.push.calls).toHaveLength(1);
    expect(held.pullRequests.calls).toHaveLength(1);
    expect(held.records.documents[0]?.status).toBe('pr_created');
  });

  it('records the branch and the pull request on the session', async () => {
    const held = harness();
    await held.records.insert(sessionDocument());

    await held.orchestrator.tick();
    await settle();

    const stored = held.records.documents[0];

    expect(stored?.branch).not.toBeNull();
    expect(stored?.pullRequest?.number).toBe(1);
    expect(stored?.completedAt).not.toBeNull();
  });

  it('records what changed and what was checked', async () => {
    const held = harness();
    await held.records.insert(sessionDocument());

    await held.orchestrator.tick();
    await settle();

    const stored = held.records.documents[0];

    expect(stored?.filesChanged.length).toBeGreaterThan(0);
    expect(stored?.checks.length).toBeGreaterThan(0);
    expect(stored?.step).toBeGreaterThan(0);
  });

  it('gives the lease back when it is done', async () => {
    const held = harness();
    const session = sessionDocument();
    await held.records.insert(session);

    await held.orchestrator.tick();
    await settle();

    expect(await held.leases.holderOf(leaseResource(session.sessionId))).toBeNull();
    expect(held.orchestrator.running).toBe(0);
  });
});

describe('two workers and one session', () => {
  it('lets only one of them take it', async () => {
    const first = harness();
    const session = sessionDocument();
    await first.records.insert(session);

    const second = new Orchestrator({
      records: first.records,
      leases: first.leases,
      runner: new SessionRunner({
        workshop: first.workshop,
        push: first.push,
        pullRequests: first.pullRequests,
        logger: orchestratorLogger().logger,
        notifyEmailFor: async () => Promise.resolve('person@example.com'),
      }),
      logger: orchestratorLogger().logger,
      heartbeatMs: 60_000,
    });

    const takenByFirst = await first.orchestrator.take(session);
    const takenBySecond = await second.take(session);

    expect(takenByFirst).toBe(true);
    expect(takenBySecond).toBe(false);

    await settle();
  });

  it('opens one pull request even when both keep trying', async () => {
    const held = harness();
    const session = sessionDocument();
    await held.records.insert(session);

    await Promise.all([held.orchestrator.tick(), held.orchestrator.tick()]);
    await settle();

    expect(held.pullRequests.calls).toHaveLength(1);
  });

  it('does not run a session it is already running', async () => {
    const held = harness();
    await held.records.insert(sessionDocument());

    await held.orchestrator.tick();
    const second = await held.orchestrator.tick();

    expect(second).toBe(0);
    await settle();
  });
});

describe('a worker that loses its lease', () => {
  it('writes nothing about the session it was running', async () => {
    const held = harness();
    const session = sessionDocument();
    await held.records.insert(session);

    const taken = await held.orchestrator.take(session);
    held.leases.steal(leaseResource(session.sessionId));

    expect(taken).toBe(true);
    await settle();

    expect(held.records.documents[0]?.status).toBe('queued');
  });

  it('checks one last time before writing, not only between heartbeats', async () => {
    const held = harness();
    const session = sessionDocument();
    await held.records.insert(session);

    await held.orchestrator.take(session);
    held.leases.steal(leaseResource(session.sessionId));
    await settle();

    expect(held.logs()).toContain('writes nothing about this session');
  });

  it('stops holding the session, so the next worker can have it', async () => {
    const held = harness();
    const session = sessionDocument();
    await held.records.insert(session);

    await held.orchestrator.take(session);
    held.leases.steal(leaseResource(session.sessionId));
    await settle();

    expect(held.orchestrator.running).toBe(0);
  });
});

describe('a session left behind by a dead worker', () => {
  it('is picked up again rather than left forever', async () => {
    const held = harness();
    await held.records.insert(sessionDocument({ status: 'working' }));

    await held.orchestrator.tick();
    await settle();

    expect(held.workshop.prepared).toHaveLength(1);
    expect(held.logs()).toContain('left behind by a worker');
  });

  it('counts every recovery, so a poisonous session stops being retried', async () => {
    const held = harness({ maxRecoveries: 1 });
    const session = sessionDocument({ status: 'working', retryCount: 1 });
    await held.records.insert(session);

    const taken = await held.orchestrator.take(session);

    expect(taken).toBe(false);
    expect(held.records.documents[0]?.status).toBe('failed');
    expect(held.records.documents[0]?.failure?.code).toBe('INTERNAL_ERROR');
  });

  it('gives the lease back when it refuses to retry', async () => {
    const held = harness({ maxRecoveries: 1 });
    const session = sessionDocument({ status: 'working', retryCount: 1 });
    await held.records.insert(session);

    await held.orchestrator.take(session);

    expect(await held.leases.holderOf(leaseResource(session.sessionId))).toBeNull();
  });

  it('leaves a queued session alone, because waiting is not crashing', async () => {
    const held = harness();
    await held.records.insert(sessionDocument());

    await held.orchestrator.tick();
    await settle();

    expect(held.records.documents[0]?.retryCount).toBe(0);
  });
});

describe('a session that cannot be started at all', () => {
  it('ends as failed rather than being retried forever', async () => {
    const held = harness({ failWith: new Error('no sandbox today') });
    await held.records.insert(sessionDocument());

    await held.orchestrator.tick();
    await settle();

    expect(held.records.documents[0]?.status).toBe('failed');
    expect(held.records.documents[0]?.failure?.code).toBe('SANDBOX_FAILED');
  });

  it('pushes nothing and opens nothing', async () => {
    const held = harness({ failWith: new Error('no sandbox today') });
    await held.records.insert(sessionDocument());

    await held.orchestrator.tick();
    await settle();

    expect(held.push.calls).toHaveLength(0);
    expect(held.pullRequests.calls).toHaveLength(0);
  });
});

describe('a session that was already ended', () => {
  it('is never moved by a worker finishing late', async () => {
    const held = harness();
    const session = sessionDocument();
    await held.records.insert(session);

    await held.orchestrator.take(session);
    await held.records.finish(session.userId, session.sessionId, 'cancelled', new Date());
    await settle();

    expect(held.records.documents[0]?.status).toBe('cancelled');
    expect(held.logs()).toContain('already ended');
  });
});

describe('how many run at once', () => {
  it('never runs more than it was told to', async () => {
    const held = harness({ runningConcurrently: 1 });

    await held.records.insert(sessionDocument());
    await held.records.insert(
      sessionDocument({
        sessionId: 'ses_bbbbbbbbbbbbbbbbbbbbb',
        userId: 'usr_bbbbbbbbbbbbbbbbbbbbb',
        idempotencyKey: 'idk_bbbbbbbbbbbbbbbbbbbbb',
      }),
    );

    const started = await held.orchestrator.tick();

    expect(started).toBe(1);
    await settle();
  });
});
