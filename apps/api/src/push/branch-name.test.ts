import { BranchNameSchema } from '@nimbus/contracts';
import { describe, expect, it } from 'vitest';

import {
  BRANCH_PREFIX,
  FALLBACK_SLUG,
  SESSION_CHARS,
  SLUG_MAX_CHARS,
  branchNameFor,
  shortSessionId,
  slugOf,
} from './branch-name.js';

const SESSION_ID = 'ses_V1StGXR8Z5jdHi6BmyTab';

describe('slugOf', () => {
  it('turns a sentence into something safe for a branch', () => {
    expect(slugOf('Fix the broken login redirect')).toBe('fix-the-broken-login-redirect');
  });

  it('drops punctuation rather than escaping it', () => {
    expect(slugOf('Fix: the "login" bug (again)!')).toBe('fix-the-login-bug-again');
  });

  it('never starts or ends with a dash', () => {
    expect(slugOf('  ...hello...  ')).toBe('hello');
  });

  it('caps a long task', () => {
    expect(slugOf('word '.repeat(60)).length).toBeLessThanOrEqual(SLUG_MAX_CHARS);
  });

  it('does not end with a dash after being cut short', () => {
    expect(slugOf('a'.repeat(SLUG_MAX_CHARS - 1) + ' more words')).not.toMatch(/-$/);
  });

  it('falls back when nothing usable is left', () => {
    expect(slugOf('!!!')).toBe(FALLBACK_SLUG);
    expect(slugOf('')).toBe(FALLBACK_SLUG);
    expect(slugOf('हिन्दी')).toBe(FALLBACK_SLUG);
  });
});

describe('shortSessionId', () => {
  it('drops the prefix and shortens what is left', () => {
    expect(shortSessionId(SESSION_ID)).toBe('v1stgxr8');
    expect(shortSessionId(SESSION_ID)).toHaveLength(SESSION_CHARS);
  });

  it('copes with an id that has no prefix', () => {
    expect(shortSessionId('abcdefghijkl')).toBe('abcdefgh');
  });
});

describe('branchNameFor', () => {
  it('always sits under the nimbus prefix', () => {
    expect(branchNameFor(SESSION_ID, 'anything at all')).toMatch(new RegExp(`^${BRANCH_PREFIX}/`));
  });

  it('is the same every time for one session and task', () => {
    expect(branchNameFor(SESSION_ID, 'Fix the login')).toBe(
      branchNameFor(SESSION_ID, 'Fix the login'),
    );
  });

  it('differs between sessions', () => {
    expect(branchNameFor(SESSION_ID, 'Fix')).not.toBe(
      branchNameFor('ses_TabmyB6iHd5Z8RXGtS1Vx', 'Fix'),
    );
  });

  it('produces a name Git and our own contract both accept', () => {
    const names = [
      branchNameFor(SESSION_ID, 'Fix the broken login redirect'),
      branchNameFor(SESSION_ID, '!!!'),
      branchNameFor(SESSION_ID, 'word '.repeat(60)),
      branchNameFor(SESSION_ID, '../../etc/passwd'),
      branchNameFor(SESSION_ID, 'feature..lock'),
    ];

    for (const name of names) {
      expect(() => BranchNameSchema.parse(name)).not.toThrow();
      expect(name).not.toContain('..');
      expect(name).not.toContain(' ');
    }
  });
});
