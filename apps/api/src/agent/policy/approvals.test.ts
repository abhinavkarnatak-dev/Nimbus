import { ApprovalRecordSchema, type ApprovalEffect } from '@nimbus/contracts';
import { describe, expect, it } from 'vitest';

import { InMemoryApprovals, statusNow, type StoredApproval } from './approvals.js';
import { POLICY_LIMITS } from './limits.js';

const HASH = 'a'.repeat(64);
const OTHER_HASH = 'b'.repeat(64);

const EFFECT: ApprovalEffect = {
  category: 'protected_path_change',
  summary: 'change a workflow file',
  paths: ['.github/workflows/ci.yml'],
  reason: 'that path is protected',
  risk: 'high',
};

function held(overrides: Partial<StoredApproval> = {}): StoredApproval {
  const record = ApprovalRecordSchema.parse({
    approvalId: 'apr_approvalapprovalappro',
    actionHash: HASH,
    effect: EFFECT,
    status: 'approved',
    requestedAt: '2026-08-15T12:00:00.000Z',
    expiresAt: '2026-08-15T12:15:00.000Z',
  });

  return { ...record, usedAt: null, ...overrides };
}

describe('statusNow', () => {
  it('leaves an approval alone while it is still good', () => {
    expect(statusNow(held(), Date.parse('2026-08-15T12:10:00.000Z'))).toBe('approved');
  });

  it('calls it expired once its time has passed', () => {
    expect(statusNow(held(), Date.parse('2026-08-15T12:20:00.000Z'))).toBe('expired');
  });

  it('expires exactly on the boundary rather than a moment after', () => {
    expect(statusNow(held(), Date.parse('2026-08-15T12:15:00.000Z'))).toBe('expired');
  });

  it('keeps a rejection a rejection, even after it would have expired', () => {
    expect(statusNow(held({ status: 'rejected' }), Date.parse('2026-08-15T12:20:00.000Z'))).toBe(
      'rejected',
    );
  });

  it('leaves a pending one pending', () => {
    expect(statusNow(held({ status: 'pending' }), Date.parse('2026-08-15T12:01:00.000Z'))).toBe(
      'pending',
    );
  });
});

describe('InMemoryApprovals', () => {
  it('starts a request as pending, with an expiry', async () => {
    const store = new InMemoryApprovals({ ttlMs: 60_000, now: () => 1_000_000 });
    const request = await store.request(HASH, EFFECT);

    expect(request.status).toBe('pending');
    expect(Date.parse(request.expiresAt) - Date.parse(request.requestedAt)).toBe(60_000);
    expect(request.usedAt).toBeNull();
  });

  it('finds nothing usable while it is pending', async () => {
    const store = new InMemoryApprovals();
    await store.request(HASH, EFFECT);

    expect(await store.findUsable(HASH)).toBeNull();
  });

  it('finds it once a person has approved it', async () => {
    const store = new InMemoryApprovals();
    const request = await store.request(HASH, EFFECT);
    await store.decide(request.approvalId, HASH, true);

    expect((await store.findUsable(HASH))?.approvalId).toBe(request.approvalId);
  });

  it('finds nothing for a different action', async () => {
    const store = new InMemoryApprovals();
    const request = await store.request(HASH, EFFECT);
    await store.decide(request.approvalId, HASH, true);

    expect(await store.findUsable(OTHER_HASH)).toBeNull();
  });

  it('finds nothing once it has been used', async () => {
    const store = new InMemoryApprovals();
    const request = await store.request(HASH, EFFECT);
    await store.decide(request.approvalId, HASH, true);
    await store.consume(request.approvalId);

    expect(await store.findUsable(HASH)).toBeNull();
  });

  it('refuses to use the same approval twice', async () => {
    const store = new InMemoryApprovals();
    const request = await store.request(HASH, EFFECT);
    await store.decide(request.approvalId, HASH, true);
    await store.consume(request.approvalId);

    await expect(store.consume(request.approvalId)).rejects.toThrow(
      expect.objectContaining({ code: 'APPROVAL_ALREADY_USED' }) as Error,
    );
  });

  it('refuses to decide an approval that has expired', async () => {
    let clock = 1_000_000;
    const store = new InMemoryApprovals({ ttlMs: 1_000, now: () => clock });
    const request = await store.request(HASH, EFFECT);

    clock += 2_000;
    await expect(store.decide(request.approvalId, HASH, true)).rejects.toThrow(
      expect.objectContaining({ code: 'APPROVAL_EXPIRED' }) as Error,
    );
  });

  it('finds nothing usable once it has expired, even though it was approved', async () => {
    let clock = 1_000_000;
    const store = new InMemoryApprovals({ ttlMs: 1_000, now: () => clock });
    const request = await store.request(HASH, EFFECT);
    await store.decide(request.approvalId, HASH, true);

    clock += 2_000;
    expect(await store.findUsable(HASH)).toBeNull();
  });

  it('finds nothing usable when the person said no', async () => {
    const store = new InMemoryApprovals();
    const request = await store.request(HASH, EFFECT);
    await store.decide(request.approvalId, HASH, false);

    expect(await store.findUsable(HASH)).toBeNull();
  });

  it('reports the status it has now, not the one it was stored with', async () => {
    let clock = 1_000_000;
    const store = new InMemoryApprovals({ ttlMs: 1_000, now: () => clock });
    const request = await store.request(HASH, EFFECT);
    await store.decide(request.approvalId, HASH, true);

    clock += 2_000;
    expect((await store.list())[0]?.status).toBe('expired');
  });

  it('stops a session asking forever', async () => {
    const store = new InMemoryApprovals();

    for (let index = 0; index < POLICY_LIMITS.approvalsPerSessionMax; index += 1) {
      await store.request(String(index).padStart(64, '0'), EFFECT);
    }

    await expect(store.request(HASH, EFFECT)).rejects.toThrow(
      expect.objectContaining({ code: 'APPROVAL_LIMIT_REACHED' }) as Error,
    );
  });

  it('asks once for one action, however many times the agent asks', async () => {
    const store = new InMemoryApprovals();
    const first = await store.request(HASH, EFFECT);
    const second = await store.request(HASH, EFFECT);
    const third = await store.request(HASH, EFFECT);

    expect(second.approvalId).toBe(first.approvalId);
    expect(third.approvalId).toBe(first.approvalId);
    expect(await store.list()).toHaveLength(1);
  });

  it('returns the approved one rather than starting a fresh request', async () => {
    const store = new InMemoryApprovals();
    const first = await store.request(HASH, EFFECT);
    await store.decide(first.approvalId, HASH, true);

    expect((await store.request(HASH, EFFECT)).status).toBe('approved');
  });

  it('asks again once the old one has been used', async () => {
    const store = new InMemoryApprovals();
    const first = await store.request(HASH, EFFECT);
    await store.decide(first.approvalId, HASH, true);
    await store.consume(first.approvalId);

    expect((await store.request(HASH, EFFECT)).approvalId).not.toBe(first.approvalId);
  });

  it('asks again once the old one was rejected', async () => {
    const store = new InMemoryApprovals();
    const first = await store.request(HASH, EFFECT);
    await store.decide(first.approvalId, HASH, false);

    expect((await store.request(HASH, EFFECT)).approvalId).not.toBe(first.approvalId);
  });

  it('keeps different actions apart', async () => {
    const store = new InMemoryApprovals();
    const first = await store.request(HASH, EFFECT);
    const other = await store.request(OTHER_HASH, EFFECT);

    expect(other.approvalId).not.toBe(first.approvalId);
  });

  it('keeps the effect a person was shown, exactly', async () => {
    const store = new InMemoryApprovals();
    const request = await store.request(HASH, EFFECT);

    expect(request.effect).toEqual(EFFECT);
  });
});
