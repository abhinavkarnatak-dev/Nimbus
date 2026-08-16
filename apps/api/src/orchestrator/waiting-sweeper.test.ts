import { describe, expect, it } from 'vitest';

import { CapturingMailer } from '../email/capturing-mailer.js';
import { MailService } from '../email/mail-service.js';
import { CollectingEventPublisher } from '../events/publisher.js';
import { InMemorySessionRecords } from '../sessions/repository.js';
import { WAIT_LIMITS } from './limits.js';
import {
  orchestratorLogger,
  pendingApproval,
  sessionDocument,
  waitingDocument,
} from './orchestrator.fixtures.js';
import { WaitingSessionSweeper, timedOut, waitKindOf } from './waiting-sweeper.js';

const A_MINUTE = 60_000;

function sweeperFor(
  documents: readonly Parameters<typeof sessionDocument>[0][] = [],
  options: { events?: CollectingEventPublisher; mailer?: CapturingMailer } = {},
): {
  sweeper: WaitingSessionSweeper;
  records: InMemorySessionRecords;
  events: CollectingEventPublisher;
  mailer: CapturingMailer;
  logs: () => string;
} {
  const captured = orchestratorLogger();
  const records = new InMemorySessionRecords();
  const events = options.events ?? new CollectingEventPublisher();
  const mailer = options.mailer ?? new CapturingMailer();

  for (const document of documents) {
    records.documents.push(sessionDocument(document));
  }

  return {
    records,
    events,
    mailer,
    logs: captured.text,
    sweeper: new WaitingSessionSweeper({
      records,
      logger: captured.logger,
      events,
      mail: new MailService(mailer, 'nimbus@example.com'),
      notifyEmailFor: async () => Promise.resolve('person@example.com'),
    }),
  };
}

describe('working out what a session is waiting for', () => {
  it('calls it a question when one was asked and not answered', () => {
    expect(waitKindOf(waitingDocument(0))).toBe('clarification');
  });

  it('calls it an approval when a card is still pending', () => {
    const document = waitingDocument(0, {
      clarificationQuestion: null,
      approvals: [pendingApproval(new Date())],
    });

    expect(waitKindOf(document)).toBe('approval');
  });

  it('still calls it a question when an old card is lying around unanswered', () => {
    const document = waitingDocument(0, { approvals: [pendingApproval(new Date())] });

    expect(waitKindOf(document)).toBe('clarification');
  });

  it('calls it an approval once the question has been answered', () => {
    const document = waitingDocument(0, {
      clarificationAnswer: 'the dashboard',
      approvals: [pendingApproval(new Date())],
    });

    expect(waitKindOf(document)).toBe('approval');
  });

  it('admits when it cannot tell', () => {
    expect(waitKindOf(waitingDocument(0, { clarificationQuestion: null }))).toBe('unknown');
  });
});

describe('deciding whether a wait has run out', () => {
  it('leaves a question alone until a whole day has passed', () => {
    expect(
      timedOut(waitingDocument(WAIT_LIMITS.clarificationMs - A_MINUTE), new Date()),
    ).toBeNull();
    expect(timedOut(waitingDocument(WAIT_LIMITS.clarificationMs + A_MINUTE), new Date())).toBe(
      'CLARIFICATION_TIMEOUT',
    );
  });

  it('gives an approval only the fifteen minutes its card promised', () => {
    const short = (waited: number) =>
      waitingDocument(waited, {
        clarificationQuestion: null,
        approvals: [pendingApproval(new Date())],
      });

    expect(timedOut(short(WAIT_LIMITS.approvalMs - A_MINUTE), new Date())).toBeNull();
    expect(timedOut(short(WAIT_LIMITS.approvalMs + A_MINUTE), new Date())).toBe('APPROVAL_TIMEOUT');
  });

  it('says nothing about a session that is not waiting at all', () => {
    expect(timedOut(sessionDocument({ waitingSince: null }), new Date())).toBeNull();
  });
});

describe('a question nobody answered', () => {
  it('ends the session rather than leaving it open forever', async () => {
    const held = sweeperFor([waitingDocument(WAIT_LIMITS.clarificationMs + A_MINUTE)]);

    const ended = await held.sweeper.sweep();

    expect(ended).toHaveLength(1);
    expect(held.records.documents[0]?.status).toBe('failed');
  });

  it('says nobody answered, not that something went wrong', async () => {
    const held = sweeperFor([waitingDocument(WAIT_LIMITS.clarificationMs + A_MINUTE)]);

    await held.sweeper.sweep();

    expect(held.records.documents[0]?.failure?.code).toBe('CLARIFICATION_TIMEOUT');
    expect(held.records.documents[0]?.failure?.message).toContain('answered the question in time');
  });

  it('frees the slot, so the person can start something else', async () => {
    const held = sweeperFor([waitingDocument(WAIT_LIMITS.clarificationMs + A_MINUTE)]);

    await held.sweeper.sweep();

    expect(held.records.documents[0]?.completedAt).not.toBeNull();
    expect(await held.records.findActive(held.records.documents[0]?.userId ?? '')).toBeNull();
  });
});

describe('an approval nobody decided', () => {
  it('ends the session after the card it was shown expired', async () => {
    const held = sweeperFor([
      waitingDocument(WAIT_LIMITS.approvalMs + A_MINUTE, {
        clarificationQuestion: null,
        approvals: [pendingApproval(new Date())],
      }),
    ]);

    await held.sweeper.sweep();

    expect(held.records.documents[0]?.failure?.code).toBe('APPROVAL_TIMEOUT');
  });

  it('does not end a question that has only waited fifteen minutes', async () => {
    const held = sweeperFor([waitingDocument(WAIT_LIMITS.approvalMs + A_MINUTE)]);

    const ended = await held.sweeper.sweep();

    expect(ended).toEqual([]);
    expect(held.records.documents[0]?.status).toBe('awaiting_user');
  });
});

describe('what the sweeper must never touch', () => {
  it('leaves a wait that is still inside its time', async () => {
    const held = sweeperFor([waitingDocument(A_MINUTE)]);

    expect(await held.sweeper.sweep()).toEqual([]);
    expect(held.records.documents[0]?.status).toBe('awaiting_user');
  });

  it('leaves a run that has already been answered and is going again', async () => {
    const held = sweeperFor([
      waitingDocument(WAIT_LIMITS.clarificationMs * 2, {
        waitingSince: null,
        clarificationAnswer: 'the dashboard',
      }),
    ]);

    expect(await held.sweeper.sweep()).toEqual([]);
    expect(held.records.documents[0]?.status).toBe('awaiting_user');
  });

  it('leaves a session that is simply running', async () => {
    const held = sweeperFor([sessionDocument({ status: 'working' })]);

    expect(await held.sweeper.sweep()).toEqual([]);
    expect(held.records.documents[0]?.status).toBe('working');
  });

  it('writes nothing over a session that ended while it was looking', async () => {
    const held = sweeperFor([waitingDocument(WAIT_LIMITS.clarificationMs + A_MINUTE)]);
    const session = held.records.documents[0];

    await held.records.finish(
      session?.userId ?? '',
      session?.sessionId ?? '',
      'cancelled',
      new Date(),
    );

    expect(await held.sweeper.sweep()).toEqual([]);
    expect(held.records.documents[0]?.status).toBe('cancelled');
  });
});

describe('telling the person their session ended', () => {
  it('says so on the socket, so an open tab stops waiting', async () => {
    const held = sweeperFor([waitingDocument(WAIT_LIMITS.clarificationMs + A_MINUTE)]);
    const session = held.records.documents[0];

    await held.sweeper.sweep();

    expect(held.events.typesFor(session?.sessionId ?? '')).toContain('session.failed');
  });

  it('writes to them, the same as any other run that failed', async () => {
    const held = sweeperFor([waitingDocument(WAIT_LIMITS.clarificationMs + A_MINUTE)]);

    await held.sweeper.sweep();

    expect(held.mailer.sent).toHaveLength(1);
    expect(held.mailer.sent[0]?.text).toContain('answered the question in time');
  });

  it('ends the session anyway when the mailer is broken', async () => {
    const mailer = new CapturingMailer();
    const held = sweeperFor([waitingDocument(WAIT_LIMITS.clarificationMs + A_MINUTE)], { mailer });
    mailer.failNextSends(new Error('smtp is down'));

    await held.sweeper.sweep();

    expect(held.records.documents[0]?.status).toBe('failed');
  });
});

describe('more than one instance sweeping', () => {
  it('lets only one of them end the session', async () => {
    const held = sweeperFor([waitingDocument(WAIT_LIMITS.clarificationMs + A_MINUTE)]);

    const [first, second] = await Promise.all([held.sweeper.sweepOnce(), held.sweeper.sweepOnce()]);

    expect([...first, ...second]).toHaveLength(1);
  });

  it('holds a named lock so two machines do not both look', async () => {
    const taken: string[] = [];
    const captured = orchestratorLogger();
    const records = new InMemorySessionRecords();

    records.documents.push(waitingDocument(WAIT_LIMITS.clarificationMs + A_MINUTE));

    const sweeper = new WaitingSessionSweeper({
      records,
      logger: captured.logger,
      withLock: async (resource, run) => {
        taken.push(resource);
        return await run();
      },
    });

    await sweeper.sweep();

    expect(taken).toEqual(['session-wait-sweep']);
  });
});

describe('when the sweep itself goes wrong', () => {
  it('logs it and keeps the timer alive for the next one', async () => {
    const captured = orchestratorLogger();
    const records = new InMemorySessionRecords();

    const sweeper = new WaitingSessionSweeper({
      records: Object.assign(records, {
        findWaitingSince: async () => Promise.reject(new Error('mongo is down')),
      }),
      logger: captured.logger,
    });

    expect(await sweeper.sweep()).toBeNull();
    expect(captured.text()).toContain('sweep of waiting sessions failed');
  });
});

describe('shutting the sweeper down', () => {
  it('waits for the sweep it is in the middle of', async () => {
    const captured = orchestratorLogger();
    const records = new InMemorySessionRecords();

    records.documents.push(waitingDocument(WAIT_LIMITS.clarificationMs + A_MINUTE));

    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });

    const sweeper = new WaitingSessionSweeper({
      records,
      logger: captured.logger,
      withLock: async (_resource, run) => {
        await held;
        return await run();
      },
    });

    const sweeping = sweeper.sweep();
    const stopping = sweeper.stop();

    expect(records.documents[0]?.status).toBe('awaiting_user');

    release();
    await stopping;

    expect(records.documents[0]?.status).toBe('failed');
    await sweeping;
  });

  it('starts no new sweep once it has stopped, so nothing runs against a closed database', async () => {
    const captured = orchestratorLogger();
    const records = new InMemorySessionRecords();

    records.documents.push(waitingDocument(WAIT_LIMITS.clarificationMs + A_MINUTE));

    const sweeper = new WaitingSessionSweeper({ records, logger: captured.logger });
    await sweeper.stop();

    expect(await sweeper.sweep()).toBeNull();
    expect(records.documents[0]?.status).toBe('awaiting_user');
  });
});
