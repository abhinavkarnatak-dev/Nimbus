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
  pending(limit?: number): Promise<SessionEventEnvelope[]>;
  markPublished(eventId: string): Promise<void>;
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
    const eventId = `evt_${sessionId}_${String(claimed.lastEventSequence)}`;
    const document: SessionEventDocument = {
      eventId,
      sessionId,
      userId,
      sequence: claimed.lastEventSequence,
      type: event.type,
      event,
      emittedAt: at,
      expiresAt: new Date(at.getTime() + EVENT_RETENTION_DAYS * 24 * 60 * 60 * 1_000),
      publishedAt: null,
      publishAttempts: 0,
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

  async pending(limit = REPLAY_PAGE_SIZE): Promise<SessionEventEnvelope[]> {
    const documents = await sessionEventsCollection(this.#db)
      .find({ publishedAt: null, eventId: { $exists: true } })
      .sort({ sessionId: 1, sequence: 1 })
      .limit(limit)
      .toArray();
    return documents.map(toEventEnvelope);
  }

  async markPublished(eventId: string): Promise<void> {
    await sessionEventsCollection(this.#db).updateOne(
      { eventId, publishedAt: null },
      { $set: { publishedAt: this.#now() }, $inc: { publishAttempts: 1 } },
    );
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
    const eventId = `evt_${sessionId}_${String(sequence)}`;
    const document: SessionEventDocument = {
      eventId,
      sessionId,
      userId,
      sequence,
      type: event.type,
      event,
      emittedAt: at,
      expiresAt: new Date(at.getTime() + EVENT_RETENTION_DAYS * 24 * 60 * 60 * 1_000),
      publishedAt: null,
      publishAttempts: 0,
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

  async pending(limit = REPLAY_PAGE_SIZE): Promise<SessionEventEnvelope[]> {
    return this.documents
      .filter((one) => one.publishedAt == null)
      .sort((left, right) => left.sessionId.localeCompare(right.sessionId) || left.sequence - right.sequence)
      .slice(0, limit)
      .map(toEventEnvelope);
  }

  async markPublished(eventId: string): Promise<void> {
    const envelope = (await this.pending(this.documents.length)).find((one) => one.eventId === eventId);
    if (envelope === undefined) return;
    const document = this.documents.find(
      (one) => one.sessionId === envelope.sessionId && one.sequence === envelope.sequence,
    );
    if (document !== undefined) {
      document.publishedAt = this.#now();
      document.publishAttempts = (document.publishAttempts ?? 0) + 1;
    }
  }
}
