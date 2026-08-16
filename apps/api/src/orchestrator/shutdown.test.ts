import { describe, expect, it } from 'vitest';

import type { SessionDocument } from '../db/models/session.js';
import { InMemorySessionRecords, type RunOutcome } from '../sessions/repository.js';
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
import { SessionRunner } from './runner.js';

interface Gate {
  wait: Promise<void>;
  open: () => void;
}

function gate(): Gate {
  let open: () => void = () => undefined;

  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });

  return { wait, open };
}

interface Harness {
  orchestrator: Orchestrator;
  records: InMemorySessionRecords;
  leases: InMemoryLeases;
  push: RecordingPushGateway;
  pullRequests: RecordingPullRequestGateway;
  logs: () => string;
}

function harness(
  options: {
    drainMs?: number;
    drainGraceMs?: number;
    onPrepare?: (session: SessionDocument, signal: AbortSignal) => void;
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
      }),
      logger: captured.logger,
      heartbeatMs: 60_000,
      drainPollMs: 1,
      drainMs: options.drainMs ?? 2_000,
      drainGraceMs: options.drainGraceMs ?? 2_000,
    }),
    records,
    leases,
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

describe('shutting down with nothing running', () => {
  it('reports that there was nothing to wait for', async () => {
    const held = harness();

    expect(await held.orchestrator.stop()).toStrictEqual({
      finished: 0,
      stopped: 0,
      abandoned: 0,
    });
  });

  it('takes no session once it has begun stopping', async () => {
    const held = harness();
    await held.records.insert(sessionDocument());

    await held.orchestrator.stop();

    expect(await held.orchestrator.tick()).toBe(0);
    expect(held.push.calls).toHaveLength(0);
  });
});

describe('shutting down while a run is nearly finished', () => {
  it('waits for it rather than resolving with the run still going', async () => {
    const held = harness();
    const pushing = gate();
    held.push.justAfter(async () => pushing.wait);

    await held.records.insert(sessionDocument());
    await held.orchestrator.tick();
    await settle();

    expect(held.orchestrator.running).toBe(1);

    setTimeout(() => {
      pushing.open();
    }, 20);
    const report = await held.orchestrator.stop();

    expect(held.orchestrator.running).toBe(0);
    expect(report).toStrictEqual({ finished: 1, stopped: 0, abandoned: 0 });
  });

  it('lets it record the outcome it earned', async () => {
    const held = harness();
    const pushing = gate();
    held.push.justAfter(async () => pushing.wait);

    await held.records.insert(sessionDocument());
    await held.orchestrator.tick();
    await settle();

    setTimeout(() => {
      pushing.open();
    }, 20);
    await held.orchestrator.stop();

    expect(held.records.documents[0]?.status).toBe('pr_created');
    expect(held.pullRequests.calls).toHaveLength(1);
  });

  it('says what it is waiting for', async () => {
    const held = harness();
    const pushing = gate();
    held.push.justAfter(async () => pushing.wait);

    await held.records.insert(sessionDocument());
    await held.orchestrator.tick();
    await settle();

    setTimeout(() => {
      pushing.open();
    }, 20);
    await held.orchestrator.stop();

    expect(held.logs()).toContain('waiting for the sessions it is running');
  });
});

describe('shutting down while a run is still working', () => {
  async function stopping(): Promise<{
    held: Harness;
    session: SessionDocument;
    report: Awaited<ReturnType<Orchestrator['stop']>>;
  }> {
    let signal: AbortSignal | null = null;
    const held = harness({
      drainMs: 30,
      drainGraceMs: 2_000,
      onPrepare: (_session, given) => {
        signal = given;
      },
    });

    held.push.justAfter(async () => {
      if (signal !== null) {
        await whenAborted(signal);
      }
    });

    const session = sessionDocument();
    await held.records.insert(session);
    await held.orchestrator.tick();
    await settle();

    const report = await held.orchestrator.stop();
    return { held, session, report };
  }

  it('tells the run to stop and counts it', async () => {
    const { held, report } = await stopping();

    expect(report).toStrictEqual({ finished: 0, stopped: 1, abandoned: 0 });
    expect(held.orchestrator.running).toBe(0);
  });

  it('says so, and says nothing will be written about it', async () => {
    const { held } = await stopping();

    expect(held.logs()).toContain('told to stop so this worker can shut down');
  });

  it('writes no outcome, because nobody cancelled this session', async () => {
    const { held } = await stopping();

    expect(held.records.documents[0]?.status).toBe('working');
    expect(held.records.documents[0]?.completedAt).toBeNull();
    expect(held.records.documents[0]?.pullRequest).toBeNull();
    expect(held.logs()).toContain('a shutdown interrupted this session');
  });

  it('opens no pull request after being told to stop', async () => {
    const { held } = await stopping();

    expect(held.push.calls).toHaveLength(1);
    expect(held.pullRequests.calls).toHaveLength(0);
  });

  it('gives the lease back, so another worker can take the session at once', async () => {
    const { held, session } = await stopping();

    expect(await held.leases.holderOf(leaseResource(session.sessionId))).toBeNull();
  });

  it('leaves the session claimable rather than ended', async () => {
    const { held } = await stopping();
    const claimable = await held.records.findClaimable(10);

    expect(claimable).toHaveLength(1);
  });
});

describe('shutting down while a run refuses to stop', () => {
  it('abandons it to lease expiry rather than hanging forever', async () => {
    const held = harness({ drainMs: 20, drainGraceMs: 20 });
    const stuck = gate();
    held.push.justAfter(async () => stuck.wait);

    await held.records.insert(sessionDocument());
    await held.orchestrator.tick();
    await settle();

    const report = await held.orchestrator.stop();

    expect(report).toStrictEqual({ finished: 0, stopped: 0, abandoned: 1 });
    expect(held.logs()).toContain('still running when the shutdown deadline passed');

    stuck.open();
    await settle();
  });
});

describe('being told to stop twice', () => {
  it('drains once and gives both callers the same answer', async () => {
    const held = harness();
    const pushing = gate();
    held.push.justAfter(async () => pushing.wait);

    await held.records.insert(sessionDocument());
    await held.orchestrator.tick();
    await settle();

    setTimeout(() => {
      pushing.open();
    }, 20);

    const [first, second] = await Promise.all([held.orchestrator.stop(), held.orchestrator.stop()]);

    expect(first).toStrictEqual({ finished: 1, stopped: 0, abandoned: 0 });
    expect(second).toBe(first);
  });
});

describe('a run whose outcome cannot be written', () => {
  it('does not reject, so a drain waiting on it still finishes', async () => {
    const held = harness();
    const outcomes: RunOutcome[] = [];

    held.records.recordOutcome = async (_sessionId, outcome): Promise<never> => {
      outcomes.push(outcome);
      return Promise.reject(new Error('the database is closing'));
    };

    await held.records.insert(sessionDocument());
    await held.orchestrator.tick();

    const report = await held.orchestrator.stop();

    expect(outcomes).toHaveLength(1);
    expect(report).toStrictEqual({ finished: 1, stopped: 0, abandoned: 0 });
  });

  it('says the session is going back to another worker', async () => {
    const held = harness();

    held.records.recordOutcome = async (): Promise<never> =>
      Promise.reject(new Error('the database is closing'));

    await held.records.insert(sessionDocument());
    await held.orchestrator.tick();
    await held.orchestrator.stop();

    expect(held.logs()).toContain('another worker will pick this session up');
  });

  it('gives the lease back anyway', async () => {
    const held = harness();
    const session = sessionDocument();

    held.records.recordOutcome = async (): Promise<never> =>
      Promise.reject(new Error('the database is closing'));

    await held.records.insert(session);
    await held.orchestrator.tick();
    await held.orchestrator.stop();

    expect(await held.leases.holderOf(leaseResource(session.sessionId))).toBeNull();
  });
});
