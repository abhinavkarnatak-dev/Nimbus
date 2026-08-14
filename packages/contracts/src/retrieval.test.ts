import { describe, expect, it } from 'vitest';

import {
  MAX_RETRIEVAL_FILES,
  MAX_RETRIEVAL_FLAGS,
  MAX_RETRIEVAL_TERMS,
  RETRIEVAL_FLAG_CODES,
  RetrievalFlagSchema,
  RetrievalStatsSchema,
  RetrievalSummarySchema,
} from './retrieval.js';

const stats = {
  filesSeen: 20,
  filesScanned: 13,
  skippedByPolicy: 7,
  skippedNotText: 0,
  skippedTooLarge: 0,
  skippedUnreadable: 0,
  bytesScanned: 2048,
  truncated: false,
};

const summary = {
  terms: ['login', 'redirect'],
  files: [
    {
      path: 'src/auth/redirect.ts',
      score: 6.2,
      matchedTerms: ['login', 'redirect'],
      hits: 3,
      lines: 9,
      protectedPath: false,
    },
  ],
  flags: [{ code: 'IGNORE_PREVIOUS', path: 'docs/notes.md', line: 3 }],
  stats,
  characters: 1996,
};

describe('RetrievalFlagSchema', () => {
  it('accepts every code', () => {
    for (const code of RETRIEVAL_FLAG_CODES) {
      expect(RetrievalFlagSchema.safeParse({ code, path: 'a.md', line: 1 }).success).toBe(true);
    }
  });

  it('refuses a code it does not know', () => {
    expect(
      RetrievalFlagSchema.safeParse({ code: 'SOMETHING_ELSE', path: 'a.md', line: 1 }).success,
    ).toBe(false);
  });

  it('refuses a line number that is not a line number', () => {
    expect(
      RetrievalFlagSchema.safeParse({ code: 'ROLE_SWITCH', path: 'a.md', line: 0 }).success,
    ).toBe(false);
  });

  it('refuses an extra field', () => {
    expect(
      RetrievalFlagSchema.safeParse({ code: 'ROLE_SWITCH', path: 'a.md', line: 1, text: 'oops' })
        .success,
    ).toBe(false);
  });
});

describe('RetrievalStatsSchema', () => {
  it('accepts a full count', () => {
    expect(RetrievalStatsSchema.safeParse(stats).success).toBe(true);
  });

  it('refuses a negative count', () => {
    expect(RetrievalStatsSchema.safeParse({ ...stats, filesScanned: -1 }).success).toBe(false);
  });

  it('refuses a missing count', () => {
    const { bytesScanned: _dropped, ...rest } = stats;
    expect(RetrievalStatsSchema.safeParse(rest).success).toBe(false);
  });
});

describe('RetrievalSummarySchema', () => {
  it('accepts a summary', () => {
    expect(RetrievalSummarySchema.safeParse(summary).success).toBe(true);
  });

  it('refuses more files than it allows', () => {
    const first = summary.files[0];
    const files = Array.from({ length: MAX_RETRIEVAL_FILES + 1 }, () => first);
    expect(RetrievalSummarySchema.safeParse({ ...summary, files }).success).toBe(false);
  });

  it('refuses more terms than it allows', () => {
    const terms = Array.from(
      { length: MAX_RETRIEVAL_TERMS + 1 },
      (_value, index) => `term${String(index)}`,
    );
    expect(RetrievalSummarySchema.safeParse({ ...summary, terms }).success).toBe(false);
  });

  it('refuses more flags than it allows', () => {
    const first = summary.flags[0];
    const flags = Array.from({ length: MAX_RETRIEVAL_FLAGS + 1 }, () => first);
    expect(RetrievalSummarySchema.safeParse({ ...summary, flags }).success).toBe(false);
  });

  it('refuses a negative score', () => {
    const files = [{ ...summary.files[0], score: -1 }];
    expect(RetrievalSummarySchema.safeParse({ ...summary, files }).success).toBe(false);
  });

  it('has no place to put the text that was flagged', () => {
    expect(Object.keys(RetrievalFlagSchema.shape).sort()).toEqual(['code', 'line', 'path']);
  });
});
