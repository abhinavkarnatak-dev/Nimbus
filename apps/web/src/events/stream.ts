import {
  CONTRACTS_WIRE_VERSION,
  SessionEventEnvelopeSchema,
  type SessionEventEnvelope,
} from '@nimbus/contracts';

export const MAX_HELD_AHEAD = 200;

export type EnvelopeVerdict = 'applied' | 'already_seen' | 'held' | 'unreadable' | 'wrong_version';

export interface StreamCounts {
  applied: number;
  alreadySeen: number;
  held: number;
  unreadable: number;
  wrongVersion: number;
}

export interface OfferResult {
  verdict: EnvelopeVerdict;
  applied: SessionEventEnvelope[];
}

export function readEnvelope(payload: unknown): SessionEventEnvelope | null {
  const parsed = SessionEventEnvelopeSchema.safeParse(payload);
  return parsed.success ? parsed.data : null;
}

export function looksLikeWrongVersion(payload: unknown): boolean {
  if (typeof payload !== 'object' || payload === null) {
    return false;
  }

  const version = (payload as { v?: unknown }).v;
  return typeof version === 'number' && version !== CONTRACTS_WIRE_VERSION;
}

export class SessionEventStream {
  readonly #ahead = new Map<number, SessionEventEnvelope>();

  readonly #counts: StreamCounts = {
    applied: 0,
    alreadySeen: 0,
    held: 0,
    unreadable: 0,
    wrongVersion: 0,
  };

  #applied: number;

  constructor(lastEventSequence = 0) {
    this.#applied = lastEventSequence;
  }

  get lastApplied(): number {
    return this.#applied;
  }

  get waiting(): number {
    return this.#ahead.size;
  }

  get counts(): Readonly<StreamCounts> {
    return { ...this.#counts };
  }

  offer(payload: unknown): OfferResult {
    if (looksLikeWrongVersion(payload)) {
      this.#counts.wrongVersion += 1;
      return { verdict: 'wrong_version', applied: [] };
    }

    const envelope = readEnvelope(payload);

    if (envelope === null) {
      this.#counts.unreadable += 1;
      return { verdict: 'unreadable', applied: [] };
    }

    if (envelope.sequence <= this.#applied) {
      this.#counts.alreadySeen += 1;
      return { verdict: 'already_seen', applied: [] };
    }

    if (envelope.sequence > this.#applied + 1) {
      this.#hold(envelope);
      return { verdict: 'held', applied: [] };
    }

    return { verdict: 'applied', applied: this.#drainFrom(envelope) };
  }

  restart(lastEventSequence: number): void {
    this.#ahead.clear();
    this.#applied = lastEventSequence;
  }

  #hold(envelope: SessionEventEnvelope): void {
    if (this.#ahead.has(envelope.sequence)) {
      this.#counts.alreadySeen += 1;
      return;
    }

    if (this.#ahead.size >= MAX_HELD_AHEAD) {
      const oldest = [...this.#ahead.keys()].sort((left, right) => left - right)[0];

      if (oldest !== undefined) {
        this.#ahead.delete(oldest);
      }
    }

    this.#ahead.set(envelope.sequence, envelope);
    this.#counts.held += 1;
  }

  #drainFrom(first: SessionEventEnvelope): SessionEventEnvelope[] {
    const applied = [first];
    this.#applied = first.sequence;

    for (;;) {
      const next = this.#ahead.get(this.#applied + 1);

      if (next === undefined) {
        break;
      }

      this.#ahead.delete(next.sequence);
      applied.push(next);
      this.#applied = next.sequence;
    }

    this.#counts.applied += applied.length;
    return applied;
  }
}
