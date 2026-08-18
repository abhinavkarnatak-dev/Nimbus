import type {
  CheckResult,
  DeliveryStatus,
  RunStatus,
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
  MESSAGE_ID_PREFIX,
  isActiveSessionStatus,
  sessionsCollection,
  toSessionMessage,
  type SessionDocument,
  type SessionMessageDocument,
  type SessionMessageReceiptDocument,
  type SessionPullRequestDocument,
} from '../db/models/session.js';
import { newPrefixedId } from '../lib/id.js';

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
  /** Delivery is independent from the conversation being open. */
  deliveryStatus?: DeliveryStatus | null;
}

export interface UserMessageInput {
  messageId: string;
  text: string;
  sentAt: Date;
  idempotencyKey: string;
}

export type UserMessageWrite =
  | { outcome: 'created' | 'same_request'; message: SessionMessage }
  | { outcome: 'conflict' | 'inactive' | 'full'; message: null };

export interface SessionRecords {
  insert(document: SessionDocument): Promise<InsertOutcome>;
  findOwned(userId: string, sessionId: string): Promise<SessionDocument | null>;
  findByIdempotencyKey(userId: string, idempotencyKey: string): Promise<SessionDocument | null>;
  findActive(userId: string): Promise<SessionDocument | null>;
  listRecent(userId: string, limit: number): Promise<SessionDocument[]>;
  remove(userId: string, sessionId: string): Promise<boolean>;
  rename(
    userId: string,
    sessionId: string,
    title: string,
    at: Date,
  ): Promise<SessionDocument | null>;
  setPullRequestState(
    userId: string,
    sessionId: string,
    number: number,
    state: 'open' | 'merged' | 'closed',
    at: Date,
  ): Promise<SessionDocument | null>;
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
  pinBaseCommitSha(sessionId: string, candidate: string, at: Date): Promise<string | null>;
  recordProgress(sessionId: string, progress: RunProgress, at: Date): Promise<void>;
  recordOutcome(sessionId: string, outcome: RunOutcome, at: Date): Promise<SessionDocument | null>;
  bumpRetry(sessionId: string, at: Date): Promise<number>;
  isLive(sessionId: string): Promise<boolean>;
  answerOnce(userId: string, sessionId: string, answer: string, at: Date): Promise<boolean>;
  writeUserMessage(
    userId: string,
    sessionId: string,
    input: UserMessageInput,
  ): Promise<UserMessageWrite>;
  resumeAfterMessage(userId: string, sessionId: string, at: Date): Promise<SessionDocument | null>;
  reopenWithMessage(
    userId: string,
    sessionId: string,
    input: UserMessageInput,
    baseCommitSha: string | null,
  ): Promise<UserMessageWrite>;
  addMessage(userId: string, sessionId: string, text: string, at: Date): Promise<boolean>;
  addAgentMessage(sessionId: string, text: string, at: Date, messageId?: string): Promise<boolean>;
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

  async remove(userId: string, sessionId: string): Promise<boolean> {
    return (await sessionsCollection(this.db).deleteOne({ userId, sessionId })).deletedCount === 1;
  }

  async rename(
    userId: string,
    sessionId: string,
    title: string,
    at: Date,
  ): Promise<SessionDocument | null> {
    return await sessionsCollection(this.db).findOneAndUpdate(
      { userId, sessionId },
      { $set: { title, updatedAt: at, lastActivityAt: at } },
      { returnDocument: 'after' },
    );
  }

  async setPullRequestState(
    userId: string,
    sessionId: string,
    number: number,
    state: 'open' | 'merged' | 'closed',
    at: Date,
  ): Promise<SessionDocument | null> {
    return await sessionsCollection(this.db).findOneAndUpdate(
      { userId, sessionId },
      { $set: { [`manualPrStates.${String(number)}`]: state, updatedAt: at, lastActivityAt: at } },
      { returnDocument: 'after' },
    );
  }

  async finish(
    userId: string,
    sessionId: string,
    status: SessionStatus,
    at: Date,
  ): Promise<SessionDocument | null> {
    const result = await sessionsCollection(this.db).findOneAndUpdate(
      { sessionId, userId, status: { $in: [...activeStatuses(), 'ready'] } },
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
        status: { $in: [...activeStatuses(), 'ready'] },
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

  async pinBaseCommitSha(sessionId: string, candidate: string, at: Date): Promise<string | null> {
    await sessionsCollection(this.db).updateOne(
      { sessionId, status: { $in: activeStatuses() }, baseCommitSha: null },
      { $set: { baseCommitSha: candidate, updatedAt: at, lastActivityAt: at } },
    );

    const active = await sessionsCollection(this.db).findOne(
      { sessionId, status: { $in: activeStatuses() } },
      { projection: { baseCommitSha: 1 } },
    );

    return active?.baseCommitSha ?? null;
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
    const written = await this.writeUserMessage(userId, sessionId, {
      messageId: newPrefixedId(MESSAGE_ID_PREFIX),
      text,
      sentAt: at,
      idempotencyKey: newPrefixedId('idk'),
    });
    return written.outcome === 'created';
  }

  async writeUserMessage(
    userId: string,
    sessionId: string,
    input: UserMessageInput,
  ): Promise<UserMessageWrite> {
    const message = saidBy('user', input.text, input.sentAt, input.messageId, input.idempotencyKey);
    const receipt = receiptFor(input);
    const changed = await sessionsCollection(this.db).updateOne(
      {
        sessionId,
        userId,
        status: { $in: activeStatuses() },
        'messageReceipts.idempotencyKey': { $ne: input.idempotencyKey },
        [`messageReceipts.${String(MAX_SESSION_MESSAGES - 1)}`]: { $exists: false },
      },
      {
        $push: {
          messages: { $each: [message], $slice: -MAX_SESSION_MESSAGES },
          messageReceipts: receipt,
        },
        $set: { updatedAt: input.sentAt, lastActivityAt: input.sentAt },
      },
    );

    if (changed.modifiedCount === 1) {
      return {
        outcome: 'created',
        message: toSessionMessage(sessionId, message, MAX_SESSION_MESSAGES - 1),
      };
    }

    const held = await sessionsCollection(this.db).findOne(
      { sessionId, userId },
      { projection: { messageReceipts: 1, status: 1 } },
    );
    const index =
      held?.messageReceipts?.findIndex((one) => one.idempotencyKey === input.idempotencyKey) ?? -1;
    const existing = index < 0 ? undefined : held?.messageReceipts?.[index];

    if (existing !== undefined) {
      return existing.text === input.text
        ? {
            outcome: 'same_request',
            message: messageFromReceipt(sessionId, existing, index),
          }
        : { outcome: 'conflict', message: null };
    }
    return held !== null && (isActiveSessionStatus(held.status) || held.status === 'ready')
      ? { outcome: 'full', message: null }
      : { outcome: 'inactive', message: null };
  }

  async resumeAfterMessage(
    userId: string,
    sessionId: string,
    at: Date,
  ): Promise<SessionDocument | null> {
    return await sessionsCollection(this.db).findOneAndUpdate(
      { sessionId, userId, status: WAITING_STATUS, clarificationQuestion: null },
      {
        $set: {
          status: 'queued',
          currentActivity: 'queued for your follow-up',
          waitingSince: null,
          updatedAt: at,
          lastActivityAt: at,
        },
      },
      { returnDocument: 'after' },
    );
  }

  async reopenWithMessage(
    userId: string,
    sessionId: string,
    input: UserMessageInput,
    baseCommitSha: string | null,
  ): Promise<UserMessageWrite> {
    const message = saidBy('user', input.text, input.sentAt, input.messageId, input.idempotencyKey);
    const receipt = receiptFor(input);
    const changed = await sessionsCollection(this.db).updateOne(
      {
        sessionId,
        userId,
        status: { $in: ['ready', 'completed', 'pr_created', 'failed'] },
        'messageReceipts.idempotencyKey': { $ne: input.idempotencyKey },
        [`messageReceipts.${String(MAX_SESSION_MESSAGES - 1)}`]: { $exists: false },
      },
      {
        $push: {
          messages: { $each: [message], $slice: -MAX_SESSION_MESSAGES },
          messageReceipts: receipt,
        },
        $set: {
          status: 'queued',
          ...(baseCommitSha === null ? {} : { baseCommitSha }),
          currentActivity: 'queued for your follow-up',
          clarificationQuestion: null,
          clarificationAnswer: null,
          waitingSince: null,
          failure: null,
          completedAt: null,
          runStatus: 'queued',
          deliveryStatus: null,
          step: 0,
          retryCount: 0,
          filesRead: [],
          filesChanged: [],
          checks: [],
          toolEvents: [],
          updatedAt: input.sentAt,
          lastActivityAt: input.sentAt,
        },
      },
    );

    if (changed.modifiedCount === 1) {
      return {
        outcome: 'created',
        message: toSessionMessage(sessionId, message, MAX_SESSION_MESSAGES - 1),
      };
    }
    return this.writeUserMessage(userId, sessionId, input);
  }

  async addAgentMessage(
    sessionId: string,
    text: string,
    at: Date,
    messageId = newPrefixedId(MESSAGE_ID_PREFIX),
  ): Promise<boolean> {
    const changed = await sessionsCollection(this.db).updateOne(
      { sessionId, status: { $in: [...activeStatuses(), 'ready'] } },
      {
        $push: {
          messages: {
            $each: [saidBy('agent', text, at, messageId)],
            $slice: -MAX_SESSION_MESSAGES,
          },
        },
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

    return (found?.messages ?? []).map((message, index) =>
      toSessionMessage(sessionId, message, index),
    );
  }

  async askQuestion(sessionId: string, question: string, at: Date): Promise<void> {
    await sessionsCollection(this.db).updateOne(
      { sessionId },
      {
        $set: {
          clarificationQuestion: question,
          clarificationAnswer: null,
          updatedAt: at,
          lastActivityAt: at,
        },
        $push: {
          messages: {
            $each: [saidBy('agent', question, at)],
            $slice: -MAX_SESSION_MESSAGES,
          },
        },
      },
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

  async remove(userId: string, sessionId: string): Promise<boolean> {
    const index = this.documents.findIndex(
      (one) => one.userId === userId && one.sessionId === sessionId,
    );
    if (index < 0) return Promise.resolve(false);
    this.documents.splice(index, 1);
    return Promise.resolve(true);
  }

  async rename(
    userId: string,
    sessionId: string,
    title: string,
    at: Date,
  ): Promise<SessionDocument | null> {
    const held = this.documents.find((one) => one.userId === userId && one.sessionId === sessionId);
    if (held === undefined) return Promise.resolve(null);
    held.title = title;
    held.updatedAt = at;
    held.lastActivityAt = at;
    return Promise.resolve({ ...held });
  }

  async setPullRequestState(
    userId: string,
    sessionId: string,
    number: number,
    state: 'open' | 'merged' | 'closed',
    at: Date,
  ): Promise<SessionDocument | null> {
    const held = this.documents.find((one) => one.userId === userId && one.sessionId === sessionId);
    if (held === undefined) return Promise.resolve(null);
    held.manualPrStates = { ...(held.manualPrStates ?? {}), [String(number)]: state };
    held.updatedAt = at;
    held.lastActivityAt = at;
    return Promise.resolve({ ...held });
  }

  async finish(
    userId: string,
    sessionId: string,
    status: SessionStatus,
    at: Date,
  ): Promise<SessionDocument | null> {
    const held = this.documents.find(
      (one) =>
        one.sessionId === sessionId &&
        one.userId === userId &&
        (isActiveSessionStatus(one.status) || one.status === 'ready'),
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

  async pinBaseCommitSha(sessionId: string, candidate: string, at: Date): Promise<string | null> {
    const held = this.#activeOne(sessionId);

    if (held === undefined) {
      return Promise.resolve(null);
    }

    if (held.baseCommitSha === null) {
      held.baseCommitSha = candidate;
      held.updatedAt = at;
      held.lastActivityAt = at;
    }
    return Promise.resolve(held.baseCommitSha);
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
    const written = await this.writeUserMessage(userId, sessionId, {
      messageId: newPrefixedId(MESSAGE_ID_PREFIX),
      text,
      sentAt: at,
      idempotencyKey: newPrefixedId('idk'),
    });
    return written.outcome === 'created';
  }

  async writeUserMessage(
    userId: string,
    sessionId: string,
    input: UserMessageInput,
  ): Promise<UserMessageWrite> {
    const held = this.documents.find(
      (one) =>
        one.sessionId === sessionId && one.userId === userId && isActiveSessionStatus(one.status),
    );

    if (held === undefined) {
      const ended = this.documents.find(
        (one) => one.sessionId === sessionId && one.userId === userId,
      );
      const existingIndex =
        ended?.messageReceipts?.findIndex(
          (receipt) => receipt.idempotencyKey === input.idempotencyKey,
        ) ?? -1;
      const existing = existingIndex < 0 ? undefined : ended?.messageReceipts?.[existingIndex];

      if (existing === undefined) {
        return Promise.resolve({ outcome: 'inactive', message: null });
      }
      return Promise.resolve(
        existing.text === input.text
          ? {
              outcome: 'same_request',
              message: messageFromReceipt(sessionId, existing, existingIndex),
            }
          : { outcome: 'conflict', message: null },
      );
    }

    const receipts = held.messageReceipts ?? [];
    const existingIndex = receipts.findIndex(
      (receipt) => receipt.idempotencyKey === input.idempotencyKey,
    );
    const existing = existingIndex < 0 ? undefined : receipts[existingIndex];

    if (existing !== undefined) {
      return Promise.resolve(
        existing.text === input.text
          ? {
              outcome: 'same_request',
              message: messageFromReceipt(sessionId, existing, existingIndex),
            }
          : { outcome: 'conflict', message: null },
      );
    }

    if (receipts.length >= MAX_SESSION_MESSAGES) {
      return Promise.resolve({ outcome: 'full', message: null });
    }

    const message = saidBy('user', input.text, input.sentAt, input.messageId, input.idempotencyKey);
    this.#appendMessage(held, message);
    held.messageReceipts = [...receipts, receiptFor(input)];
    return Promise.resolve({
      outcome: 'created',
      message: toSessionMessage(sessionId, message, held.messages.length - 1),
    });
  }

  async resumeAfterMessage(
    userId: string,
    sessionId: string,
    at: Date,
  ): Promise<SessionDocument | null> {
    const held = this.documents.find(
      (one) =>
        one.sessionId === sessionId &&
        one.userId === userId &&
        one.status === WAITING_STATUS &&
        one.clarificationQuestion === null,
    );
    if (held === undefined) return Promise.resolve(null);
    Object.assign(held, {
      status: 'queued',
      currentActivity: 'queued for your follow-up',
      waitingSince: null,
      updatedAt: at,
      lastActivityAt: at,
    });
    return Promise.resolve({ ...held });
  }

  async reopenWithMessage(
    userId: string,
    sessionId: string,
    input: UserMessageInput,
    baseCommitSha: string | null,
  ): Promise<UserMessageWrite> {
    const held = this.documents.find(
      (one) =>
        one.sessionId === sessionId &&
        one.userId === userId &&
        ['ready', 'completed', 'pr_created', 'failed'].includes(one.status),
    );

    if (held === undefined) {
      return this.writeUserMessage(userId, sessionId, input);
    }
    if (held.messages.length >= MAX_SESSION_MESSAGES) {
      return { outcome: 'full', message: null };
    }

    const message = saidBy('user', input.text, input.sentAt, input.messageId, input.idempotencyKey);
    held.messages.push(message);
    held.messageReceipts = [...(held.messageReceipts ?? []), receiptFor(input)];
    Object.assign(held, {
      status: 'queued',
      ...(baseCommitSha === null ? {} : { baseCommitSha }),
      currentActivity: 'queued for your follow-up',
      clarificationQuestion: null,
      clarificationAnswer: null,
      waitingSince: null,
      failure: null,
      completedAt: null,
      runStatus: 'queued',
      deliveryStatus: null,
      step: 0,
      retryCount: 0,
      filesRead: [],
      filesChanged: [],
      checks: [],
      toolEvents: [],
      updatedAt: input.sentAt,
      lastActivityAt: input.sentAt,
    });

    return {
      outcome: 'created',
      message: toSessionMessage(sessionId, message, held.messages.length - 1),
    };
  }

  async addAgentMessage(
    sessionId: string,
    text: string,
    at: Date,
    messageId = newPrefixedId(MESSAGE_ID_PREFIX),
  ): Promise<boolean> {
    const held = this.documents.find(
      (one) =>
        one.sessionId === sessionId &&
        (isActiveSessionStatus(one.status) || one.status === 'ready'),
    );

    if (held === undefined) {
      return Promise.resolve(false);
    }

    this.#appendMessage(held, saidBy('agent', text, at, messageId));
    return Promise.resolve(true);
  }

  async conversationOf(sessionId: string): Promise<SessionMessage[]> {
    const held = this.documents.find((one) => one.sessionId === sessionId);
    return Promise.resolve(
      (held?.messages ?? []).map((message, index) => toSessionMessage(sessionId, message, index)),
    );
  }

  #appendMessage(held: SessionDocument, message: SessionMessageDocument): void {
    held.messages = [...held.messages, message].slice(-MAX_SESSION_MESSAGES);
    held.updatedAt = message.sentAt;
    held.lastActivityAt = message.sentAt;
  }

  async askQuestion(sessionId: string, question: string, at: Date): Promise<void> {
    const held = this.documents.find((one) => one.sessionId === sessionId);

    if (held !== undefined) {
      held.clarificationQuestion = question;
      held.clarificationAnswer = null;
      this.#appendMessage(held, saidBy('agent', question, at));
    }
    return Promise.resolve();
  }
}

function activeStatuses(): SessionStatus[] {
  return [...ACTIVE_SESSION_STATUSES];
}

export function saidBy(
  role: MessageRole,
  text: string,
  at: Date,
  messageId = newPrefixedId(MESSAGE_ID_PREFIX),
  idempotencyKey?: string,
): SessionMessageDocument {
  return {
    messageId,
    role,
    text,
    sentAt: at,
    ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
  };
}

function receiptFor(input: UserMessageInput): SessionMessageReceiptDocument {
  return {
    idempotencyKey: input.idempotencyKey,
    messageId: input.messageId,
    text: input.text,
    sentAt: input.sentAt,
  };
}

function messageFromReceipt(
  sessionId: string,
  receipt: SessionMessageReceiptDocument,
  index: number,
): SessionMessage {
  return toSessionMessage(
    sessionId,
    {
      messageId: receipt.messageId,
      role: 'user',
      text: receipt.text,
      sentAt: receipt.sentAt,
    },
    index,
  );
}

export function startedFields(at: Date): Partial<SessionDocument> {
  return {
    status: RUNNING_STATUS,
    runStatus: 'working',
    deliveryStatus: null,
    currentActivity: 'starting a machine',
    updatedAt: at,
    lastActivityAt: at,
    completedAt: null,
  };
}

export function outcomeFields(outcome: RunOutcome, at: Date): Partial<SessionDocument> {
  const awaiting = outcome.status === WAITING_STATUS;
  const runStatus: RunStatus =
    outcome.status === 'completed' || outcome.status === 'pr_created'
      ? 'succeeded'
      : outcome.status === 'failed'
        ? 'failed'
        : outcome.status === 'cancelled'
          ? 'cancelled'
          : awaiting
            ? 'awaiting_user'
            : 'working';
  const deliveryStatus =
    outcome.deliveryStatus ??
    (outcome.status === 'completed'
      ? 'no_changes'
      : outcome.status === 'pr_created'
        ? 'pr_created'
        : outcome.failure?.code === 'CHECKS_FAILED'
          ? 'checks_failed'
          : outcome.failure?.code === 'PATCH_REJECTED'
            ? 'validation_failed'
            : null);

  return {
    // This is the latest turn's transport status. The record remains a usable
    // conversation; `reopenWithMessage` atomically starts its next turn.
    status: outcome.status,
    runStatus,
    deliveryStatus,
    updatedAt: at,
    lastActivityAt: at,
    completedAt: !isActiveSessionStatus(outcome.status) ? at : null,
    waitingSince: awaiting ? at : null,
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
