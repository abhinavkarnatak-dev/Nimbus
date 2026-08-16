import type {
  CheckResult,
  FileChange,
  MessageRole,
  SessionFailure,
  SessionMessage,
  SessionStatus,
} from '@nimbus/contracts';
import type { Db } from 'mongodb';

import {
  ACTIVE_SESSION_STATUSES,
  MAX_SESSION_MESSAGES,
  isActiveSessionStatus,
  sessionsCollection,
  toSessionMessage,
  type SessionDocument,
  type SessionMessageDocument,
  type SessionPullRequestDocument,
} from '../db/models/session.js';

export const INSERT_OUTCOMES = ['created', 'same_request', 'already_active'] as const;

export type InsertOutcome = (typeof INSERT_OUTCOMES)[number];

export const DUPLICATE_KEY = 11_000;

export const WAITING_STATUS: SessionStatus = 'awaiting_user';

export const RUNNING_STATUS: SessionStatus = 'working';

export const RUNNING_SESSION_STATUSES: readonly SessionStatus[] = [
  'provisioning',
  'indexing',
  'working',
  'validating',
  'pushing',
];

export function wasLeftMidRun(status: SessionStatus): boolean {
  return RUNNING_SESSION_STATUSES.includes(status);
}

export interface RunProgress {
  step: number;
  currentActivity: string | null;
}

export interface RunOutcome {
  status: SessionStatus;
  failure?: SessionFailure | null;
  branch?: string | null;
  baseCommitSha?: string | null;
  sandboxId?: string | null;
  pullRequest?: SessionPullRequestDocument | null;
  step?: number;
  currentActivity?: string | null;
  filesChanged?: FileChange[];
  checks?: CheckResult[];
}

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
  findClaimable(limit: number): Promise<SessionDocument[]>;
  findWaitingSince(cutoff: Date, limit: number): Promise<SessionDocument[]>;
  findById(sessionId: string): Promise<SessionDocument | null>;
  startRun(sessionId: string, at: Date): Promise<SessionDocument | null>;
  recordProgress(sessionId: string, progress: RunProgress, at: Date): Promise<void>;
  recordOutcome(sessionId: string, outcome: RunOutcome, at: Date): Promise<SessionDocument | null>;
  bumpRetry(sessionId: string, at: Date): Promise<number>;
  isLive(sessionId: string): Promise<boolean>;
  answerOnce(userId: string, sessionId: string, answer: string, at: Date): Promise<boolean>;
  addMessage(userId: string, sessionId: string, text: string, at: Date): Promise<boolean>;
  addAgentMessage(sessionId: string, text: string, at: Date): Promise<boolean>;
  conversationOf(sessionId: string): Promise<SessionMessage[]>;
  askQuestion(sessionId: string, question: string, at: Date): Promise<void>;
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

  async findClaimable(limit: number): Promise<SessionDocument[]> {
    return sessionsCollection(this.db)
      .find({
        status: { $in: activeStatuses() },
        $or: [{ status: { $ne: WAITING_STATUS } }, { waitingSince: null }],
      })
      .sort({ createdAt: 1 })
      .limit(limit)
      .toArray();
  }

  async findWaitingSince(cutoff: Date, limit: number): Promise<SessionDocument[]> {
    return sessionsCollection(this.db)
      .find({ status: WAITING_STATUS, waitingSince: { $ne: null, $lte: cutoff } })
      .sort({ waitingSince: 1 })
      .limit(limit)
      .toArray();
  }

  async findById(sessionId: string): Promise<SessionDocument | null> {
    return sessionsCollection(this.db).findOne({ sessionId });
  }

  async startRun(sessionId: string, at: Date): Promise<SessionDocument | null> {
    const result = await sessionsCollection(this.db).findOneAndUpdate(
      { sessionId, status: { $in: activeStatuses() } },
      { $set: startedFields(at) },
      { returnDocument: 'after' },
    );

    return result ?? null;
  }

  async recordProgress(sessionId: string, progress: RunProgress, at: Date): Promise<void> {
    await sessionsCollection(this.db).updateOne(
      { sessionId, status: { $in: activeStatuses() } },
      {
        $set: { currentActivity: progress.currentActivity, updatedAt: at, lastActivityAt: at },
        $max: { step: progress.step },
      },
    );
  }

  async recordOutcome(
    sessionId: string,
    outcome: RunOutcome,
    at: Date,
  ): Promise<SessionDocument | null> {
    const written = outcomeFields(outcome, at);
    const result = await sessionsCollection(this.db).findOneAndUpdate(
      { sessionId, status: { $in: activeStatuses() } },
      outcome.step === undefined
        ? { $set: written }
        : { $set: written, $max: { step: outcome.step } },
      { returnDocument: 'after' },
    );

    return result ?? null;
  }

  async bumpRetry(sessionId: string, at: Date): Promise<number> {
    const result = await sessionsCollection(this.db).findOneAndUpdate(
      { sessionId },
      { $inc: { retryCount: 1 }, $set: { updatedAt: at } },
      { returnDocument: 'after' },
    );

    return result?.retryCount ?? 0;
  }

  async isLive(sessionId: string): Promise<boolean> {
    const found = await sessionsCollection(this.db).countDocuments(
      { sessionId, status: { $in: activeStatuses() } },
      { limit: 1 },
    );

    return found > 0;
  }

  async answerOnce(userId: string, sessionId: string, answer: string, at: Date): Promise<boolean> {
    const changed = await sessionsCollection(this.db).updateOne(
      { sessionId, userId, clarificationAnswer: null, status: { $in: activeStatuses() } },
      {
        $set: {
          clarificationAnswer: answer,
          waitingSince: null,
          updatedAt: at,
          lastActivityAt: at,
        },
      },
    );

    return changed.modifiedCount === 1;
  }

  async addMessage(userId: string, sessionId: string, text: string, at: Date): Promise<boolean> {
    const changed = await sessionsCollection(this.db).updateOne(
      { sessionId, userId, status: { $in: activeStatuses() } },
      {
        $push: { messages: { $each: [saidBy('user', text, at)], $slice: -MAX_SESSION_MESSAGES } },
        $set: { updatedAt: at, lastActivityAt: at },
      },
    );

    return changed.modifiedCount === 1;
  }

  async addAgentMessage(sessionId: string, text: string, at: Date): Promise<boolean> {
    const changed = await sessionsCollection(this.db).updateOne(
      { sessionId, status: { $in: activeStatuses() } },
      {
        $push: { messages: { $each: [saidBy('agent', text, at)], $slice: -MAX_SESSION_MESSAGES } },
        $set: { updatedAt: at, lastActivityAt: at },
      },
    );

    return changed.modifiedCount === 1;
  }

  async conversationOf(sessionId: string): Promise<SessionMessage[]> {
    const found = await sessionsCollection(this.db).findOne(
      { sessionId },
      { projection: { messages: 1 } },
    );

    return (found?.messages ?? []).map(toSessionMessage);
  }

  async askQuestion(sessionId: string, question: string, at: Date): Promise<void> {
    await sessionsCollection(this.db).updateOne(
      { sessionId },
      { $set: { clarificationQuestion: question, updatedAt: at, lastActivityAt: at } },
    );
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

  async findClaimable(limit: number): Promise<SessionDocument[]> {
    return Promise.resolve(
      this.documents
        .filter(
          (held) =>
            isActiveSessionStatus(held.status) &&
            (held.status !== WAITING_STATUS || held.waitingSince === null),
        )
        .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime())
        .slice(0, limit),
    );
  }

  async findWaitingSince(cutoff: Date, limit: number): Promise<SessionDocument[]> {
    return Promise.resolve(
      this.documents
        .filter(
          (held) =>
            held.status === WAITING_STATUS &&
            held.waitingSince !== null &&
            held.waitingSince.getTime() <= cutoff.getTime(),
        )
        .sort(
          (left, right) =>
            (left.waitingSince?.getTime() ?? 0) - (right.waitingSince?.getTime() ?? 0),
        )
        .slice(0, limit),
    );
  }

  async findById(sessionId: string): Promise<SessionDocument | null> {
    return Promise.resolve(this.documents.find((held) => held.sessionId === sessionId) ?? null);
  }

  async startRun(sessionId: string, at: Date): Promise<SessionDocument | null> {
    const held = this.#activeOne(sessionId);

    if (held === undefined) {
      return Promise.resolve(null);
    }

    Object.assign(held, startedFields(at));
    return Promise.resolve({ ...held });
  }

  async recordProgress(sessionId: string, progress: RunProgress, at: Date): Promise<void> {
    const held = this.#activeOne(sessionId);

    if (held === undefined) {
      return Promise.resolve();
    }

    held.step = Math.max(held.step, progress.step);
    held.currentActivity = progress.currentActivity;
    held.updatedAt = at;
    held.lastActivityAt = at;
    return Promise.resolve();
  }

  async recordOutcome(
    sessionId: string,
    outcome: RunOutcome,
    at: Date,
  ): Promise<SessionDocument | null> {
    const held = this.#activeOne(sessionId);

    if (held === undefined) {
      return Promise.resolve(null);
    }

    Object.assign(held, outcomeFields(outcome, at));

    if (outcome.step !== undefined) {
      held.step = Math.max(held.step, outcome.step);
    }
    return Promise.resolve({ ...held });
  }

  #activeOne(sessionId: string): SessionDocument | undefined {
    return this.documents.find(
      (one) => one.sessionId === sessionId && isActiveSessionStatus(one.status),
    );
  }

  async bumpRetry(sessionId: string, at: Date): Promise<number> {
    const held = this.documents.find((one) => one.sessionId === sessionId);

    if (held === undefined) {
      return Promise.resolve(0);
    }

    held.retryCount += 1;
    held.updatedAt = at;
    return Promise.resolve(held.retryCount);
  }

  async isLive(sessionId: string): Promise<boolean> {
    return Promise.resolve(
      this.documents.some(
        (one) => one.sessionId === sessionId && isActiveSessionStatus(one.status),
      ),
    );
  }

  async answerOnce(userId: string, sessionId: string, answer: string, at: Date): Promise<boolean> {
    const held = this.documents.find(
      (one) =>
        one.sessionId === sessionId &&
        one.userId === userId &&
        one.clarificationAnswer === null &&
        isActiveSessionStatus(one.status),
    );

    if (held === undefined) {
      return Promise.resolve(false);
    }

    held.clarificationAnswer = answer;
    held.waitingSince = null;
    held.updatedAt = at;
    held.lastActivityAt = at;
    return Promise.resolve(true);
  }

  async addMessage(userId: string, sessionId: string, text: string, at: Date): Promise<boolean> {
    const held = this.documents.find(
      (one) =>
        one.sessionId === sessionId && one.userId === userId && isActiveSessionStatus(one.status),
    );

    if (held === undefined) {
      return Promise.resolve(false);
    }

    this.#appendMessage(held, 'user', text, at);
    return Promise.resolve(true);
  }

  async addAgentMessage(sessionId: string, text: string, at: Date): Promise<boolean> {
    const held = this.#activeOne(sessionId);

    if (held === undefined) {
      return Promise.resolve(false);
    }

    this.#appendMessage(held, 'agent', text, at);
    return Promise.resolve(true);
  }

  async conversationOf(sessionId: string): Promise<SessionMessage[]> {
    const held = this.documents.find((one) => one.sessionId === sessionId);
    return Promise.resolve((held?.messages ?? []).map(toSessionMessage));
  }

  #appendMessage(held: SessionDocument, role: MessageRole, text: string, at: Date): void {
    held.messages = [...held.messages, saidBy(role, text, at)].slice(-MAX_SESSION_MESSAGES);
    held.updatedAt = at;
    held.lastActivityAt = at;
  }

  async askQuestion(sessionId: string, question: string, at: Date): Promise<void> {
    const held = this.documents.find((one) => one.sessionId === sessionId);

    if (held !== undefined) {
      held.clarificationQuestion = question;
      held.updatedAt = at;
      held.lastActivityAt = at;
    }
    return Promise.resolve();
  }
}

function activeStatuses(): SessionStatus[] {
  return [...ACTIVE_SESSION_STATUSES];
}

export function saidBy(role: MessageRole, text: string, at: Date): SessionMessageDocument {
  return { role, text, sentAt: at };
}

export function startedFields(at: Date): Partial<SessionDocument> {
  return {
    status: RUNNING_STATUS,
    currentActivity: 'starting a machine',
    updatedAt: at,
    lastActivityAt: at,
    completedAt: null,
  };
}

export function outcomeFields(outcome: RunOutcome, at: Date): Partial<SessionDocument> {
  const terminal = !isActiveSessionStatus(outcome.status);

  return {
    status: outcome.status,
    updatedAt: at,
    lastActivityAt: at,
    completedAt: terminal ? at : null,
    waitingSince: outcome.status === WAITING_STATUS ? at : null,
    ...(outcome.failure === undefined ? {} : { failure: outcome.failure }),
    ...(outcome.branch === undefined ? {} : { branch: outcome.branch }),
    ...(outcome.baseCommitSha === undefined ? {} : { baseCommitSha: outcome.baseCommitSha }),
    ...(outcome.sandboxId === undefined ? {} : { sandboxId: outcome.sandboxId }),
    ...(outcome.pullRequest === undefined ? {} : { pullRequest: outcome.pullRequest }),
    ...(outcome.currentActivity === undefined ? {} : { currentActivity: outcome.currentActivity }),
    ...(outcome.filesChanged === undefined ? {} : { filesChanged: outcome.filesChanged }),
    ...(outcome.checks === undefined ? {} : { checks: outcome.checks }),
  };
}
