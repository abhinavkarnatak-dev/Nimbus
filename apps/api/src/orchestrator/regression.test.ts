import { describe, expect, it } from 'vitest';

import { toSessionDetail } from '../db/models/session.js';
import { CollectingEventPublisher } from '../events/publisher.js';
import { InMemorySessionRecords, wasLeftMidRun } from '../sessions/repository.js';
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
  whenAborted,
} from './orchestrator.fixtures.js';
import { resumedState } from './live-workshop.js';
import { planFor } from '../routing/selection.js';
import { SessionRunner } from './runner.js';

interface Harness {
  orchestrator: Orchestrator;
  records: InMemorySessionRecords;
  leases: InMemoryLeases;
  events: CollectingEventPublisher;
  logs: () => string;
}

function harness(
  options: {
    leases?: InMemoryLeases;
    records?: InMemorySessionRecords;
    drainMs?: number;
    holdUntilAborted?: boolean;
  } = {},
): Harness {
  const captured = orchestratorLogger();
  const records = options.records ?? new InMemorySessionRecords();
  const leases = options.leases ?? new InMemoryLeases();
  const events = new CollectingEventPublisher();
  const push = new RecordingPushGateway();

  let signal: AbortSignal | null = null;

  if (options.holdUntilAborted === true) {
    push.justAfter(async () => {
      if (signal !== null) {
        await whenAborted(signal);
      }
    });
  }

  const workshop = new FakeWorkshop({
    logger: captured.logger,
    answers: FINISHING_ANSWERS,
    events,
    records,
    onPrepare: (_session, given) => {
      signal = given;
    },
  });

  return {
    orchestrator: new Orchestrator({
      records,
      leases,
      runner: new SessionRunner({
        workshop,
        push,
        pullRequests: new RecordingPullRequestGateway(),
        logger: captured.logger,
        events,
        notifyEmailFor: async () => Promise.resolve('person@example.com'),
      }),
      logger: captured.logger,
      heartbeatMs: 60_000,
      drainPollMs: 1,
      drainMs: options.drainMs ?? 30,
      drainGraceMs: 2_000,
    }),
    records,
    leases,
    events,
    logs: captured.text,
  };
}

async function settle(): Promise<void> {
  for (let round = 0; round < 40; round += 1) {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

describe('038f and 038g together: a shutdown hands a session back', () => {
  it('leaves it looking interrupted, so the next worker counts it as a recovery', async () => {
    const records = new InMemorySessionRecords();
    const leases = new InMemoryLeases();
    const session = sessionDocument();
    await records.insert(session);

    const first = harness({ records, leases, holdUntilAborted: true });
    await first.orchestrator.tick();
    await settle();
    await first.orchestrator.stop();

    expect(records.documents[0]?.status).toBe('working');
    expect(records.documents[0]?.retryCount).toBe(0);

    const second = harness({ records, leases });
    await second.orchestrator.tick();
    await settle();

    expect(records.documents[0]?.retryCount).toBe(1);
  });

  it('ends the session rather than restarting it forever, which is the cost of the two together', async () => {
    const records = new InMemorySessionRecords();
    const leases = new InMemoryLeases();
    await records.insert(sessionDocument());

    for (let restart = 0; restart < 5; restart += 1) {
      const worker = harness({ records, leases, holdUntilAborted: true });
      await worker.orchestrator.tick();
      await settle();
      await worker.orchestrator.stop();
    }

    expect(records.documents[0]?.status).toBe('failed');
    expect(records.documents[0]?.failure?.code).toBe('INTERNAL_ERROR');
  });
});

describe('038e and 038g together: a cancelled session stays cancelled', () => {
  it('is never counted as a worker that was left behind', () => {
    expect(wasLeftMidRun('cancelled')).toBe(false);
    expect(wasLeftMidRun('failed')).toBe(false);
    expect(wasLeftMidRun('pr_created')).toBe(false);
  });

  it('is not claimable once it is cancelled, however it got there', async () => {
    const held = harness();
    const session = sessionDocument({ status: 'working' });
    await held.records.insert(session);
    await held.records.finish(session.userId, session.sessionId, 'cancelled', new Date());

    expect(await held.records.findClaimable(10)).toHaveLength(0);
    expect(await held.orchestrator.take(session)).toBe(false);
    expect(await held.leases.holderOf(leaseResource(session.sessionId))).toBeNull();
  });
});

describe('038g and 038h together: progress and conversation share one document', () => {
  it('neither one clobbers the other', async () => {
    const records = new InMemorySessionRecords();
    const session = sessionDocument();
    await records.insert(session);
    await records.startRun(session.sessionId, new Date());

    await records.recordProgress(
      session.sessionId,
      { step: 6, currentActivity: 'reading the redirect' },
      new Date(),
    );
    await records.addAgentMessage(session.sessionId, 'I found the redirect.', new Date());
    await records.recordProgress(
      session.sessionId,
      { step: 7, currentActivity: 'running the tests' },
      new Date(),
    );
    await records.addMessage(session.userId, session.sessionId, 'keep the old link', new Date());

    const stored = records.documents[0];

    expect(stored?.step).toBe(7);
    expect(stored?.currentActivity).toBe('running the tests');
    expect(stored?.messages.map((one) => one.role)).toStrictEqual(['agent', 'user']);
  });

  it('shows both on the detail a reload reads', async () => {
    const records = new InMemorySessionRecords();
    const session = sessionDocument();
    await records.insert(session);
    await records.startRun(session.sessionId, new Date());
    await records.recordProgress(
      session.sessionId,
      { step: 3, currentActivity: 'reading' },
      new Date(),
    );
    await records.addAgentMessage(session.sessionId, 'I found it.', new Date());

    const stored = records.documents[0];
    const detail = stored === undefined ? null : toSessionDetail(stored);

    expect(detail?.status).toBe('working');
    expect(detail?.progress.step).toBe(3);
    expect(detail?.messages).toHaveLength(1);
  });
});

describe('038d and 038g together: a session keeps its own budget across a recovery', () => {
  it('carries what was spent without ever exceeding the number the session was written with', () => {
    const session = sessionDocument({ status: 'working', step: 40, maxSteps: 12 });

    const state = resumedState(
      {
        sessionId: session.sessionId,
        userId: session.userId,
        repositoryId: session.repository.repositoryId,
        installationId: 42,
        task: session.task,
        baseCommitSha: 'a'.repeat(40),
        defaultBranch: 'main',
        models: planFor(),
        budgets: { maxSteps: session.maxSteps },
      },
      session,
    );

    expect(state.budgets.maxSteps).toBe(12);
    expect(state.budgets.steps).toBe(12);
  });
});
