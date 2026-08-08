import { describe, expect, it } from 'vitest';

import {
  ApprovalDecisionBodySchema,
  ApprovalEffectSchema,
  ApprovalRequestSchema,
} from './approvals.js';
import { LIMITS } from './limits.js';
import {
  approvalEffectFixture,
  approvalRequestFixture,
  VALID_ACTION_HASH,
  VALID_APPROVAL_ID,
  VALID_SESSION_ID,
} from './session.fixtures.js';

describe('approval effect', () => {
  it('accepts a fully described effect', () => {
    expect(ApprovalEffectSchema.parse(approvalEffectFixture())).toEqual(approvalEffectFixture());
  });

  it('requires a non-empty reason, so an approval can never be unexplained', () => {
    expect(ApprovalEffectSchema.safeParse({ ...approvalEffectFixture(), reason: '' }).success).toBe(
      false,
    );
  });

  it('requires a recognised category', () => {
    expect(
      ApprovalEffectSchema.safeParse({ ...approvalEffectFixture(), category: 'something_else' })
        .success,
    ).toBe(false);
  });

  it('rejects paths that escape the workspace', () => {
    expect(
      ApprovalEffectSchema.safeParse({ ...approvalEffectFixture(), paths: ['../../etc/passwd'] })
        .success,
    ).toBe(false);
  });

  it('caps the number of listed paths', () => {
    const paths = Array.from(
      { length: LIMITS.approvalPathsMax + 1 },
      (_, i) => `src/file${String(i)}.ts`,
    );
    expect(ApprovalEffectSchema.safeParse({ ...approvalEffectFixture(), paths }).success).toBe(
      false,
    );
  });

  it('rejects an unknown risk level', () => {
    expect(
      ApprovalEffectSchema.safeParse({ ...approvalEffectFixture(), risk: 'none' }).success,
    ).toBe(false);
  });
});

describe('approval request', () => {
  it('accepts a complete request', () => {
    expect(ApprovalRequestSchema.parse(approvalRequestFixture())).toEqual(approvalRequestFixture());
  });

  it('requires an expiry, so an approval cannot be open ended', () => {
    const { expiresAt: _expiresAt, ...withoutExpiry } = approvalRequestFixture();
    expect(ApprovalRequestSchema.safeParse(withoutExpiry).success).toBe(false);
  });

  it('requires a well formed action hash', () => {
    expect(
      ApprovalRequestSchema.safeParse({ ...approvalRequestFixture(), actionHash: 'not-a-hash' })
        .success,
    ).toBe(false);
  });
});

describe('approval decision', () => {
  const valid = () => ({
    approvalId: VALID_APPROVAL_ID,
    actionHash: VALID_ACTION_HASH,
    decision: 'approved' as const,
  });

  it('accepts approve and reject', () => {
    expect(ApprovalDecisionBodySchema.parse(valid())).toEqual(valid());
    expect(ApprovalDecisionBodySchema.parse({ ...valid(), decision: 'rejected' }).decision).toBe(
      'rejected',
    );
  });

  it('requires the action hash, so a decision is always bound to exact parameters', () => {
    const { actionHash: _actionHash, ...withoutHash } = valid();
    expect(ApprovalDecisionBodySchema.safeParse(withoutHash).success).toBe(false);
  });

  it('rejects an approval id that is a session id', () => {
    expect(
      ApprovalDecisionBodySchema.safeParse({ ...valid(), approvalId: VALID_SESSION_ID }).success,
    ).toBe(false);
  });

  it('rejects an unknown decision and any extra field', () => {
    expect(ApprovalDecisionBodySchema.safeParse({ ...valid(), decision: 'maybe' }).success).toBe(
      false,
    );
    expect(ApprovalDecisionBodySchema.safeParse({ ...valid(), force: true }).success).toBe(false);
  });
});
