import { describe, expect, it } from 'vitest';

import { CapturingMailer } from '../email/capturing-mailer.js';
import { MailService } from '../email/mail-service.js';
import { CollectingEventPublisher } from '../events/publisher.js';
import type { SessionDocument } from '../db/models/session.js';
import {
  InMemorySessionRecords,
  RUNNING_SESSION_STATUSES,
  wasLeftMidRun,
} from '../sessions/repository.js';
import { leaseResource } from './claim.js';
import { resumedState } from './live-workshop.js';
import { Orchestrator } from './orchestrator.js';
import {
  FINISHING_ANSWERS,
  FakeWorkshop,
  InMemoryLeases,
  NEVER_CLEAR_ANSWERS,
  RecordingPullRequestGateway,
  RecordingPushGateway,
  orchestratorLogger,
  sessionDocument,
} from './orchestrator.fixtures.js';
import { planFor } from '../routing/selection.js';
import { SessionRunner } from './runner.js';

interface Harness {
  orchestrator: Orchestrator;
  records: InMemorySessionRecords;
  leases: InMemoryLeases;
  workshop: FakeWorkshop;
  events: CollectingEventPublisher;
  mailer: CapturingMailer;
  logs: () => string;
}

function harness(
  options: { maxRecoveries?: number; answers?: readonly { value: unknown }[] } = {},
): Harness {
  const captured = orchestratorLogger();
  const records = new InMemorySessionRecords();
  const leases = new InMemoryLeases();
  const events = new CollectingEventPublisher();
  const mailer = new CapturingMailer();

  const workshop = new FakeWorkshop({
    logger: captured.logger,
    answers: options.answers ?? FINISHING_ANSWERS,
  });

  return {
    orchestrator: new Orchestrator({
      records,
      leases,
      runner: new SessionRunner({
        workshop,
        push: new RecordingPushGateway(),
        pullRequests: new RecordingPullRequestGateway(),
        logger: captured.logger,
        notifyEmailFor: async () => Promise.resolve('person@example.com'),
      }),
      logger: captured.logger,
      heartbeatMs: 60_000,
      events,
      mail: new MailService(mailer, 'nimbus@example.com'),
      notifyEmailFor: async () => Promise.resolve('person@example.com'),
      ...(options.maxRecoveries === undefined ? {} : { maxRecoveries: options.maxRecoveries }),
    }),
    records,
    leases,
    workshop,
    events,
    mailer,
    logs: captured.text,
  };
}

async function settle(): Promise<void> {
  for (let round = 0; round < 40; round += 1) {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

describe('what a session says while a worker is running it', () => {
  it('says a worker is working on it, rather than that it is still queued', async () => {
    const held = harness();
    const session = sessionDocument();
    await held.records.insert(session);

    await held.orchestrator.take(session);

    expect(held.records.documents[0]?.status).toBe('working');
    expect(held.records.documents[0]?.currentActivity).not.toBeNull();
    await settle();
  });

  it('moves the time it was last active, so a stalled run can be told from a slow one', async () => {
    const held = harness();
    const session = sessionDocument();
    await held.records.insert(session);

    const before = held.records.documents[0]?.lastActivityAt.getTime() ?? 0;
    await held.orchestrator.take(session);
    const after = held.records.documents[0]?.lastActivityAt.getTime() ?? 0;

    expect(after).toBeGreaterThanOrEqual(before);
    expect(held.records.documents[0]?.completedAt).toBeNull();
    await settle();
  });

  it('starts nothing when the session ended between being seen and being taken', async () => {
    const held = harness();
    const session = sessionDocument();
    await held.records.insert(session);
    await held.records.finish(session.userId, session.sessionId, 'cancelled', new Date());

    const taken = await held.orchestrator.take(session);

    expect(taken).toBe(false);
    expect(held.workshop.prepared).toHaveLength(0);
    expect(await held.leases.holderOf(leaseResource(session.sessionId))).toBeNull();
  });
});

describe('which statuses mean a worker was left behind', () => {
  it('counts the statuses a run passes through and nothing else', () => {
    expect([...RUNNING_SESSION_STATUSES]).toStrictEqual([
      'provisioning',
      'indexing',
      'working',
      'validating',
      'pushing',
    ]);
  });

  it('does not count a session nobody has started', () => {
    expect(wasLeftMidRun('queued')).toBe(false);
  });

  it('does not count a session that is waiting for a person', () => {
    expect(wasLeftMidRun('awaiting_user')).toBe(false);
  });

  it('does not count a session that has ended', () => {
    expect(wasLeftMidRun('failed')).toBe(false);
    expect(wasLeftMidRun('cancelled')).toBe(false);
    expect(wasLeftMidRun('pr_created')).toBe(false);
  });
});

describe('a session left behind by a worker that died', () => {
  it('is counted as a recovery the next time somebody takes it', async () => {
    const held = harness();
    const session = sessionDocument({ status: 'working' });
    await held.records.insert(session);

    await held.orchestrator.take(session);
    await settle();

    expect(held.records.documents[0]?.retryCount).toBe(1);
    expect(held.logs()).toContain('left behind by a worker');
  });

  it('is given up on once it has been picked up too many times', async () => {
    const held = harness({ maxRecoveries: 2 });
    const session = sessionDocument({ status: 'working', retryCount: 2 });
    await held.records.insert(session);

    const taken = await held.orchestrator.take(session);

    expect(taken).toBe(false);
    expect(held.records.documents[0]?.status).toBe('failed');
    expect(held.records.documents[0]?.failure?.code).toBe('INTERNAL_ERROR');
  });

  it('tells the person it gave up, rather than ending in silence', async () => {
    const held = harness({ maxRecoveries: 2 });
    const session = sessionDocument({ status: 'working', retryCount: 2 });
    await held.records.insert(session);

    await held.orchestrator.take(session);

    expect(held.events.published.map((one) => one.event.type)).toContain('session.failed');
    expect(held.mailer.sent).toHaveLength(1);
  });

  it('ends the session even when it cannot be announced or posted', async () => {
    const held = harness({ maxRecoveries: 2 });
    const session = sessionDocument({ status: 'working', retryCount: 2 });
    await held.records.insert(session);

    held.events.onEvent(async () => Promise.reject(new Error('redis is down')));

    await held.orchestrator.take(session);

    expect(held.records.documents[0]?.status).toBe('failed');
    expect(held.logs()).toContain('could not be announced');
  });

  it('says nothing twice when the session had already ended', async () => {
    const held = harness({ maxRecoveries: 2 });
    const session = sessionDocument({ status: 'working', retryCount: 2 });
    await held.records.insert(session);
    await held.records.finish(session.userId, session.sessionId, 'cancelled', new Date());

    await held.orchestrator.take(session);

    expect(held.mailer.sent).toHaveLength(0);
  });
});

describe('a person answering a question is not a worker dying', () => {
  async function answered(): Promise<Harness> {
    const held = harness({ answers: NEVER_CLEAR_ANSWERS });
    const session = sessionDocument();

    await held.records.insert(session);
    await held.orchestrator.tick();
    await settle();

    await held.records.answerOnce(session.userId, session.sessionId, 'the dashboard', new Date());
    return held;
  }

  it('is picked up again without counting as a recovery', async () => {
    const held = await answered();

    await held.orchestrator.tick();
    await settle();

    expect(held.records.documents[0]?.retryCount).toBe(0);
  });

  it('survives being taken again as many times as a person answers', async () => {
    const held = harness({ answers: NEVER_CLEAR_ANSWERS });
    const session = sessionDocument({ status: 'awaiting_user', waitingSince: null });
    await held.records.insert(session);

    for (let round = 0; round < 5; round += 1) {
      await held.orchestrator.take(session);
      await settle();
    }

    expect(held.records.documents[0]?.retryCount).toBe(0);
    expect(held.records.documents[0]?.status).not.toBe('failed');
  });
});

describe('what a recovered run is told about the one before it', () => {
  function stateFor(session: SessionDocument): ReturnType<typeof resumedState> {
    return resumedState(
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
  }

  it('works on the original task when the last thing said was a clarification answer', () => {
    const state = stateFor(
      sessionDocument({
        status: 'working',
        clarificationQuestion: 'Where should the file go, and what should it be called?',
        clarificationAnswer: 'at root, LinkedList.cpp',
        messages: [
          {
            role: 'user',
            text: 'add a simple linked list example',
            sentAt: new Date('2026-08-01T10:00:00Z'),
          },
          {
            role: 'user',
            text: 'at root, LinkedList.cpp',
            sentAt: new Date('2026-08-01T10:01:00Z'),
          },
        ],
      }),
    );

    expect(state.task).toBe('the login redirect always sends people to the dashboard');
    expect(state.clarificationAnswer).toBe('at root, LinkedList.cpp');
  });

  it('works on the new instruction when the last thing said was a real follow-up', () => {
    const state = stateFor(
      sessionDocument({
        status: 'working',
        messages: [
          {
            role: 'user',
            text: 'add a simple linked list example',
            sentAt: new Date('2026-08-01T10:00:00Z'),
          },
          {
            role: 'user',
            text: 'now add a doubly linked list too',
            sentAt: new Date('2026-08-01T10:01:00Z'),
          },
        ],
      }),
    );

    expect(state.task).toBe('now add a doubly linked list too');
  });

  it('carries the steps that were already spent, so four crashes are not four budgets', () => {
    const state = stateFor(sessionDocument({ status: 'working', step: 18, maxSteps: 30 }));

    expect(state.budgets.steps).toBe(18);
    expect(state.budgets.maxSteps).toBe(30);
  });

  it('never claims more steps were spent than the session allows', () => {
    const state = stateFor(sessionDocument({ status: 'working', step: 99, maxSteps: 30 }));

    expect(state.budgets.steps).toBe(30);
  });

  it('is told nothing about files in a machine that no longer exists', () => {
    const state = stateFor(
      sessionDocument({
        status: 'working',
        step: 12,
        filesRead: ['src/routing/redirect.ts'],
        filesChanged: [
          {
            path: 'src/routing/redirect.ts',
            changeKind: 'modified',
            addedLines: 1,
            removedLines: 1,
            diff: '@@ -1,1 +1,1 @@\n-const to = "/old";\n+const to = "/new";',
            diffTruncated: false,
          },
        ],
        checks: [
          {
            name: 'unit tests',
            kind: 'test',
            status: 'passed',
            durationMs: 10,
            summary: 'ok',
          },
        ],
      }),
    );

    expect(state.filesRead).toHaveLength(0);
    expect(state.filesChanged).toHaveLength(0);
    expect(state.checks).toHaveLength(0);
  });

  it('still starts a fresh session at zero', () => {
    const state = stateFor(sessionDocument());

    expect(state.budgets.steps).toBe(0);
  });

  it('keeps carrying a question that was already answered', () => {
    const state = stateFor(
      sessionDocument({
        status: 'working',
        step: 4,
        clarificationQuestion: 'which page?',
        clarificationAnswer: 'the dashboard',
      }),
    );

    expect(state.clarificationAnswer).toBe('the dashboard');
    expect(state.budgets.steps).toBe(4);
  });
});
