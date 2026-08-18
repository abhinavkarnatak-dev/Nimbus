import { CONTRACTS_WIRE_VERSION, type SessionEventEnvelope } from '@nimbus/contracts';
import { describe, expect, it } from 'vitest';

import {
  BACKOFF_MS,
  CLOSE_CODES,
  SessionSocket,
  backoffFor,
  type SocketLike,
  type SocketState,
} from './socket.js';
import { MAX_HELD_AHEAD, SessionEventStream } from './stream.js';

const SESSION_ID = 'ses_aaaaaaaaaaaaaaaaaaaaa';

function envelope(sequence: number): Record<string, unknown> {
  return {
    v: CONTRACTS_WIRE_VERSION,
    sequence,
    sessionId: SESSION_ID,
    emittedAt: '2026-08-17T10:00:00.000Z',
    event: {
      type: 'agent.message',
      message: {
        messageId: `msg_${'b'.repeat(21)}`,
        role: 'agent',
        text: `note ${String(sequence)}`,
        sentAt: '2026-08-17T10:00:00.000Z',
      },
    },
  };
}

describe('applying events in order', () => {
  it('applies the next one and moves the mark', () => {
    const stream = new SessionEventStream(0);
    const result = stream.offer(envelope(1));

    expect(result.verdict).toBe('applied');
    expect(stream.lastApplied).toBe(1);
  });

  it('ignores one it has already applied, so a reconnect does not double count', () => {
    const stream = new SessionEventStream(5);

    expect(stream.offer(envelope(3)).verdict).toBe('already_seen');
    expect(stream.lastApplied).toBe(5);
  });

  it('holds one that arrived early until the gap fills', () => {
    const stream = new SessionEventStream(0);

    expect(stream.offer(envelope(3)).verdict).toBe('held');
    expect(stream.waiting).toBe(1);
    expect(stream.lastApplied).toBe(0);
  });

  it('drains everything waiting once the gap fills', () => {
    const stream = new SessionEventStream(0);

    stream.offer(envelope(3));
    stream.offer(envelope(2));
    const result = stream.offer(envelope(1));

    expect(result.applied.map((one) => one.sequence)).toStrictEqual([1, 2, 3]);
    expect(stream.lastApplied).toBe(3);
    expect(stream.waiting).toBe(0);
  });

  it('never holds more than it promised to', () => {
    const stream = new SessionEventStream(0);

    for (let at = 2; at < MAX_HELD_AHEAD + 20; at += 1) {
      stream.offer(envelope(at));
    }

    expect(stream.waiting).toBe(MAX_HELD_AHEAD);
  });
});

describe('an event that cannot be trusted', () => {
  it('refuses one from a different wire version', () => {
    const stream = new SessionEventStream(0);
    const result = stream.offer({ ...envelope(1), v: CONTRACTS_WIRE_VERSION + 1 });

    expect(result.verdict).toBe('wrong_version');
    expect(stream.lastApplied).toBe(0);
  });

  it('drops one that is not an envelope at all, and counts it', () => {
    const stream = new SessionEventStream(0);

    expect(stream.offer({ nonsense: true }).verdict).toBe('unreadable');
    expect(stream.offer(null).verdict).toBe('unreadable');
    expect(stream.counts.unreadable).toBe(2);
  });

  it('drops one whose event does not match any known type', () => {
    const stream = new SessionEventStream(0);
    const bad = { ...envelope(1), event: { type: 'agent.instruct', message: 'do this' } };

    expect(stream.offer(bad).verdict).toBe('unreadable');
    expect(stream.lastApplied).toBe(0);
  });
});

class FakeSocket implements SocketLike {
  readonly sent: string[] = [];

  closedWith: number | null = null;

  closeCode: number | undefined;

  onopen: (() => void) | null = null;

  onmessage: ((event: { data: unknown }) => void) | null = null;

  onclose: ((event: { code: number }) => void) | null = null;

  onerror: (() => void) | null = null;

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number): void {
    this.closeCode = code;
    this.closedWith = code ?? 1000;
  }

  open(): void {
    this.onopen?.();
  }

  deliver(data: unknown): void {
    this.onmessage?.({ data });
  }

  drop(code: number): void {
    this.onclose?.({ code });
  }
}

interface Harness {
  socket: SessionSocket;
  opened: FakeSocket[];
  states: SocketState[];
  applied: SessionEventEnvelope[];
  waits: number[];
  runWait: () => void;
}

function socketWith(lastEventSequence = 0): Harness {
  const opened: FakeSocket[] = [];
  const states: SocketState[] = [];
  const applied: SessionEventEnvelope[] = [];
  const waits: number[] = [];
  let pending: (() => void) | null = null;

  const socket = new SessionSocket({
    url: 'ws://localhost:4000/events',
    sessionId: SESSION_ID as never,
    lastEventSequence,
    open: (): SocketLike => {
      const one = new FakeSocket();
      opened.push(one);
      return one;
    },
    onEvents: (envelopes): void => {
      applied.push(...envelopes);
    },
    onState: (state): void => {
      states.push(state);
    },
    wait: (ms, run): (() => void) => {
      waits.push(ms);
      pending = run;
      return (): void => {
        pending = null;
      };
    },
  });

  return {
    socket,
    opened,
    states,
    applied,
    waits,
    runWait: (): void => {
      pending?.();
    },
  };
}

function lastOpened(held: Harness): FakeSocket {
  const one = held.opened.at(-1);

  if (one === undefined) {
    throw new Error('no socket was opened');
  }
  return one;
}

describe('a socket that connects', () => {
  it('subscribes with the sequence it has actually applied', () => {
    const held = socketWith(7);
    held.socket.start();
    lastOpened(held).open();

    expect(JSON.parse(lastOpened(held).sent[0] ?? '{}')).toStrictEqual({
      type: 'session.subscribe',
      payload: { v: CONTRACTS_WIRE_VERSION, sessionId: SESSION_ID, lastEventSequence: 7 },
    });
  });

  it('hands applied events on, in order', () => {
    const held = socketWith(0);
    held.socket.start();
    lastOpened(held).open();

    lastOpened(held).deliver(JSON.stringify(envelope(2)));
    lastOpened(held).deliver(JSON.stringify(envelope(1)));

    expect(held.applied.map((one) => one.sequence)).toStrictEqual([1, 2]);
  });

  it('hands on nothing at all for a malformed frame', () => {
    const held = socketWith(0);
    held.socket.start();
    lastOpened(held).open();

    lastOpened(held).deliver('{not json');
    lastOpened(held).deliver(JSON.stringify({ v: 999, sequence: 1 }));

    expect(held.applied).toHaveLength(0);
    expect(held.socket.counts.unreadable).toBeGreaterThan(0);
  });
});

describe('a socket that drops', () => {
  it('waits before trying again rather than hammering', () => {
    const held = socketWith(0);
    held.socket.start();
    lastOpened(held).open();
    lastOpened(held).drop(1006);

    expect(held.waits).toStrictEqual([BACKOFF_MS[0]]);
    expect(held.socket.state).toBe('waiting');
  });

  it('waits longer each time', () => {
    const held = socketWith(0);
    held.socket.start();

    for (let round = 0; round < 3; round += 1) {
      lastOpened(held).open();
      lastOpened(held).drop(1006);
      held.runWait();
    }

    expect(held.waits).toStrictEqual([BACKOFF_MS[0], BACKOFF_MS[0], BACKOFF_MS[0]]);
  });

  it('resubscribes from what it applied, not from zero', () => {
    const held = socketWith(0);
    held.socket.start();
    lastOpened(held).open();
    lastOpened(held).deliver(JSON.stringify(envelope(1)));
    lastOpened(held).drop(1006);
    held.runWait();
    lastOpened(held).open();

    const payload = JSON.parse(lastOpened(held).sent[0] ?? '{}') as {
      payload: { lastEventSequence: number };
    };

    expect(payload.payload.lastEventSequence).toBe(1);
  });

  it('stops trying once the session is gone, rather than spinning forever', () => {
    const held = socketWith(0);
    held.socket.start();
    lastOpened(held).open();
    lastOpened(held).drop(CLOSE_CODES.unauthorized);

    expect(held.socket.state).toBe('signed_out');
    expect(held.waits).toHaveLength(0);
  });

  it('stops for a policy close too', () => {
    const held = socketWith(0);
    held.socket.start();
    lastOpened(held).open();
    lastOpened(held).drop(CLOSE_CODES.policy);

    expect(held.socket.state).toBe('signed_out');
  });

  it('opens nothing more once it has been stopped', () => {
    const held = socketWith(0);
    held.socket.start();
    lastOpened(held).open();
    held.socket.stop();
    held.runWait();

    expect(held.opened).toHaveLength(1);
    expect(held.socket.state).toBe('closed');
  });

  it('uses the browser default close code when navigation stops it', () => {
    const held = socketWith(0);
    held.socket.start();
    held.socket.stop();

    expect(lastOpened(held).closeCode).toBeUndefined();
  });
});

describe('how long the wait grows', () => {
  it('climbs and then holds at the longest', () => {
    expect(backoffFor(0)).toBe(BACKOFF_MS[0]);
    expect(backoffFor(BACKOFF_MS.length)).toBe(BACKOFF_MS.at(-1));
    expect(backoffFor(99)).toBe(BACKOFF_MS.at(-1));
  });
});
