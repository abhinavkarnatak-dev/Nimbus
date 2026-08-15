import type { SessionStatus } from '@nimbus/contracts';
import type { Db } from 'mongodb';

import {
  ACTIVE_SESSION_STATUSES,
  isActiveSessionStatus,
  sessionsCollection,
  type SessionDocument,
} from '../db/models/session.js';

export const INSERT_OUTCOMES = ['created', 'same_request', 'already_active'] as const;

export type InsertOutcome = (typeof INSERT_OUTCOMES)[number];

export const DUPLICATE_KEY = 11_000;

export interface SessionRecords {
  insert(document: SessionDocument): Promise<InsertOutcome>;
  findOwned(userId: string, sessionId: string): Promise<SessionDocument | null>;
  findByIdempotencyKey(userId: string, idempotencyKey: string): Promise<SessionDocument | null>;
  findActive(userId: string): Promise<SessionDocument | null>;
  listRecent(userId: string, limit: number): Promise<SessionDocument[]>;
  finish(
    userId: string,
    sessionId: string,
    status: SessionStatus,
    at: Date,
  ): Promise<SessionDocument | null>;
}

export function isDuplicateKey(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  return (error as { code?: unknown }).code === DUPLICATE_KEY;
}

export class MongoSessionRecords implements SessionRecords {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  async insert(document: SessionDocument): Promise<InsertOutcome> {
    try {
      await sessionsCollection(this.db).insertOne({ ...document });
      return 'created';
    } catch (error) {
      if (!isDuplicateKey(error)) {
        throw error;
      }

      const sameRequest = await this.findByIdempotencyKey(document.userId, document.idempotencyKey);

      return sameRequest === null ? 'already_active' : 'same_request';
    }
  }

  async findOwned(userId: string, sessionId: string): Promise<SessionDocument | null> {
    return sessionsCollection(this.db).findOne({ sessionId, userId });
  }

  async findByIdempotencyKey(
    userId: string,
    idempotencyKey: string,
  ): Promise<SessionDocument | null> {
    return sessionsCollection(this.db).findOne({ userId, idempotencyKey });
  }

  async findActive(userId: string): Promise<SessionDocument | null> {
    return sessionsCollection(this.db).findOne({ userId, status: { $in: activeStatuses() } });
  }

  async listRecent(userId: string, limit: number): Promise<SessionDocument[]> {
    return sessionsCollection(this.db)
      .find({ userId })
      .sort({ createdAt: -1 })
      .limit(limit)
      .toArray();
  }

  async finish(
    userId: string,
    sessionId: string,
    status: SessionStatus,
    at: Date,
  ): Promise<SessionDocument | null> {
    const result = await sessionsCollection(this.db).findOneAndUpdate(
      { sessionId, userId, status: { $in: activeStatuses() } },
      {
        $set: {
          status,
          completedAt: at,
          updatedAt: at,
          lastActivityAt: at,
          currentActivity: null,
        },
      },
      { returnDocument: 'after' },
    );

    return result ?? null;
  }
}

export class InMemorySessionRecords implements SessionRecords {
  readonly documents: SessionDocument[] = [];

  async insert(document: SessionDocument): Promise<InsertOutcome> {
    const sameRequest = this.documents.some(
      (held) => held.userId === document.userId && held.idempotencyKey === document.idempotencyKey,
    );

    if (sameRequest) {
      return Promise.resolve('same_request');
    }

    const alreadyActive = this.documents.some(
      (held) => held.userId === document.userId && isActiveSessionStatus(held.status),
    );

    if (alreadyActive && isActiveSessionStatus(document.status)) {
      return Promise.resolve('already_active');
    }

    this.documents.push({ ...document });
    return Promise.resolve('created');
  }

  async findOwned(userId: string, sessionId: string): Promise<SessionDocument | null> {
    const found = this.documents.find(
      (held) => held.sessionId === sessionId && held.userId === userId,
    );
    return Promise.resolve(found ?? null);
  }

  async findByIdempotencyKey(
    userId: string,
    idempotencyKey: string,
  ): Promise<SessionDocument | null> {
    const found = this.documents.find(
      (held) => held.userId === userId && held.idempotencyKey === idempotencyKey,
    );
    return Promise.resolve(found ?? null);
  }

  async findActive(userId: string): Promise<SessionDocument | null> {
    const found = this.documents.find(
      (held) => held.userId === userId && isActiveSessionStatus(held.status),
    );
    return Promise.resolve(found ?? null);
  }

  async listRecent(userId: string, limit: number): Promise<SessionDocument[]> {
    return Promise.resolve(
      this.documents
        .filter((held) => held.userId === userId)
        .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())
        .slice(0, limit),
    );
  }

  async finish(
    userId: string,
    sessionId: string,
    status: SessionStatus,
    at: Date,
  ): Promise<SessionDocument | null> {
    const held = this.documents.find(
      (one) =>
        one.sessionId === sessionId && one.userId === userId && isActiveSessionStatus(one.status),
    );

    if (held === undefined) {
      return Promise.resolve(null);
    }

    held.status = status;
    held.completedAt = at;
    held.updatedAt = at;
    held.lastActivityAt = at;
    held.currentActivity = null;
    return Promise.resolve({ ...held });
  }
}

function activeStatuses(): SessionStatus[] {
  return [...ACTIVE_SESSION_STATUSES];
}
