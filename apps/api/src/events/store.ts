import type { ServerEvent, SessionEventEnvelope } from '@nimbus/contracts';
import type { Db } from 'mongodb';

import { sessionsCollection } from '../db/models/session.js';
import {
  EVENT_RETENTION_DAYS,
  sessionEventsCollection,
  toEventEnvelope,
  type SessionEventDocument,
} from '../db/models/session-event.js';

export const REPLAY_PAGE_SIZE = 500;

export interface EventStore {
  append(sessionId: string, userId: string, event: ServerEvent): Promise<SessionEventEnvelope>;
  since(sessionId: string, sequence: number, limit?: number): Promise<SessionEventEnvelope[]>;
  lastSequence(sessionId: string): Promise<number>;
}

export class MongoEventStore implements EventStore {
  readonly #db: Db;

  readonly #now: () => Date;

  constructor(db: Db, now: () => Date = () => new Date()) {
    this.#db = db;
    this.#now = now;
  }

  async append(
    sessionId: string,
    userId: string,
    event: ServerEvent,
  ): Promise<SessionEventEnvelope> {
    const claimed = await sessionsCollection(this.#db).findOneAndUpdate(
      { sessionId },
      { $inc: { lastEventSequence: 1 } },
      { returnDocument: 'after', projection: { lastEventSequence: 1 } },
    );

    if (claimed === null) {
      throw new Error(`no session called ${sessionId}`);
    }

    const at = this.#now();
    const document: SessionEventDocument = {
      sessionId,
      userId,
      sequence: claimed.lastEventSequence,
      type: event.type,
      event,
      emittedAt: at,
      expiresAt: new Date(at.getTime() + EVENT_RETENTION_DAYS * 24 * 60 * 60 * 1_000),
    };

    await sessionEventsCollection(this.#db).insertOne({ ...document });
    return toEventEnvelope(document);
  }

  async since(
    sessionId: string,
    sequence: number,
    limit = REPLAY_PAGE_SIZE,
  ): Promise<SessionEventEnvelope[]> {
    const documents = await sessionEventsCollection(this.#db)
      .find({ sessionId, sequence: { $gt: sequence } })
      .sort({ sequence: 1 })
      .limit(limit)
      .toArray();

    return documents.map(toEventEnvelope);
  }

  async lastSequence(sessionId: string): Promise<number> {
    const found = await sessionsCollection(this.#db).findOne(
      { sessionId },
      { projection: { lastEventSequence: 1 } },
    );

    return found?.lastEventSequence ?? 0;
  }
}

export class InMemoryEventStore implements EventStore {
  readonly documents: SessionEventDocument[] = [];

  readonly #sequences = new Map<string, number>();

  readonly #now: () => Date;

  constructor(now: () => Date = () => new Date()) {
    this.#now = now;
  }

  async append(
    sessionId: string,
    userId: string,
    event: ServerEvent,
  ): Promise<SessionEventEnvelope> {
    const sequence = (this.#sequences.get(sessionId) ?? 0) + 1;
    this.#sequences.set(sessionId, sequence);

    const at = this.#now();
    const document: SessionEventDocument = {
      sessionId,
      userId,
      sequence,
      type: event.type,
      event,
      emittedAt: at,
      expiresAt: new Date(at.getTime() + EVENT_RETENTION_DAYS * 24 * 60 * 60 * 1_000),
    };

    this.documents.push(document);
    return Promise.resolve(toEventEnvelope(document));
  }

  async since(
    sessionId: string,
    sequence: number,
    limit = REPLAY_PAGE_SIZE,
  ): Promise<SessionEventEnvelope[]> {
    return Promise.resolve(
      this.documents
        .filter((one) => one.sessionId === sessionId && one.sequence > sequence)
        .sort((left, right) => left.sequence - right.sequence)
        .slice(0, limit)
        .map(toEventEnvelope),
    );
  }

  async lastSequence(sessionId: string): Promise<number> {
    return Promise.resolve(this.#sequences.get(sessionId) ?? 0);
  }
}
