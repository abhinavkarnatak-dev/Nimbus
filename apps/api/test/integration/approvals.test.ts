import type { ApprovalEffect } from '@nimbus/contracts';
import { createTestDatabase, type TestDatabase } from '@nimbus/test-utils';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { ApprovalError } from '../../src/agent/policy/approvals.js';
import { POLICY_LIMITS } from '../../src/agent/policy/limits.js';
import { PolicyGate, REFUSED_BY_PERSON } from '../../src/agent/policy/policy.js';
import { ensureDatabaseSchema } from '../../src/db/bootstrap.js';
import { sessionsCollection } from '../../src/db/models/session.js';
import { capturingLogger } from '../../src/llm/llm.fixtures.js';
import { sessionDocument } from '../../src/orchestrator/orchestrator.fixtures.js';
import { MongoApprovals } from '../../src/sessions/approvals.js';

let testDatabase: TestDatabase;
let sessionId: string;

const EFFECT: ApprovalEffect = {
  category: 'protected_path_change',
  summary: 'apply_patch: that path is protected',
  paths: ['src/auth/session.ts'],
  reason: 'that path is protected',
  risk: 'high',
};

const HASH = 'a'.repeat(64);
const OTHER_HASH = 'b'.repeat(64);

const PROTECTED_ACTION = {
  tool: 'create_file',
  input: { path: '.github/workflows/deploy.yml', contents: 'name: deploy\n' },
};

function approvals(now?: () => number): MongoApprovals {
  return new MongoApprovals({
    db: testDatabase.db,
    sessionId,
    ...(now === undefined ? {} : { now }),
  });
}

async function codeOf(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (error) {
    return error instanceof ApprovalError ? error.code : 'NOT_AN_APPROVAL_ERROR';
  }
  return 'NO_ERROR';
}

beforeAll(async () => {
  testDatabase = await createTestDatabase();
  await ensureDatabaseSchema(testDatabase.db, capturingLogger().logger);
}, 60_000);

afterAll(async () => {
  await testDatabase.cleanup();
});

beforeEach(async () => {
  await sessionsCollection(testDatabase.db).deleteMany({});

  const session = sessionDocument();
  sessionId = session.sessionId;
  await sessionsCollection(testDatabase.db).insertOne({ ...session });
});

describe('asking for an approval', () => {
  it('writes a card onto the session', async () => {
    const card = await approvals().request(HASH, EFFECT);

    expect(card.status).toBe('pending');
    expect(card.actionHash).toBe(HASH);

    const stored = await sessionsCollection(testDatabase.db).findOne({ sessionId });
    expect(stored?.approvals).toHaveLength(1);
  });

  it('gives back the same card when asked twice for one action', async () => {
    const first = await approvals().request(HASH, EFFECT);
    const second = await approvals().request(HASH, EFFECT);

    expect(second.approvalId).toBe(first.approvalId);

    const stored = await sessionsCollection(testDatabase.db).findOne({ sessionId });
    expect(stored?.approvals).toHaveLength(1);
  });

  it('makes a second card for a genuinely different action', async () => {
    await approvals().request(HASH, EFFECT);
    await approvals().request(OTHER_HASH, EFFECT);

    const stored = await sessionsCollection(testDatabase.db).findOne({ sessionId });
    expect(stored?.approvals).toHaveLength(2);
  });

  it('refuses once a session has asked as often as it may', async () => {
    for (let index = 0; index < POLICY_LIMITS.approvalsPerSessionMax; index += 1) {
      await approvals().request(String(index).padStart(64, '0'), EFFECT);
    }

    expect(await codeOf(approvals().request(OTHER_HASH, EFFECT))).toBe('APPROVAL_LIMIT_REACHED');
  });
});

describe('deciding, which is where the action hash earns its keep', () => {
  it('approves a card whose hash matches', async () => {
    const card = await approvals().request(HASH, EFFECT);
    const decided = await approvals().decide(card.approvalId, HASH, true);

    expect(decided.status).toBe('approved');
  });

  it('refuses a decision about an action that was altered afterwards', async () => {
    const card = await approvals().request(HASH, EFFECT);

    expect(await codeOf(approvals().decide(card.approvalId, OTHER_HASH, true))).toBe(
      'APPROVAL_MISMATCH',
    );
  });

  it('refuses a card that has expired', async () => {
    const card = await approvals().request(HASH, EFFECT);
    const later = (): number => Date.now() + POLICY_LIMITS.approvalTtlMs + 1_000;

    expect(await codeOf(approvals(later).decide(card.approvalId, HASH, true))).toBe(
      'APPROVAL_EXPIRED',
    );
  });

  it('refuses a card nobody ever made', async () => {
    expect(await codeOf(approvals().decide('apr_zzzzzzzzzzzzzzzzzzzzz', HASH, true))).toBe(
      'APPROVAL_NOT_FOUND',
    );
  });

  it('refuses to decide the same card twice', async () => {
    const card = await approvals().request(HASH, EFFECT);
    await approvals().decide(card.approvalId, HASH, true);

    expect(await codeOf(approvals().decide(card.approvalId, HASH, false))).toBe(
      'APPROVAL_ALREADY_USED',
    );
  });

  it('lets a person say no, and that card is never usable', async () => {
    const card = await approvals().request(HASH, EFFECT);
    await approvals().decide(card.approvalId, HASH, false);

    expect(await approvals().findUsable(HASH)).toBeNull();
  });
});

describe('a person who said no, and a worker that has never heard of them', () => {
  it('finds the refusal from a store that did not make it', async () => {
    const card = await approvals().request(HASH, EFFECT);
    await approvals().decide(card.approvalId, HASH, false);

    const refused = await approvals().findRefused(HASH);

    expect(refused?.approvalId).toBe(card.approvalId);
    expect(refused?.status).toBe('rejected');
  });

  it('finds no refusal for an action nobody was asked about', async () => {
    const card = await approvals().request(HASH, EFFECT);
    await approvals().decide(card.approvalId, HASH, false);

    expect(await approvals().findRefused(OTHER_HASH)).toBeNull();
  });

  it('finds no refusal while the card is still pending', async () => {
    await approvals().request(HASH, EFFECT);

    expect(await approvals().findRefused(HASH)).toBeNull();
  });

  it('finds no refusal when the person said yes', async () => {
    const card = await approvals().request(HASH, EFFECT);
    await approvals().decide(card.approvalId, HASH, true);

    expect(await approvals().findRefused(HASH)).toBeNull();
  });

  it('stops a worker that never saw the refusal from asking again', async () => {
    const asking = new PolicyGate({ approvals: approvals(), logger: capturingLogger().logger });
    const card = await asking.requestApproval(PROTECTED_ACTION);

    expect((await asking.authorize(PROTECTED_ACTION)).decision).toBe('approval_required');

    await approvals().decide(card.approvalId, card.actionHash, false);

    const later = new PolicyGate({ approvals: approvals(), logger: capturingLogger().logger });
    const decided = await later.authorize(PROTECTED_ACTION);

    expect(decided.decision).toBe('denied');
    expect(decided.reason).toBe(REFUSED_BY_PERSON);
  });

  it('makes no second card for an action a person already refused', async () => {
    const gate = new PolicyGate({ approvals: approvals(), logger: capturingLogger().logger });
    const card = await gate.requestApproval(PROTECTED_ACTION);
    await approvals().decide(card.approvalId, card.actionHash, false);

    await gate.authorize(PROTECTED_ACTION);
    await gate.authorize(PROTECTED_ACTION);

    expect(await approvals().list()).toHaveLength(1);
  });
});

describe('using an approval', () => {
  it('is found by the action it was granted for', async () => {
    const card = await approvals().request(HASH, EFFECT);
    await approvals().decide(card.approvalId, HASH, true);

    expect((await approvals().findUsable(HASH))?.approvalId).toBe(card.approvalId);
  });

  it('is never found for a different action', async () => {
    const card = await approvals().request(HASH, EFFECT);
    await approvals().decide(card.approvalId, HASH, true);

    expect(await approvals().findUsable(OTHER_HASH)).toBeNull();
  });

  it('can be used exactly once', async () => {
    const card = await approvals().request(HASH, EFFECT);
    await approvals().decide(card.approvalId, HASH, true);
    await approvals().consume(card.approvalId);

    expect(await codeOf(approvals().consume(card.approvalId))).toBe('APPROVAL_ALREADY_USED');
    expect(await approvals().findUsable(HASH)).toBeNull();
  });

  it('is used once even when two workers try together', async () => {
    const card = await approvals().request(HASH, EFFECT);
    await approvals().decide(card.approvalId, HASH, true);

    const outcomes = await Promise.all([
      codeOf(approvals().consume(card.approvalId)),
      codeOf(approvals().consume(card.approvalId)),
    ]);

    expect(outcomes.filter((one) => one === 'NO_ERROR')).toHaveLength(1);
  });
});

describe('surviving a restart', () => {
  it('honours an approval granted by something that no longer exists', async () => {
    const granting = approvals();
    const card = await granting.request(HASH, EFFECT);
    await granting.decide(card.approvalId, HASH, true);

    const laterWorker = new MongoApprovals({ db: testDatabase.db, sessionId });
    const found = await laterWorker.findUsable(HASH);

    expect(found?.approvalId).toBe(card.approvalId);

    await laterWorker.consume(card.approvalId);
    expect(await laterWorker.findUsable(HASH)).toBeNull();
  });

  it('keeps a pending card pending across workers', async () => {
    await approvals().request(HASH, EFFECT);

    const listed = await new MongoApprovals({ db: testDatabase.db, sessionId }).list();

    expect(listed).toHaveLength(1);
    expect(listed[0]?.status).toBe('pending');
  });

  it('reports a card as expired once its time has passed, without rewriting it', async () => {
    await approvals().request(HASH, EFFECT);
    const later = (): number => Date.now() + POLICY_LIMITS.approvalTtlMs + 1_000;

    expect((await approvals(later).list())[0]?.status).toBe('expired');

    const stored = await sessionsCollection(testDatabase.db).findOne({ sessionId });
    expect(stored?.approvals[0]?.status).toBe('pending');
  });
});
