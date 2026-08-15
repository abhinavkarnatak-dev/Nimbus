import { ApprovalRecordSchema, type ApprovalEffect, type ApprovalStatus } from '@nimbus/contracts';
import type { Db } from 'mongodb';

import {
  ApprovalError,
  statusNow,
  type ApprovalStore,
  type StoredApproval,
} from '../agent/policy/approvals.js';
import { POLICY_LIMITS } from '../agent/policy/limits.js';
import { sessionsCollection, type SessionApprovalDocument } from '../db/models/session.js';
import { newPrefixedId } from '../lib/id.js';

export function toStored(document: SessionApprovalDocument): StoredApproval {
  const record = ApprovalRecordSchema.parse({
    approvalId: document.approvalId,
    actionHash: document.actionHash,
    effect: document.effect,
    status: document.status,
    requestedAt: document.requestedAt.toISOString(),
    expiresAt: document.expiresAt.toISOString(),
    ...(document.decidedAt === undefined ? {} : { decidedAt: document.decidedAt.toISOString() }),
  });

  return { ...record, usedAt: document.usedAt?.toISOString() ?? null };
}

export interface MongoApprovalsOptions {
  db: Db;
  sessionId: string;
  ttlMs?: number;
  now?: () => number;
}

export class MongoApprovals implements ApprovalStore {
  readonly #db: Db;

  readonly #sessionId: string;

  readonly #ttlMs: number;

  readonly #now: () => number;

  constructor(options: MongoApprovalsOptions) {
    this.#db = options.db;
    this.#sessionId = options.sessionId;
    this.#ttlMs = options.ttlMs ?? POLICY_LIMITS.approvalTtlMs;
    this.#now = options.now ?? ((): number => Date.now());
  }

  async request(actionHash: string, effect: ApprovalEffect): Promise<StoredApproval> {
    const held = await this.#held();
    const open = held.find((one) => isOpenFor(one, actionHash, this.#now()));

    if (open !== undefined) {
      return open;
    }

    if (held.length >= POLICY_LIMITS.approvalsPerSessionMax) {
      throw new ApprovalError(
        'APPROVAL_LIMIT_REACHED',
        'This session has asked for as many approvals as it is allowed.',
      );
    }

    const at = this.#now();
    const document: SessionApprovalDocument = {
      approvalId: newPrefixedId('apr'),
      actionHash,
      effect,
      status: 'pending',
      requestedAt: new Date(at),
      expiresAt: new Date(at + this.#ttlMs),
    };

    await sessionsCollection(this.#db).updateOne(
      { sessionId: this.#sessionId },
      { $push: { approvals: document } },
    );

    return toStored(document);
  }

  async decide(approvalId: string, actionHash: string, approved: boolean): Promise<StoredApproval> {
    const held = await this.#one(approvalId);

    if (held.actionHash !== actionHash) {
      throw new ApprovalError(
        'APPROVAL_MISMATCH',
        'That decision does not match the action it was asked about.',
      );
    }

    if (statusNow(held, this.#now()) === 'expired') {
      throw new ApprovalError('APPROVAL_EXPIRED', 'That approval request has expired.');
    }

    if (held.usedAt !== null) {
      throw new ApprovalError('APPROVAL_ALREADY_USED', 'That approval has already been used.');
    }

    const status: ApprovalStatus = approved ? 'approved' : 'rejected';
    const decidedAt = new Date(this.#now());

    const changed = await sessionsCollection(this.#db).updateOne(
      {
        sessionId: this.#sessionId,
        approvals: { $elemMatch: { approvalId, status: 'pending' } },
      },
      {
        $set: {
          'approvals.$[card].status': status,
          'approvals.$[card].decidedAt': decidedAt,
        },
      },
      { arrayFilters: [{ 'card.approvalId': approvalId }] },
    );

    if (changed.modifiedCount !== 1) {
      throw new ApprovalError('APPROVAL_ALREADY_USED', 'That approval has already been decided.');
    }

    return { ...held, status, decidedAt: decidedAt.toISOString() };
  }

  async findUsable(actionHash: string): Promise<StoredApproval | null> {
    const held = await this.#held();

    return (
      held.find(
        (one) =>
          one.actionHash === actionHash &&
          one.usedAt === null &&
          statusNow(one, this.#now()) === 'approved',
      ) ?? null
    );
  }

  async consume(approvalId: string): Promise<void> {
    const usedAt = new Date(this.#now());

    const changed = await sessionsCollection(this.#db).updateOne(
      {
        sessionId: this.#sessionId,
        approvals: { $elemMatch: { approvalId, usedAt: { $exists: false } } },
      },
      { $set: { 'approvals.$[card].usedAt': usedAt } },
      { arrayFilters: [{ 'card.approvalId': approvalId }] },
    );

    if (changed.modifiedCount !== 1) {
      throw new ApprovalError('APPROVAL_ALREADY_USED', 'That approval has already been used.');
    }
  }

  async list(): Promise<StoredApproval[]> {
    const held = await this.#held();

    return held.map((one) => ({ ...one, status: statusNow(one, this.#now()) }));
  }

  async #held(): Promise<StoredApproval[]> {
    const session = await sessionsCollection(this.#db).findOne(
      { sessionId: this.#sessionId },
      { projection: { approvals: 1 } },
    );

    return (session?.approvals ?? []).map(toStored);
  }

  async #one(approvalId: string): Promise<StoredApproval> {
    const found = (await this.#held()).find((one) => one.approvalId === approvalId);

    if (found === undefined) {
      throw new ApprovalError('APPROVAL_NOT_FOUND', 'There is no such approval.');
    }
    return found;
  }
}

function isOpenFor(approval: StoredApproval, actionHash: string, nowMs: number): boolean {
  if (approval.actionHash !== actionHash || approval.usedAt !== null) {
    return false;
  }

  const status = statusNow(approval, nowMs);
  return status === 'pending' || status === 'approved';
}
