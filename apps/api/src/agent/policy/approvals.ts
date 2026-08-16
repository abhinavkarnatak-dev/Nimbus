import {
  ApprovalRecordSchema,
  type ApprovalEffect,
  type ApprovalRecord,
  type ApprovalStatus,
} from '@nimbus/contracts';

import { newPrefixedId } from '../../lib/id.js';
import { POLICY_LIMITS } from './limits.js';

export const APPROVAL_ERROR_CODES = [
  'APPROVAL_NOT_FOUND',
  'APPROVAL_EXPIRED',
  'APPROVAL_REJECTED',
  'APPROVAL_ALREADY_USED',
  'APPROVAL_MISMATCH',
  'APPROVAL_LIMIT_REACHED',
] as const;

export type ApprovalErrorCode = (typeof APPROVAL_ERROR_CODES)[number];

export class ApprovalError extends Error {
  readonly code: ApprovalErrorCode;

  constructor(code: ApprovalErrorCode, message: string) {
    super(message);
    this.name = 'ApprovalError';
    this.code = code;
  }
}

export interface StoredApproval extends ApprovalRecord {
  usedAt: string | null;
}

export interface ApprovalStore {
  request(actionHash: string, effect: ApprovalEffect): Promise<StoredApproval>;
  decide(approvalId: string, actionHash: string, approved: boolean): Promise<StoredApproval>;
  findUsable(actionHash: string): Promise<StoredApproval | null>;
  findRefused(actionHash: string): Promise<StoredApproval | null>;
  consume(approvalId: string): Promise<void>;
  list(): Promise<StoredApproval[]>;
}

export function statusNow(approval: StoredApproval, nowMs: number): ApprovalStatus {
  if (approval.status === 'rejected') {
    return 'rejected';
  }

  if (Date.parse(approval.expiresAt) <= nowMs) {
    return 'expired';
  }
  return approval.status;
}

export class InMemoryApprovals implements ApprovalStore {
  private readonly held = new Map<string, StoredApproval>();

  private readonly ttlMs: number;

  private readonly now: () => number;

  constructor(options: { ttlMs?: number; now?: () => number } = {}) {
    this.ttlMs = options.ttlMs ?? POLICY_LIMITS.approvalTtlMs;
    this.now = options.now ?? ((): number => Date.now());
  }

  async request(actionHash: string, effect: ApprovalEffect): Promise<StoredApproval> {
    const open = this.openFor(actionHash);

    if (open !== null) {
      return await Promise.resolve(open);
    }

    if (this.held.size >= POLICY_LIMITS.approvalsPerSessionMax) {
      throw new ApprovalError(
        'APPROVAL_LIMIT_REACHED',
        'This session has asked for as many approvals as it is allowed.',
      );
    }

    const at = this.now();
    const record = ApprovalRecordSchema.parse({
      approvalId: newPrefixedId('apr'),
      actionHash,
      effect,
      status: 'pending',
      requestedAt: new Date(at).toISOString(),
      expiresAt: new Date(at + this.ttlMs).toISOString(),
    });

    const stored: StoredApproval = { ...record, usedAt: null };
    this.held.set(stored.approvalId, stored);
    return await Promise.resolve(stored);
  }

  async decide(approvalId: string, actionHash: string, approved: boolean): Promise<StoredApproval> {
    const held = this.held.get(approvalId);

    if (held === undefined) {
      throw new ApprovalError('APPROVAL_NOT_FOUND', 'There is no such approval.');
    }

    if (held.actionHash !== actionHash) {
      throw new ApprovalError(
        'APPROVAL_MISMATCH',
        'That decision does not match the action it was asked about.',
      );
    }

    if (statusNow(held, this.now()) === 'expired') {
      throw new ApprovalError('APPROVAL_EXPIRED', 'That approval request has expired.');
    }

    const decided: StoredApproval = {
      ...held,
      status: approved ? 'approved' : 'rejected',
      decidedAt: new Date(this.now()).toISOString(),
    };

    this.held.set(approvalId, decided);
    return await Promise.resolve(decided);
  }

  private openFor(actionHash: string): StoredApproval | null {
    for (const one of this.held.values()) {
      if (one.actionHash !== actionHash || one.usedAt !== null) {
        continue;
      }

      const status = statusNow(one, this.now());

      if (status === 'pending' || status === 'approved') {
        return one;
      }
    }
    return null;
  }

  async findUsable(actionHash: string): Promise<StoredApproval | null> {
    for (const held of this.held.values()) {
      if (held.actionHash !== actionHash || held.usedAt !== null) {
        continue;
      }

      if (statusNow(held, this.now()) === 'approved') {
        return await Promise.resolve(held);
      }
    }
    return await Promise.resolve(null);
  }

  async findRefused(actionHash: string): Promise<StoredApproval | null> {
    for (const held of this.held.values()) {
      if (held.actionHash === actionHash && statusNow(held, this.now()) === 'rejected') {
        return await Promise.resolve(held);
      }
    }
    return await Promise.resolve(null);
  }

  async consume(approvalId: string): Promise<void> {
    const held = this.held.get(approvalId);

    if (held === undefined) {
      throw new ApprovalError('APPROVAL_NOT_FOUND', 'There is no such approval.');
    }

    if (held.usedAt !== null) {
      throw new ApprovalError('APPROVAL_ALREADY_USED', 'That approval has already been used.');
    }

    this.held.set(approvalId, { ...held, usedAt: new Date(this.now()).toISOString() });
    await Promise.resolve();
  }

  async list(): Promise<StoredApproval[]> {
    return await Promise.resolve(
      [...this.held.values()].map((held) => ({
        ...held,
        status: statusNow(held, this.now()),
      })),
    );
  }
}
