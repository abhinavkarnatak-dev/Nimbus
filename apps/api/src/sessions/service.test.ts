import { describe, expect, it } from 'vitest';

import { ApprovalDecisionBodySchema, type ApprovalDecisionBody } from '@nimbus/contracts';

import { InMemoryApprovals } from '../agent/policy/approvals.js';
import { DEFAULT_LIMITS } from '../config/limits.js';
import { ApiError } from '../http/api-error.js';
import { KNOWN_MODELS } from '../llm/models.js';
import { SELECTABLE_TEXT_MODELS } from '../routing/selection.js';
import { DEFAULT_MAX_STEPS } from './service.js';
import {
  CLEAR_TASK,
  HIDDEN,
  OTHER_ID,
  OWNER_ID,
  SHOPFRONT,
  attachment,
  newBody,
  sessionHarness,
  testId,
} from './sessions.fixtures.js';

async function codeOf(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (error) {
    return error instanceof ApiError ? error.code : 'NOT_AN_API_ERROR';
  }
  return 'NO_ERROR';
}

describe('creating a session', () => {
  it('starts one that is queued and belongs to the person who asked', async () => {
    const harness = sessionHarness();
    const created = await harness.service.create(OWNER_ID, newBody());

    expect(created.created).toBe(true);
    expect(created.session.status).toBe('queued');
    expect(created.session.task).toBe(CLEAR_TASK);
    expect(harness.records.documents[0]?.userId).toBe(OWNER_ID);
  });

  it('writes the repository into the session rather than only its number', async () => {
    const harness = sessionHarness();
    const created = await harness.service.create(OWNER_ID, newBody());

    expect(created.session.repository.owner).toBe(SHOPFRONT.owner);
    expect(created.session.repository.defaultBranch).toBe(SHOPFRONT.defaultBranch);
  });

  it('starts nothing until the work begins, so there is no branch or commit yet', async () => {
    const harness = sessionHarness();
    await harness.service.create(OWNER_ID, newBody());

    const stored = harness.records.documents[0];

    expect(stored?.branch).toBeNull();
    expect(stored?.baseCommitSha).toBeNull();
    expect(stored?.sandboxId).toBeNull();
    expect(stored?.step).toBe(0);
  });
});

describe('a repository the user cannot reach', () => {
  it('is refused', async () => {
    const harness = sessionHarness();

    expect(
      await codeOf(
        harness.service.create(OWNER_ID, newBody({ repositoryId: HIDDEN.repositoryId })),
      ),
    ).toBe('REPOSITORY_NOT_AVAILABLE');
  });

  it('is refused in the same words as one that does not exist', async () => {
    const harness = sessionHarness();

    const missing = await codeOf(harness.service.create(OWNER_ID, newBody({ repositoryId: 1 })));
    const hidden = await codeOf(
      harness.service.create(OWNER_ID, newBody({ repositoryId: HIDDEN.repositoryId })),
    );

    expect(missing).toBe(hidden);
  });

  it('is checked against what the installation can see, for this user', async () => {
    const harness = sessionHarness();
    await harness.service.create(OWNER_ID, newBody());

    expect(harness.directory.calls).toEqual([OWNER_ID]);
  });

  it('writes nothing when it refuses', async () => {
    const harness = sessionHarness();
    await codeOf(harness.service.create(OWNER_ID, newBody({ repositoryId: 1 })));

    expect(harness.records.documents).toHaveLength(0);
  });
});

describe('a task nobody could act on', () => {
  it('is refused without a model call or a session row', async () => {
    const harness = sessionHarness();

    expect(await codeOf(harness.service.create(OWNER_ID, newBody({ task: 'fix it please' })))).toBe(
      'TASK_TOO_BROAD',
    );
    expect(harness.records.documents).toHaveLength(0);
  });

  it('is refused when it is only filler words', async () => {
    const harness = sessionHarness();

    expect(
      await codeOf(
        harness.service.create(OWNER_ID, newBody({ task: 'please make the code a bit nicer' })),
      ),
    ).toBe('TASK_TOO_BROAD');
  });

  it('accepts one that names something specific', async () => {
    const harness = sessionHarness();

    expect((await harness.service.create(OWNER_ID, newBody())).created).toBe(true);
  });
});

describe('the same request arriving twice', () => {
  it('gives back the session that already exists', async () => {
    const harness = sessionHarness();
    const first = await harness.service.create(OWNER_ID, newBody());
    const second = await harness.service.create(OWNER_ID, newBody());

    expect(second.created).toBe(false);
    expect(second.session.sessionId).toBe(first.session.sessionId);
  });

  it('writes only one row', async () => {
    const harness = sessionHarness();
    await harness.service.create(OWNER_ID, newBody());
    await harness.service.create(OWNER_ID, newBody());

    expect(harness.records.documents).toHaveLength(1);
  });

  it('is told apart from a different request by the same person', async () => {
    const harness = sessionHarness();
    await harness.service.create(OWNER_ID, newBody());

    const other = await codeOf(
      harness.service.create(OWNER_ID, newBody({ idempotencyKey: testId('idk', 'c') })),
    );

    expect(other).toBe('ACTIVE_SESSION_EXISTS');
  });
});

describe('one session at a time', () => {
  it('refuses a second one and names the one already running', async () => {
    const harness = sessionHarness();
    const first = await harness.service.create(OWNER_ID, newBody());

    try {
      await harness.service.create(OWNER_ID, newBody({ idempotencyKey: testId('idk', 'd') }));
      expect.unreachable('a second session should not start');
    } catch (error) {
      const failure = error as ApiError;

      expect(failure.code).toBe('ACTIVE_SESSION_EXISTS');
      expect(failure.details?.['activeSessionId']).toBe(first.session.sessionId);
    }
  });

  it('lets another one start once the first has finished', async () => {
    const harness = sessionHarness();
    const first = await harness.service.create(OWNER_ID, newBody());

    await harness.service.cancel(OWNER_ID, first.session.sessionId);

    const second = await harness.service.create(
      OWNER_ID,
      newBody({ idempotencyKey: testId('idk', 'e') }),
    );

    expect(second.created).toBe(true);
  });

  it('counts one session per person, not one for everybody', async () => {
    const harness = sessionHarness();
    await harness.service.create(OWNER_ID, newBody());

    const other = await harness.service.create(OTHER_ID, newBody());

    expect(other.created).toBe(true);
  });
});

describe('attachments', () => {
  it('are copied into the session and marked as taken', async () => {
    const harness = sessionHarness();
    const one = attachment();
    await harness.attachments.insert(one);

    const created = await harness.service.create(
      OWNER_ID,
      newBody({ attachmentIds: [one.attachmentId] }),
    );

    expect(harness.records.documents[0]?.attachments).toHaveLength(1);
    expect(harness.attachments.documents[0]?.sessionId).toBe(created.session.sessionId);
  });

  it('are refused when they belong to somebody else', async () => {
    const harness = sessionHarness();
    const theirs = attachment({ userId: OTHER_ID });
    await harness.attachments.insert(theirs);

    expect(
      await codeOf(
        harness.service.create(OWNER_ID, newBody({ attachmentIds: [theirs.attachmentId] })),
      ),
    ).toBe('ATTACHMENT_REJECTED');
  });

  it('are refused when another session already has them', async () => {
    const harness = sessionHarness();
    const taken = attachment({ sessionId: testId('ses', 'f') });
    await harness.attachments.insert(taken);

    expect(
      await codeOf(
        harness.service.create(OWNER_ID, newBody({ attachmentIds: [taken.attachmentId] })),
      ),
    ).toBe('ATTACHMENT_REJECTED');
  });

  it('stop expiring once a session holds them', async () => {
    const harness = sessionHarness();
    const one = attachment();
    await harness.attachments.insert(one);

    await harness.service.create(OWNER_ID, newBody({ attachmentIds: [one.attachmentId] }));

    expect(harness.attachments.documents[0]?.expiresAt).toBeNull();
  });
});

describe('reading sessions back', () => {
  it('lists the newest first and names the active one', async () => {
    const harness = sessionHarness();
    const created = await harness.service.create(OWNER_ID, newBody());

    const listed = await harness.service.list(OWNER_ID);

    expect(listed.sessions).toHaveLength(1);
    expect(listed.activeSessionId).toBe(created.session.sessionId);
  });

  it('names no active session once everything has finished', async () => {
    const harness = sessionHarness();
    const created = await harness.service.create(OWNER_ID, newBody());
    await harness.service.cancel(OWNER_ID, created.session.sessionId);

    expect((await harness.service.list(OWNER_ID)).activeSessionId).toBeNull();
  });

  it('keeps finished sessions in the history', async () => {
    const harness = sessionHarness();
    const created = await harness.service.create(OWNER_ID, newBody());
    await harness.service.cancel(OWNER_ID, created.session.sessionId);

    expect((await harness.service.list(OWNER_ID)).sessions).toHaveLength(1);
  });

  it('shows nobody else their sessions', async () => {
    const harness = sessionHarness();
    await harness.service.create(OWNER_ID, newBody());

    expect((await harness.service.list(OTHER_ID)).sessions).toHaveLength(0);
  });

  it('gives the detail with the sequence a stream can replay from', async () => {
    const harness = sessionHarness();
    const created = await harness.service.create(OWNER_ID, newBody());

    const detail = await harness.service.detail(OWNER_ID, created.session.sessionId);

    expect(detail.session.sessionId).toBe(created.session.sessionId);
    expect(detail.lastEventSequence).toBe(0);
    expect(detail.session.progress.step).toBe(0);
  });
});

describe('somebody else asking', () => {
  it('cannot read a session that is not theirs, and is told it does not exist', async () => {
    const harness = sessionHarness();
    const created = await harness.service.create(OWNER_ID, newBody());

    expect(await codeOf(harness.service.detail(OTHER_ID, created.session.sessionId))).toBe(
      'NOT_FOUND',
    );
  });

  it('cannot cancel a session that is not theirs', async () => {
    const harness = sessionHarness();
    const created = await harness.service.create(OWNER_ID, newBody());

    expect(await codeOf(harness.service.cancel(OTHER_ID, created.session.sessionId))).toBe(
      'NOT_FOUND',
    );
  });

  it('leaves that session exactly as it was', async () => {
    const harness = sessionHarness();
    const created = await harness.service.create(OWNER_ID, newBody());
    await codeOf(harness.service.cancel(OTHER_ID, created.session.sessionId));

    expect(harness.records.documents[0]?.status).toBe('queued');
    expect(harness.records.documents[0]?.completedAt).toBeNull();
  });

  it('is refused the same way for a session id nobody has', async () => {
    const harness = sessionHarness();

    expect(await codeOf(harness.service.detail(OWNER_ID, testId('ses', 'z')))).toBe('NOT_FOUND');
  });
});

describe('answering a question', () => {
  async function asked(): Promise<{ harness: ReturnType<typeof sessionHarness>; id: string }> {
    const harness = sessionHarness();
    const created = await harness.service.create(OWNER_ID, newBody());

    await harness.records.askQuestion(
      created.session.sessionId,
      'Which page should people land on?',
      new Date(),
    );

    return { harness, id: created.session.sessionId };
  }

  it('is written onto the session, so the next run can read it', async () => {
    const { harness, id } = await asked();
    await harness.service.answer(OWNER_ID, id, 'the dashboard');

    expect(harness.records.documents[0]?.clarificationAnswer).toBe('the dashboard');
  });

  it('is refused a second time, and the first answer stands', async () => {
    const { harness, id } = await asked();
    await harness.service.answer(OWNER_ID, id, 'the dashboard');

    expect(await codeOf(harness.service.answer(OWNER_ID, id, 'somewhere else'))).toBe('CONFLICT');
    expect(harness.records.documents[0]?.clarificationAnswer).toBe('the dashboard');
  });

  it('is refused when nothing was ever asked', async () => {
    const harness = sessionHarness();
    const created = await harness.service.create(OWNER_ID, newBody());

    expect(await codeOf(harness.service.answer(OWNER_ID, created.session.sessionId, 'hi'))).toBe(
      'SESSION_NOT_ACTIVE',
    );
  });

  it('is refused for somebody else, and told it does not exist', async () => {
    const { harness, id } = await asked();

    expect(await codeOf(harness.service.answer(OTHER_ID, id, 'mine now'))).toBe('NOT_FOUND');
    expect(harness.records.documents[0]?.clarificationAnswer).toBeNull();
  });

  it('is refused once the session has ended', async () => {
    const { harness, id } = await asked();
    await harness.service.cancel(OWNER_ID, id);

    expect(await codeOf(harness.service.answer(OWNER_ID, id, 'too late'))).toBe('CONFLICT');
  });
});

describe('sending a message', () => {
  it('is kept on the session', async () => {
    const harness = sessionHarness();
    const created = await harness.service.create(OWNER_ID, newBody());

    await harness.service.say(OWNER_ID, created.session.sessionId, 'try the other file');

    expect(harness.records.documents[0]?.messages).toHaveLength(1);
    expect(harness.records.documents[0]?.messages[0]?.text).toBe('try the other file');
  });

  it('is refused once the session has ended', async () => {
    const harness = sessionHarness();
    const created = await harness.service.create(OWNER_ID, newBody());
    await harness.service.cancel(OWNER_ID, created.session.sessionId);

    expect(await codeOf(harness.service.say(OWNER_ID, created.session.sessionId, 'hello'))).toBe(
      'SESSION_NOT_ACTIVE',
    );
  });

  it('is refused for somebody else', async () => {
    const harness = sessionHarness();
    const created = await harness.service.create(OWNER_ID, newBody());

    expect(await codeOf(harness.service.say(OTHER_ID, created.session.sessionId, 'hello'))).toBe(
      'NOT_FOUND',
    );
  });
});

describe('deciding an approval', () => {
  const EFFECT = {
    category: 'protected_path_change' as const,
    summary: 'apply_patch: that path is protected',
    paths: ['src/auth/session.ts'],
    reason: 'that path is protected',
    risk: 'high' as const,
  };

  const HASH = 'a'.repeat(64);

  function decision(
    approvalId: string,
    actionHash: string,
    choice: 'approved' | 'rejected' = 'approved',
  ): ApprovalDecisionBody {
    return ApprovalDecisionBodySchema.parse({ approvalId, actionHash, decision: choice });
  }

  async function waiting(): Promise<{
    harness: ReturnType<typeof sessionHarness>;
    id: string;
    approvalId: string;
  }> {
    const approvals = new InMemoryApprovals();
    const harness = sessionHarness({ approvals: () => approvals });
    const created = await harness.service.create(OWNER_ID, newBody());
    const card = await approvals.request(HASH, EFFECT);

    return { harness, id: created.session.sessionId, approvalId: card.approvalId };
  }

  it('approves a card whose hash matches', async () => {
    const held = await waiting();
    const decided = await held.harness.service.decide(
      OWNER_ID,
      held.id,
      decision(held.approvalId, HASH),
    );

    expect(decided.status).toBe('approved');
  });

  it('refuses one whose action was altered', async () => {
    const held = await waiting();

    expect(
      await codeOf(
        held.harness.service.decide(OWNER_ID, held.id, decision(held.approvalId, 'b'.repeat(64))),
      ),
    ).toBe('APPROVAL_MISMATCH');
  });

  it('refuses one nobody asked for', async () => {
    const held = await waiting();

    expect(
      await codeOf(
        held.harness.service.decide(OWNER_ID, held.id, decision('apr_zzzzzzzzzzzzzzzzzzzzz', HASH)),
      ),
    ).toBe('APPROVAL_NOT_FOUND');
  });

  it('refuses somebody else deciding it', async () => {
    const held = await waiting();

    expect(
      await codeOf(held.harness.service.decide(OTHER_ID, held.id, decision(held.approvalId, HASH))),
    ).toBe('NOT_FOUND');
  });

  it('refuses once the session has ended', async () => {
    const held = await waiting();
    await held.harness.service.cancel(OWNER_ID, held.id);

    expect(
      await codeOf(held.harness.service.decide(OWNER_ID, held.id, decision(held.approvalId, HASH))),
    ).toBe('SESSION_NOT_ACTIVE');
  });
});

describe('cancelling', () => {
  it('moves the session to cancelled and stamps when it ended', async () => {
    const harness = sessionHarness();
    const created = await harness.service.create(OWNER_ID, newBody());

    const cancelled = await harness.service.cancel(OWNER_ID, created.session.sessionId);

    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.completedAt).not.toBeNull();
  });

  it('refuses to cancel something that has already ended', async () => {
    const harness = sessionHarness();
    const created = await harness.service.create(OWNER_ID, newBody());
    await harness.service.cancel(OWNER_ID, created.session.sessionId);

    expect(await codeOf(harness.service.cancel(OWNER_ID, created.session.sessionId))).toBe(
      'SESSION_NOT_ACTIVE',
    );
  });

  it('leaves a terminal session exactly as it was', async () => {
    const harness = sessionHarness();
    const created = await harness.service.create(OWNER_ID, newBody());
    const first = await harness.service.cancel(OWNER_ID, created.session.sessionId);

    await codeOf(harness.service.cancel(OWNER_ID, created.session.sessionId));

    expect(harness.records.documents[0]?.completedAt?.toISOString()).toBe(first.completedAt);
  });

  it('clears whatever it was doing, so nothing reads as still running', async () => {
    const harness = sessionHarness();
    const created = await harness.service.create(OWNER_ID, newBody());
    await harness.service.cancel(OWNER_ID, created.session.sessionId);

    expect(harness.records.documents[0]?.currentActivity).toBeNull();
  });
});

describe('the step budget written onto a session', () => {
  it('uses the shipped default when nothing is configured', async () => {
    const harness = sessionHarness();
    await harness.service.create(OWNER_ID, newBody());

    expect(harness.records.documents[0]?.maxSteps).toBe(DEFAULT_MAX_STEPS);
    expect(DEFAULT_MAX_STEPS).toBe(DEFAULT_LIMITS.maxAgentSteps);
  });

  it('uses the configured value rather than a number of its own', async () => {
    const harness = sessionHarness({ maxSteps: 7 });
    await harness.service.create(OWNER_ID, newBody());

    expect(harness.records.documents[0]?.maxSteps).toBe(7);
  });
});

describe('choosing a model', () => {
  it('stores nothing when nobody chose', async () => {
    const harness = sessionHarness();
    await harness.service.create(OWNER_ID, newBody());

    expect(harness.records.documents[0]?.model).toBeNull();
  });

  for (const model of SELECTABLE_TEXT_MODELS) {
    it(`stores ${model} when it was chosen`, async () => {
      const harness = sessionHarness();
      await harness.service.create(OWNER_ID, newBody({ model: { textModel: model } }));

      expect(harness.records.documents[0]?.model).toEqual({ textModel: model });
    });
  }

  it('refuses a model nobody has heard of, before a session exists', async () => {
    const harness = sessionHarness();
    const code = await codeOf(
      harness.service.create(OWNER_ID, newBody({ model: { textModel: 'made-up-model' } })),
    );

    expect(code).toBe('VALIDATION_FAILED');
    expect(harness.records.documents).toHaveLength(0);
  });

  it('refuses a model that exists but may not be chosen for a session', async () => {
    const known = KNOWN_MODELS.find((one) => !SELECTABLE_TEXT_MODELS.includes(one.id));

    if (known === undefined) {
      expect(SELECTABLE_TEXT_MODELS.length).toBe(KNOWN_MODELS.length);
      return;
    }

    const harness = sessionHarness();
    const code = await codeOf(
      harness.service.create(OWNER_ID, newBody({ model: { textModel: known.id } })),
    );

    expect(code).toBe('VALIDATION_FAILED');
    expect(harness.records.documents).toHaveLength(0);
  });

  it('never substitutes a different model for the one that was refused', async () => {
    const harness = sessionHarness();
    await codeOf(
      harness.service.create(OWNER_ID, newBody({ model: { textModel: 'made-up-model' } })),
    );

    expect(harness.records.documents).toHaveLength(0);
  });

  it('reads the chosen model back in session detail', async () => {
    const harness = sessionHarness();
    const created = await harness.service.create(
      OWNER_ID,
      newBody({ model: { textModel: 'openai/gpt-oss-120b' } }),
    );

    const detail = await harness.service.detail(OWNER_ID, created.session.sessionId);

    expect(detail.session.model).toEqual({ textModel: 'openai/gpt-oss-120b' });
  });

  it('reads null back for a session nobody chose a model for', async () => {
    const harness = sessionHarness();
    const created = await harness.service.create(OWNER_ID, newBody());
    const detail = await harness.service.detail(OWNER_ID, created.session.sessionId);

    expect(detail.session.model).toBeNull();
  });

  it('cannot have its model changed by a retry of the same request', async () => {
    const harness = sessionHarness();
    const key = testId('idk', 'r');

    const first = await harness.service.create(
      OWNER_ID,
      newBody({ idempotencyKey: key, model: { textModel: 'openai/gpt-oss-120b' } }),
    );
    const again = await harness.service.create(
      OWNER_ID,
      newBody({ idempotencyKey: key, model: { textModel: 'gemini-3.5-flash-lite' } }),
    );

    expect(again.created).toBe(false);
    expect(again.session.sessionId).toBe(first.session.sessionId);
    expect(harness.records.documents).toHaveLength(1);
    expect(harness.records.documents[0]?.model).toEqual({ textModel: 'openai/gpt-oss-120b' });
  });
});
