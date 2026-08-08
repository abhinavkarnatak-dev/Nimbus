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
  SESSION_STATUSES,
  SessionDetailSchema,
  SessionListResponseSchema,
  SessionStatusSchema,
  SessionSummarySchema,
  TERMINAL_SESSION_STATUSES,
} from './sessions.js';

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

  it('rejects a task that is too short to scope', () => {
    expect(CreateSessionBodySchema.safeParse({ ...valid(), task: 'fix it' }).success).toBe(false);
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
