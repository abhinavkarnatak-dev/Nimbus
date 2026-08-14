import { describe, expect, it } from 'vitest';

import { RETRIEVAL_LIMITS } from './limits.js';
import { parseQuery, singular } from './query.js';

describe('singular', () => {
  it.each([
    ['a plain plural', 'invoices', 'invoice'],
    ['a y plural', 'categories', 'category'],
    ['an es plural', 'boxes', 'box'],
    ['a ches plural', 'branches', 'branch'],
    ['a verb ending in s', 'sends', 'send'],
  ])('reduces %s', (_label, term, expected) => {
    expect(singular(term)).toBe(expected);
  });

  it.each([
    ['a double s word', 'class'],
    ['a us word', 'status'],
    ['an is word', 'analysis'],
    ['an as word', 'alias'],
    ['a short word', 'cts'],
    ['a word that is already singular', 'invoice'],
  ])('leaves %s alone', (_label, term) => {
    expect(singular(term)).toBeNull();
  });
});

describe('parseQuery', () => {
  it('drops stop words', () => {
    const parsed = parseQuery('the login redirect sends people to the wrong page');
    expect(parsed.terms).not.toContain('the');
    expect(parsed.terms).not.toContain('to');
    expect(parsed.terms).toContain('login');
    expect(parsed.terms).toContain('redirect');
  });

  it('keeps the compound and the parts of an identifier', () => {
    const parsed = parseQuery('fix redirectAfterLogin please');
    expect(parsed.terms).toContain('redirectafterlogin');
    expect(parsed.terms).toContain('redirect');
    expect(parsed.terms).toContain('login');
  });

  it('drops a stop word even when it came out of an identifier', () => {
    expect(parseQuery('fix redirectAfterLogin please').terms).not.toContain('after');
  });

  it('splits snake case and kebab case', () => {
    expect(parseQuery('check api_key handling').terms).toContain('api');
    expect(parseQuery('check service-account handling').terms).toContain('account');
  });

  it('adds the singular of a plural term', () => {
    const parsed = parseQuery('total the invoices');
    expect(parsed.terms).toContain('invoices');
    expect(parsed.terms).toContain('invoice');
  });

  it('never repeats a term', () => {
    const parsed = parseQuery('login login LOGIN Login');
    expect(parsed.terms.filter((term) => term === 'login')).toHaveLength(1);
  });

  it('caps how many terms it will use', () => {
    const many = Array.from({ length: 200 }, (_value, index) => `word${String(index)}`).join(' ');
    expect(parseQuery(many).terms.length).toBeLessThanOrEqual(RETRIEVAL_LIMITS.termsMax);
  });

  it('caps how much of the task it reads', () => {
    const long = `${'a'.repeat(RETRIEVAL_LIMITS.taskMaxChars + 500)} login`;
    expect(parseQuery(long).task.length).toBeLessThanOrEqual(RETRIEVAL_LIMITS.taskMaxChars);
  });

  it('keeps a short task as a phrase', () => {
    expect(parseQuery('  fix the   login  redirect ').phrase).toBe('fix the login redirect');
  });

  it('does not keep a long task as a phrase', () => {
    const long = 'a'.repeat(RETRIEVAL_LIMITS.phraseMaxChars + 1);
    expect(parseQuery(long).phrase).toBeNull();
  });

  it('notices when the task is about tests', () => {
    expect(parseQuery('add a test for login').wantsTests).toBe(true);
    expect(parseQuery('fix the login redirect').wantsTests).toBe(false);
  });

  it('returns nothing usable for an empty task', () => {
    const parsed = parseQuery('');
    expect(parsed.terms).toEqual([]);
    expect(parsed.phrase).toBeNull();
  });

  it('returns nothing usable for a task made only of stop words', () => {
    expect(parseQuery('the and of to').terms).toEqual([]);
  });

  it('ignores punctuation', () => {
    expect(parseQuery('login(), redirect; session!').terms).toContain('session');
  });
});
