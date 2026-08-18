import {
  CONTRACTS_WIRE_VERSION,
  type ClientMessage,
  type SessionEventEnvelope,
  type SessionId,
} from '@nimbus/contracts';

import { SessionEventStream, type StreamCounts } from './stream.js';

export const BACKOFF_MS = [500, 1_000, 2_000, 5_000, 10_000, 20_000] as const;

export const CLOSE_CODES = {
  policy: 1008,
  unauthorized: 4401,
  forbidden: 4403,
} as const;

export const GIVING_UP_CODES: readonly number[] = [
  CLOSE_CODES.policy,
  CLOSE_CODES.unauthorized,
  CLOSE_CODES.forbidden,
];

export type SocketState = 'idle' | 'connecting' | 'live' | 'waiting' | 'signed_out' | 'closed';

export interface SocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number }) => void) | null;
  onerror: (() => void) | null;
}

export interface SessionSocketOptions {
  url: string;
  sessionId: SessionId;
  lastEventSequence?: number;
  open: (url: string) => SocketLike;
  onEvents: (envelopes: readonly SessionEventEnvelope[]) => void;
  onState?: (state: SocketState) => void;
  wait?: (ms: number, run: () => void) => () => void;
}

export function backoffFor(attempt: number): number {
  return BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)] ?? 20_000;
}

export class SessionSocket {
  readonly #options: SessionSocketOptions;

  readonly #stream: SessionEventStream;

  readonly #wait: (ms: number, run: () => void) => () => void;

  #socket: SocketLike | null = null;

  #cancelWait: (() => void) | null = null;

  #attempt = 0;

  #state: SocketState = 'idle';

  #stopped = false;

  constructor(options: SessionSocketOptions) {
    this.#options = options;
    this.#stream = new SessionEventStream(options.lastEventSequence ?? 0);
    this.#wait =
      options.wait ??
      ((ms, run): (() => void) => {
        const timer = setTimeout(run, ms);
        return (): void => {
          clearTimeout(timer);
        };
      });
  }

  get state(): SocketState {
    return this.#state;
  }

  get lastApplied(): number {
    return this.#stream.lastApplied;
  }

  get counts(): Readonly<StreamCounts> {
    return this.#stream.counts;
  }

  get attempts(): number {
    return this.#attempt;
  }

  start(): void {
    if (this.#stopped || this.#socket !== null) {
      return;
    }
    this.#connect();
  }

  stop(): void {
    this.#stopped = true;
    this.#cancelWait?.();
    this.#cancelWait = null;
    this.#socket?.close();
    this.#socket = null;
    this.#moveTo('closed');
  }

  #connect(): void {
    this.#moveTo('connecting');

    const socket = this.#options.open(this.#options.url);
    this.#socket = socket;

    socket.onopen = (): void => {
      this.#attempt = 0;
      this.#moveTo('live');
      this.#subscribe(socket);
    };

    socket.onmessage = (event): void => {
      this.#receive(event.data);
    };

    socket.onclose = (event): void => {
      this.#closed(event.code);
    };

    socket.onerror = (): void => {
      socket.close();
    };
  }

  #subscribe(socket: SocketLike): void {
    const message: ClientMessage = {
      type: 'session.subscribe',
      payload: {
        v: CONTRACTS_WIRE_VERSION,
        sessionId: this.#options.sessionId,
        lastEventSequence: this.#stream.lastApplied,
      },
    };

    socket.send(JSON.stringify(message));
  }

  #receive(data: unknown): void {
    if (typeof data !== 'string') {
      this.#stream.offer(null);
      return;
    }

    let payload: unknown;

    try {
      payload = JSON.parse(data);
    } catch {
      this.#stream.offer(null);
      return;
    }

    const result = this.#stream.offer(payload);

    if (result.applied.length > 0) {
      this.#options.onEvents(result.applied);
    }
  }

  #closed(code: number): void {
    this.#socket = null;

    if (this.#stopped) {
      return;
    }

    if (GIVING_UP_CODES.includes(code)) {
      this.#stopped = true;
      this.#moveTo('signed_out');
      return;
    }

    const delay = backoffFor(this.#attempt);
    this.#attempt += 1;
    this.#moveTo('waiting');
    this.#cancelWait = this.#wait(delay, () => {
      this.#cancelWait = null;

      if (!this.#stopped) {
        this.#connect();
      }
    });
  }

  #moveTo(state: SocketState): void {
    if (this.#state === state) {
      return;
    }

    this.#state = state;
    this.#options.onState?.(state);
  }
}
