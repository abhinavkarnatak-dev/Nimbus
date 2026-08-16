import { describe, expect, it } from 'vitest';

import type { SessionDocument } from '../db/models/session.js';
import { CollectingEventPublisher } from '../events/publisher.js';
import { InMemorySessionRecords } from '../sessions/repository.js';
import {
  CANCEL_CHANNEL,
  CollectingCancelAnnouncer,
  readCancelNotice,
  type CancelWatcher,
} from './cancellation.js';
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

class FakeCancelWatcher implements CancelWatcher {
  #handler: ((sessionId: string) => void) | null = null;

  watching = false;

  async watch(handler: (sessionId: string) => void): Promise<void> {
    this.#handler = handler;
    this.watching = true;
    await Promise.resolve();
  }

  async stop(): Promise<void> {
    this.watching = false;
    await Promise.resolve();
  }

  arrive(sessionId: string): void {
    this.#handler?.(sessionId);
  }
}

function harness(
  options: {
    onPrepare?: (session: SessionDocument) => void;
    cancellations?: CancelWatcher;
    events?: CollectingEventPublisher;
  } = {},
): Harness {
  const captured = orchestratorLogger();
  const records = new InMemorySessionRecords();
  const leases = new InMemoryLeases();
  const push = new RecordingPushGateway();
  const pullRequests = new RecordingPullRequestGateway();

  const workshop = new FakeWorkshop({
    logger: captured.logger,
    answers: FINISHING_ANSWERS,
    ...(options.onPrepare === undefined ? {} : { onPrepare: options.onPrepare }),
  });

  return {
    orchestrator: new Orchestrator({
      records,
      leases,
      runner: new SessionRunner({
        workshop,
        push,
        pullRequests,
        logger: captured.logger,
        notifyEmailFor: async () => Promise.resolve('person@example.com'),
        ...(options.events === undefined ? {} : { events: options.events }),
      }),
      logger: captured.logger,
      heartbeatMs: 60_000,
      ...(options.cancellations === undefined ? {} : { cancellations: options.cancellations }),
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

describe('a cancel that lands before a worker starts', () => {
  it('never rents a machine, pushes a branch, or opens a pull request', async () => {
    const held = harness();
    const session = sessionDocument();
    await held.records.insert(session);
    await held.records.finish(session.userId, session.sessionId, 'cancelled', new Date());

    await held.orchestrator.take(session);
    await settle();

    expect(held.workshop.prepared).toHaveLength(0);
    expect(held.push.calls).toHaveLength(0);
    expect(held.pullRequests.calls).toHaveLength(0);
  });

  it('gives the lease straight back so nothing is left holding the session', async () => {
    const held = harness();
    const session = sessionDocument();
    await held.records.insert(session);
    await held.records.finish(session.userId, session.sessionId, 'cancelled', new Date());

    await held.orchestrator.take(session);
    await settle();

    expect(await held.leases.holderOf(leaseResource(session.sessionId))).toBeNull();
    expect(held.orchestrator.running).toBe(0);
  });
});

describe('a cancel that lands while the machine is being prepared', () => {
  it('opens no pull request, which is the whole point', async () => {
    const session = sessionDocument();
    let records: InMemorySessionRecords | null = null;

    const held = harness({
      onPrepare: () => {
        void records?.finish(session.userId, session.sessionId, 'cancelled', new Date());
      },
    });
    records = held.records;
    await held.records.insert(session);

    await held.orchestrator.take(session);
    await settle();

    expect(held.workshop.prepared).toHaveLength(1);
    expect(held.push.calls).toHaveLength(0);
    expect(held.pullRequests.calls).toHaveLength(0);
  });

  it('tears the machine down rather than leaving it running', async () => {
    const session = sessionDocument();
    let records: InMemorySessionRecords | null = null;

    const held = harness({
      onPrepare: () => {
        void records?.finish(session.userId, session.sessionId, 'cancelled', new Date());
      },
    });
    records = held.records;
    await held.records.insert(session);

    await held.orchestrator.take(session);
    await settle();

    expect(held.workshop.sandboxes[0]?.status().state).toBe('terminated');
    expect(await held.leases.holderOf(leaseResource(session.sessionId))).toBeNull();
  });
});

describe('a cancel that lands while the agent is working', () => {
  it('stops the run without pushing anything', async () => {
    const held = harness();
    const session = sessionDocument();
    await held.records.insert(session);

    await held.orchestrator.take(session);
    held.orchestrator.cancel(session.sessionId);
    await settle();

    expect(held.push.calls).toHaveLength(0);
    expect(held.pullRequests.calls).toHaveLength(0);
  });

  it('reports that it holds the run, and stops holding it afterwards', async () => {
    const held = harness();
    const session = sessionDocument();
    await held.records.insert(session);

    await held.orchestrator.take(session);

    expect(held.orchestrator.holds(session.sessionId)).toBe(true);
    expect(held.orchestrator.cancel(session.sessionId)).toBe(true);
    expect(held.orchestrator.cancel(session.sessionId)).toBe(false);

    await settle();
    expect(held.orchestrator.holds(session.sessionId)).toBe(false);
  });

  it('says nothing about a session it is not running', () => {
    const held = harness();

    expect(held.orchestrator.cancel('ses_0123456789abcdefghijk')).toBe(false);
  });
});

describe('a cancel that lands after the agent finished but before the push', () => {
  it('pushes nothing and opens nothing', async () => {
    const session = sessionDocument();
    const events = new CollectingEventPublisher();
    const held = harness({ events });
    await held.records.insert(session);

    events.onEvent(async (type) => {
      if (type === 'files.changed') {
        await held.records.finish(session.userId, session.sessionId, 'cancelled', new Date());
      }
    });

    await held.orchestrator.take(session);
    await settle();

    expect(events.typesFor(session.sessionId)).toContain('files.changed');
    expect(held.push.calls).toHaveLength(0);
    expect(held.pullRequests.calls).toHaveLength(0);
  });
});

describe('a cancel that lands after the push but before the pull request', () => {
  it('leaves the branch and opens no pull request', async () => {
    const session = sessionDocument();
    const held = harness();
    await held.records.insert(session);

    held.push.justAfter(async () => {
      await held.records.finish(session.userId, session.sessionId, 'cancelled', new Date());
    });

    await held.orchestrator.take(session);
    await settle();

    expect(held.push.calls).toHaveLength(1);
    expect(held.pullRequests.calls).toHaveLength(0);
    expect(held.logs()).toContain('no pull request was opened');
  });

  it('leaves the session cancelled rather than recording a pull request', async () => {
    const session = sessionDocument();
    const held = harness();
    await held.records.insert(session);

    held.push.justAfter(async () => {
      await held.records.finish(session.userId, session.sessionId, 'cancelled', new Date());
    });

    await held.orchestrator.take(session);
    await settle();

    const after = await held.records.findById(session.sessionId);

    expect(after?.status).toBe('cancelled');
    expect(after?.pullRequest).toBeNull();
  });
});

describe('a late worker', () => {
  it('cannot record a different terminal outcome over a cancellation', async () => {
    const records = new InMemorySessionRecords();
    const session = sessionDocument();
    await records.insert(session);
    await records.finish(session.userId, session.sessionId, 'cancelled', new Date());

    const written = await records.recordOutcome(
      session.sessionId,
      { status: 'pr_created', currentActivity: null },
      new Date(),
    );

    expect(written).toBeNull();
    expect((await records.findById(session.sessionId))?.status).toBe('cancelled');
  });
});

describe('two people cancelling at once', () => {
  it('produces one winner and one refusal', async () => {
    const records = new InMemorySessionRecords();
    const session = sessionDocument();
    await records.insert(session);

    const at = new Date();
    const both = await Promise.all([
      records.finish(session.userId, session.sessionId, 'cancelled', at),
      records.finish(session.userId, session.sessionId, 'cancelled', at),
    ]);

    expect(both.filter((one) => one !== null)).toHaveLength(1);
  });
});

describe('a cancel announced by another process', () => {
  it('reaches the worker holding the run and stops it', async () => {
    const watcher = new FakeCancelWatcher();
    const held = harness({ cancellations: watcher });
    const session = sessionDocument();
    await held.records.insert(session);

    held.orchestrator.start();
    expect(watcher.watching).toBe(true);

    await held.orchestrator.take(session);
    watcher.arrive(session.sessionId);
    await settle();

    expect(held.push.calls).toHaveLength(0);
    expect(held.pullRequests.calls).toHaveLength(0);
    await held.orchestrator.stop();
  });

  it('ignores a session this process is not running', async () => {
    const watcher = new FakeCancelWatcher();
    const held = harness({ cancellations: watcher });

    held.orchestrator.start();
    watcher.arrive('ses_0123456789abcdefghijk');
    await settle();

    expect(held.logs()).not.toContain('told to stop');
    await held.orchestrator.stop();
  });

  it('stops watching when the orchestrator stops', async () => {
    const watcher = new FakeCancelWatcher();
    const held = harness({ cancellations: watcher });

    held.orchestrator.start();
    await held.orchestrator.stop();

    expect(watcher.watching).toBe(false);
  });
});

describe('the cancellation notice itself', () => {
  it('travels on its own channel', () => {
    expect(CANCEL_CHANNEL).toBe('nimbus:session-cancel');
  });

  it('reads back what was written', () => {
    const payload = JSON.stringify({ sessionId: 'ses_1', at: '2026-08-16T10:00:00.000Z' });

    expect(readCancelNotice(payload)?.sessionId).toBe('ses_1');
  });

  it('refuses anything it cannot read rather than guessing', () => {
    expect(readCancelNotice('not json')).toBeNull();
    expect(readCancelNotice('{}')).toBeNull();
    expect(readCancelNotice(JSON.stringify({ sessionId: 'ses_1' }))).toBeNull();
    expect(
      readCancelNotice(JSON.stringify({ sessionId: 'ses_1', at: 'now', extra: true })),
    ).toBeNull();
  });

  it('records what it was asked to announce', async () => {
    const announcer = new CollectingCancelAnnouncer();
    await announcer.announce('ses_1', new Date());

    expect(announcer.announced).toEqual(['ses_1']);
  });
});
