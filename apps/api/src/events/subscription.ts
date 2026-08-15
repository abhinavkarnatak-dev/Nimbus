import type { SessionEventEnvelope } from '@nimbus/contracts';

import type { EventStore } from './store.js';
import { SOCKET_LIMITS } from './limits.js';

export type Deliver = (envelope: SessionEventEnvelope) => void;

export interface SubscriptionOptions {
  sessionId: string;
  from: number;
  store: EventStore;
  deliver: Deliver;
  pageSize?: number;
}

export class Subscription {
  readonly sessionId: string;

  readonly #store: EventStore;

  readonly #deliver: Deliver;

  readonly #pageSize: number;

  readonly #waiting: SessionEventEnvelope[] = [];

  #from: number;

  #sent = 0;

  #catchingUp = true;

  #closed = false;

  constructor(options: SubscriptionOptions) {
    this.sessionId = options.sessionId;
    this.#store = options.store;
    this.#deliver = options.deliver;
    this.#pageSize = options.pageSize ?? SOCKET_LIMITS.replayPageSize;
    this.#from = options.from;
  }

  get sent(): number {
    return this.#sent;
  }

  get catchingUp(): boolean {
    return this.#catchingUp;
  }

  offer(envelope: SessionEventEnvelope): void {
    if (this.#closed || envelope.sessionId !== this.sessionId) {
      return;
    }

    if (this.#catchingUp) {
      this.#waiting.push(envelope);
      return;
    }
    this.#send(envelope);
  }

  async replay(): Promise<void> {
    for (;;) {
      const page = await this.#store.since(this.sessionId, this.#from, this.#pageSize);

      for (const envelope of page) {
        this.#send(envelope);
      }

      if (page.length < this.#pageSize) {
        break;
      }
    }

    this.#catchingUp = false;

    for (const envelope of this.#waiting.splice(0)) {
      this.#send(envelope);
    }
  }

  close(): void {
    this.#closed = true;
    this.#waiting.length = 0;
  }

  #send(envelope: SessionEventEnvelope): void {
    if (this.#closed || envelope.sequence <= this.#from) {
      return;
    }

    this.#from = envelope.sequence;
    this.#sent += 1;
    this.#deliver(envelope);
  }
}
