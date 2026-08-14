import { describe, expect, it } from 'vitest';

import { parseQuery } from './query.js';
import {
  SATURATION,
  inverseDocumentFrequency,
  isTestPath,
  rankFiles,
  saturate,
  scoreFile,
} from './rank.js';
import type { ScannedFile } from './scan.js';

function scanned(
  path: string,
  hits: Record<string, number>,
  extra: Partial<ScannedFile> = {},
): ScannedFile {
  return {
    path,
    bytes: 500,
    lineCount: 40,
    hits: new Map(Object.entries(hits)),
    matchedLines: [1],
    phraseHits: 0,
    protectedPath: false,
    ...extra,
  };
}

function frequency(counts: Record<string, number>): Map<string, number> {
  return new Map(Object.entries(counts));
}

describe('inverseDocumentFrequency', () => {
  it('is worth nothing when a term is in every file', () => {
    expect(inverseDocumentFrequency(50, 50)).toBeLessThan(0.05);
  });

  it('is worth a lot when a term is in one file', () => {
    expect(inverseDocumentFrequency(50, 1)).toBeGreaterThan(3);
  });

  it('is never negative', () => {
    expect(inverseDocumentFrequency(2, 2)).toBeGreaterThanOrEqual(0);
    expect(inverseDocumentFrequency(1, 1)).toBeGreaterThanOrEqual(0);
  });

  it('still separates terms in a small repository', () => {
    expect(inverseDocumentFrequency(4, 1)).toBeGreaterThan(inverseDocumentFrequency(4, 4));
  });

  it('is nothing when no file was scanned', () => {
    expect(inverseDocumentFrequency(0, 0)).toBe(0);
  });
});

describe('saturate', () => {
  it('gives the first hit the most', () => {
    expect(saturate(1)).toBeCloseTo(1 / (1 + SATURATION));
  });

  it('never reaches one however many hits there are', () => {
    expect(saturate(1_000_000)).toBeLessThan(1);
  });

  it('grows less and less', () => {
    expect(saturate(2) - saturate(1)).toBeGreaterThan(saturate(9) - saturate(8));
  });

  it('is nothing when there are no hits', () => {
    expect(saturate(0)).toBe(0);
  });
});

describe('isTestPath', () => {
  it.each([
    ['a dot test file', 'src/a.test.ts'],
    ['a dot spec file', 'src/a.spec.ts'],
    ['a tests folder', 'tests/a.ts'],
    ['a nested test folder', 'src/__tests__/a.ts'],
  ])('recognises %s', (_label, path) => {
    expect(isTestPath(path)).toBe(true);
  });

  it.each([
    ['ordinary source', 'src/a.ts'],
    ['a file that merely mentions testing', 'src/latest.ts'],
    ['a file about protests', 'src/protest.ts'],
  ])('does not mistake %s for a test', (_label, path) => {
    expect(isTestPath(path)).toBe(false);
  });
});

describe('rankFiles', () => {
  it('puts breadth ahead of depth', () => {
    const query = parseQuery('login redirect session');
    const files = [
      scanned('src/shouty.ts', { login: 200 }),
      scanned('src/quiet.ts', { login: 1, redirect: 1, session: 1 }),
    ];

    const ranked = rankFiles(files, query, frequency({ login: 2, redirect: 1, session: 1 }), 2);
    expect(ranked[0]?.path).toBe('src/quiet.ts');
  });

  it('ignores a term that is in every file', () => {
    const query = parseQuery('export login');
    const files = [scanned('src/a.ts', { export: 500 }), scanned('src/b.ts', { login: 1 })];

    const ranked = rankFiles(files, query, frequency({ export: 2, login: 1 }), 2);
    expect(ranked[0]?.path).toBe('src/b.ts');
  });

  it('rewards a term that is the file name', () => {
    const query = parseQuery('redirect');
    const files = [
      scanned('src/redirect.ts', { redirect: 1 }),
      scanned('src/other.ts', { redirect: 4 }),
    ];

    const ranked = rankFiles(files, query, frequency({ redirect: 2 }), 8);
    expect(ranked[0]?.path).toBe('src/redirect.ts');
  });

  it('rewards a directory that carries the term, less than a file name does', () => {
    const query = parseQuery('auth');
    const files = [scanned('src/auth/thing.ts', {}), scanned('src/auth.ts', {})];

    const ranked = rankFiles(files, query, frequency({}), 8);
    expect(ranked[0]?.path).toBe('src/auth.ts');
    expect(ranked[1]?.path).toBe('src/auth/thing.ts');
  });

  it('keeps a file that only matches by name', () => {
    const ranked = rankFiles([scanned('src/login.ts', {})], parseQuery('login'), frequency({}), 8);
    expect(ranked).toHaveLength(1);
  });

  it('drops a file that matches nothing at all', () => {
    const ranked = rankFiles([scanned('src/a.ts', {})], parseQuery('login'), frequency({}), 8);
    expect(ranked).toEqual([]);
  });

  it('scores a test file down when the task is not about tests', () => {
    const query = parseQuery('fix the login');
    const files = [
      scanned('src/login.ts', { login: 3 }),
      scanned('src/login.test.ts', { login: 3 }),
    ];

    const ranked = rankFiles(files, query, frequency({ login: 2 }), 8);
    expect(ranked[0]?.path).toBe('src/login.ts');
  });

  it('does not score a test file down when the task is about tests', () => {
    const query = parseQuery('add a test for login');
    const plain = scoreFile(
      scanned('src/login.ts', { login: 3 }),
      query,
      frequency({ login: 2 }),
      8,
    );
    const test = scoreFile(
      scanned('src/login.test.ts', { login: 3 }),
      query,
      frequency({ login: 2 }),
      8,
    );

    expect(test).toBeGreaterThan(plain);
  });

  it('scores a very large file down', () => {
    const query = parseQuery('login');
    const small = scoreFile(scanned('src/a.ts', { login: 5 }), query, frequency({ login: 2 }), 8);
    const large = scoreFile(
      scanned('src/b.ts', { login: 5 }, { bytes: 500_000 }),
      query,
      frequency({ login: 2 }),
      8,
    );

    expect(large).toBeLessThan(small);
  });

  it('rewards the whole phrase appearing', () => {
    const query = parseQuery('login redirect');
    const files = [
      scanned('src/a.ts', { login: 1, redirect: 1 }),
      scanned('src/b.ts', { login: 1, redirect: 1 }, { phraseHits: 2 }),
    ];

    const ranked = rankFiles(files, query, frequency({ login: 2, redirect: 2 }), 8);
    expect(ranked[0]?.path).toBe('src/b.ts');
  });

  it('reports only the terms that matched in the content', () => {
    const query = parseQuery('login redirect session');
    const ranked = rankFiles(
      [scanned('src/a.ts', { login: 1, session: 2 })],
      query,
      frequency({ login: 1, session: 1 }),
      8,
    );

    expect(ranked[0]?.matchedTerms).toEqual(['login', 'session']);
    expect(ranked[0]?.hits).toBe(3);
  });

  it('breaks a tie on the path, so the same question gives the same answer', () => {
    const query = parseQuery('login');
    const files = [scanned('src/z.ts', { login: 2 }), scanned('src/a.ts', { login: 2 })];
    const ranked = rankFiles(files, query, frequency({ login: 2 }), 8);

    expect(ranked.map((file) => file.path)).toEqual(['src/a.ts', 'src/z.ts']);
  });

  it('returns nothing for a query with no usable terms', () => {
    const ranked = rankFiles(
      [scanned('src/login.ts', {})],
      parseQuery('the and of'),
      frequency({}),
      8,
    );
    expect(ranked).toEqual([]);
  });
});
