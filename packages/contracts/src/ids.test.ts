import { describe, expect, it } from 'vitest';

import {
  ActionHashSchema,
  AttachmentIdSchema,
  CommitShaSchema,
  IsoTimestampSchema,
  SessionIdSchema,
  UserIdSchema,
} from './ids.js';
import {
  VALID_ACTION_HASH,
  VALID_ATTACHMENT_ID,
  VALID_COMMIT_SHA,
  VALID_SESSION_ID,
  VALID_TIMESTAMP,
  VALID_USER_ID,
} from './session.fixtures.js';

describe('public identifiers', () => {
  it('accepts a well formed id', () => {
    expect(UserIdSchema.parse(VALID_USER_ID)).toBe(VALID_USER_ID);
    expect(SessionIdSchema.parse(VALID_SESSION_ID)).toBe(VALID_SESSION_ID);
    expect(AttachmentIdSchema.parse(VALID_ATTACHMENT_ID)).toBe(VALID_ATTACHMENT_ID);
  });

  it('rejects an id carrying another resource prefix', () => {
    expect(UserIdSchema.safeParse(VALID_SESSION_ID).success).toBe(false);
    expect(SessionIdSchema.safeParse(VALID_USER_ID).success).toBe(false);
  });

  it('rejects ids of the wrong length', () => {
    expect(UserIdSchema.safeParse('usr_tooshort').success).toBe(false);
    expect(UserIdSchema.safeParse(`${VALID_USER_ID}extra`).success).toBe(false);
  });

  it('rejects a missing prefix and an empty value', () => {
    expect(UserIdSchema.safeParse('0123456789abcdefghijk').success).toBe(false);
    expect(UserIdSchema.safeParse('').success).toBe(false);
  });

  it('rejects characters outside the identifier alphabet', () => {
    expect(UserIdSchema.safeParse('usr_0123456789abcdefghi$k').success).toBe(false);
    expect(UserIdSchema.safeParse('usr_0123456789abcdefghi.k').success).toBe(false);
  });

  it('rejects a non-string value', () => {
    expect(UserIdSchema.safeParse(12345).success).toBe(false);
    expect(UserIdSchema.safeParse(null).success).toBe(false);
    expect(UserIdSchema.safeParse({ toString: () => VALID_USER_ID }).success).toBe(false);
  });
});

describe('commit SHA', () => {
  it('accepts 40 lowercase hex characters', () => {
    expect(CommitShaSchema.parse(VALID_COMMIT_SHA)).toBe(VALID_COMMIT_SHA);
  });

  it('rejects uppercase, short, and abbreviated SHAs', () => {
    expect(CommitShaSchema.safeParse(VALID_COMMIT_SHA.toUpperCase()).success).toBe(false);
    expect(CommitShaSchema.safeParse('9f2c1a7').success).toBe(false);
    expect(CommitShaSchema.safeParse(`${VALID_COMMIT_SHA}0`).success).toBe(false);
  });
});

describe('action hash', () => {
  it('accepts 64 lowercase hex characters', () => {
    expect(ActionHashSchema.parse(VALID_ACTION_HASH)).toBe(VALID_ACTION_HASH);
  });

  it('rejects a hash of the wrong width', () => {
    expect(ActionHashSchema.safeParse('a'.repeat(63)).success).toBe(false);
    expect(ActionHashSchema.safeParse('a'.repeat(65)).success).toBe(false);
  });
});

describe('ISO timestamps', () => {
  it('accepts a UTC timestamp', () => {
    expect(IsoTimestampSchema.parse(VALID_TIMESTAMP)).toBe(VALID_TIMESTAMP);
  });

  it('rejects a timestamp carrying a numeric offset', () => {
    expect(IsoTimestampSchema.safeParse('2026-08-09T01:00:00.000+05:30').success).toBe(false);
  });

  it('rejects dates, epochs, and free text', () => {
    expect(IsoTimestampSchema.safeParse('2026-08-09').success).toBe(false);
    expect(IsoTimestampSchema.safeParse(1_775_000_000_000).success).toBe(false);
    expect(IsoTimestampSchema.safeParse('yesterday').success).toBe(false);
  });
});
