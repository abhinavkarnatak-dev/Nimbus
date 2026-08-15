import {
  SessionEventEnvelopeSchema,
  type ServerEvent,
  type SessionEventEnvelope,
} from '@nimbus/contracts';
import type { Redis } from 'ioredis';

import type { Logger } from '../logging/logger.js';
import type { EventStore } from './store.js';

export const EVENT_CHANNEL = 'nimbus:events';

export interface EventPublisher {
  publish(sessionId: string, userId: string, event: ServerEvent): Promise<void>;
}

export interface LiveEventPublisherOptions {
  store: EventStore;
  redis: Redis;
  logger: Logger;
}

export class LiveEventPublisher implements EventPublisher {
  readonly #store: EventStore;

  readonly #redis: Redis;

  readonly #logger: Logger;

  constructor(options: LiveEventPublisherOptions) {
    this.#store = options.store;
    this.#redis = options.redis;
    this.#logger = options.logger;
  }

  async publish(sessionId: string, userId: string, event: ServerEvent): Promise<void> {
    let envelope: SessionEventEnvelope;

    try {
      envelope = await this.#store.append(sessionId, userId, event);
    } catch (error) {
      this.#logger.warn(
        { sessionId, type: event.type, error: String(error) },
        'an event could not be recorded, the run carries on without it',
      );
      return;
    }

    try {
      await this.#redis.publish(EVENT_CHANNEL, JSON.stringify(envelope));
    } catch (error) {
      this.#logger.warn(
        { sessionId, sequence: envelope.sequence, error: String(error) },
        'an event was recorded but could not be sent live, a replay will carry it',
      );
    }
  }
}

export class CollectingEventPublisher implements EventPublisher {
  readonly published: { sessionId: string; event: ServerEvent }[] = [];

  async publish(sessionId: string, _userId: string, event: ServerEvent): Promise<void> {
    this.published.push({ sessionId, event });
    await Promise.resolve();
  }

  typesFor(sessionId: string): string[] {
    return this.published.filter((one) => one.sessionId === sessionId).map((one) => one.event.type);
  }
}

export function readEnvelope(payload: string): SessionEventEnvelope | null {
  let parsed: unknown;

  try {
    parsed = JSON.parse(payload);
  } catch {
    return null;
  }

  const checked = SessionEventEnvelopeSchema.safeParse(parsed);
  return checked.success ? checked.data : null;
}
