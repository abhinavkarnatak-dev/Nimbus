import { describe, expect, it } from 'vitest';

import { LIMITS } from './limits.js';
import {
  attachmentFixture,
  sessionDetailFixture,
  sessionSummaryFixture,
  VALID_IDEMPOTENCY_KEY,
  VALID_SESSION_ID,
} from './session.fixtures.js';
import {
  CreateSessionBodySchema,
  PostMessageBodySchema,
  PostMessageResponseSchema,
  SESSION_STATUSES,
  SessionDetailSchema,
  SessionListResponseSchema,
  SessionMessageSchema,
  SessionStatusSchema,
  SessionSummarySchema,
  TERMINAL_SESSION_STATUSES,
} from './sessions.js';

describe('session messages', () => {
  const message = SessionMessageSchema.parse(sessionDetailFixture().messages[0]);

  it('requires a stable server identity on every public message', () => {
    expect(SessionMessageSchema.parse(message)).toEqual(message);
    const { messageId: _messageId, ...withoutIdentity } = message;
    expect(SessionMessageSchema.safeParse(withoutIdentity).success).toBe(false);
  });

  it('requires a client idempotency key when a person submits one', () => {
    expect(
      PostMessageBodySchema.parse({
        message: 'keep the old link working',
        idempotencyKey: VALID_IDEMPOTENCY_KEY,
      }),
    ).toEqual({
      message: 'keep the old link working',
      idempotencyKey: VALID_IDEMPOTENCY_KEY,
    });
    expect(PostMessageBodySchema.safeParse({ message: 'keep the old link working' }).success).toBe(
      false,
    );
  });

  it('returns exactly the persisted message and no internal retry metadata', () => {
    expect(PostMessageResponseSchema.parse({ message })).toEqual({ message });
    expect(
      PostMessageResponseSchema.safeParse({ message, idempotencyKey: VALID_IDEMPOTENCY_KEY })
        .success,
    ).toBe(false);
  });
});

describe('session creation', () => {
  const valid = () => ({
    repositoryId: 42_919_301,
    task: 'Format the invoice dates using the existing date helper',
    idempotencyKey: VALID_IDEMPOTENCY_KEY,
  });

  it('accepts a task without attachments and defaults the attachment list', () => {
    expect(CreateSessionBodySchema.parse(valid()).attachmentIds).toEqual([]);
  });

  it('trims the task before applying length rules', () => {
    const parsed = CreateSessionBodySchema.parse({ ...valid(), task: `  ${valid().task}  ` });
    expect(parsed.task).toBe(valid().task);
  });

  it('accepts any non-empty task and rejects an empty one', () => {
    expect(CreateSessionBodySchema.safeParse({ ...valid(), task: 'fix it' }).success).toBe(true);
    expect(CreateSessionBodySchema.safeParse({ ...valid(), task: '   ' }).success).toBe(false);
  });

  it('rejects a task beyond the length limit', () => {
    expect(
      CreateSessionBodySchema.safeParse({ ...valid(), task: 'x'.repeat(LIMITS.taskMaxChars + 1) })
        .success,
    ).toBe(false);
  });

  it('rejects more attachments than a session allows', () => {
    const attachmentIds = Array.from(
      { length: LIMITS.maxAttachmentsPerSession + 1 },
      () => attachmentFixture().attachmentId,
    );
    expect(CreateSessionBodySchema.safeParse({ ...valid(), attachmentIds }).success).toBe(false);
  });

  it('requires an idempotency key, so a retried start cannot create a second session', () => {
    const { idempotencyKey: _key, ...withoutKey } = valid();
    expect(CreateSessionBodySchema.safeParse(withoutKey).success).toBe(false);
  });

  it('rejects a client supplied branch, status, or user id', () => {
    for (const extra of [
      { branch: 'main' },
      { status: 'pr_created' },
      { userId: 'usr_0123456789abcdefghijk' },
      { installationId: 1 },
    ]) {
      expect(CreateSessionBodySchema.safeParse({ ...valid(), ...extra }).success).toBe(false);
    }
  });
});

describe('session status', () => {
  it('accepts every declared status', () => {
    for (const status of SESSION_STATUSES) {
      expect(SessionStatusSchema.safeParse(status).success).toBe(true);
    }
  });

  it('rejects an undeclared status', () => {
    for (const status of ['merged', 'approved', 'running', 'done']) {
      expect(SessionStatusSchema.safeParse(status).success).toBe(false);
    }
  });

  it('declares terminal statuses that are all real statuses', () => {
    for (const status of TERMINAL_SESSION_STATUSES) {
      expect(SESSION_STATUSES).toContain(status);
    }
  });
});

describe('session summary and detail', () => {
  it('accepts the summary fixture', () => {
    expect(SessionSummarySchema.parse(sessionSummaryFixture())).toEqual(sessionSummaryFixture());
  });

  it('accepts the detail fixture', () => {
    expect(SessionDetailSchema.parse(sessionDetailFixture())).toEqual(sessionDetailFixture());
  });

  it('carries which model the session was started with, or an explicit null', () => {
    expect(SessionDetailSchema.parse(sessionDetailFixture()).model).toEqual({
      textModel: 'gemini-3.6-flash',
    });
    expect(SessionDetailSchema.safeParse({ ...sessionDetailFixture(), model: null }).success).toBe(
      true,
    );
  });

  it('will not accept a model field that was left out', () => {
    const { model: _model, ...withoutModel } = sessionDetailFixture();

    expect(SessionDetailSchema.safeParse(withoutModel).success).toBe(false);
  });

  it('keeps rejecting unknown keys after extend, which is where strictness usually leaks', () => {
    expect(
      SessionDetailSchema.safeParse({ ...sessionDetailFixture(), sandboxId: 'sbx_live_1' }).success,
    ).toBe(false);
  });

  it('never carries a sandbox id, token, or checkpoint blob to the browser', () => {
    for (const leak of [
      { installationToken: 'ghs_secret' },
      { checkpoint: { messages: [] } },
      { sandboxId: 'sbx_1' },
    ]) {
      expect(SessionSummarySchema.safeParse({ ...sessionSummaryFixture(), ...leak }).success).toBe(
        false,
      );
    }
  });

  it('requires explicit nulls rather than omitted optional fields', () => {
    const { pullRequest: _pr, ...withoutPullRequest } = sessionSummaryFixture();
    expect(SessionSummarySchema.safeParse(withoutPullRequest).success).toBe(false);
  });

  it('caps changed files and checks at the configured limits', () => {
    const filesChanged = Array.from({ length: LIMITS.maxChangedFiles + 1 }, (_, i) => ({
      path: `src/file${String(i)}.ts`,
      changeKind: 'added' as const,
      addedLines: 1,
      removedLines: 0,
      diff: '@@ -0,0 +1 @@\n+const one = 1;',
      diffTruncated: false,
    }));
    expect(SessionDetailSchema.safeParse({ ...sessionDetailFixture(), filesChanged }).success).toBe(
      false,
    );
  });
});

describe('session list response', () => {
  it('accepts an empty history with no active session', () => {
    expect(SessionListResponseSchema.parse({ sessions: [], activeSessionId: null })).toEqual({
      sessions: [],
      activeSessionId: null,
    });
  });

  it('accepts a history with one active session', () => {
    const payload = { sessions: [sessionSummaryFixture()], activeSessionId: VALID_SESSION_ID };
    expect(SessionListResponseSchema.parse(payload)).toEqual(payload);
  });

  it('rejects a page larger than the declared page size', () => {
    const sessions = Array.from({ length: LIMITS.sessionHistoryPageSize + 1 }, () =>
      sessionSummaryFixture(),
    );
    expect(SessionListResponseSchema.safeParse({ sessions, activeSessionId: null }).success).toBe(
      false,
    );
  });
});
