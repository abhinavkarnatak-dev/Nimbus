import { describe, expect, it } from 'vitest';

import { buildExcerpt, mergeSpans, redactWindowLines } from './excerpt.js';
import { RETRIEVAL_LIMITS } from './limits.js';

function numbered(count: number): string {
  return Array.from({ length: count }, (_value, index) => `line ${String(index + 1)}`).join('\n');
}

describe('mergeSpans', () => {
  it('puts context around a single line', () => {
    expect(mergeSpans([10], 100)).toEqual([{ start: 7, end: 13, matches: 1 }]);
  });

  it('does not run past the start or the end of the file', () => {
    expect(mergeSpans([1], 4)).toEqual([{ start: 1, end: 4, matches: 1 }]);
  });

  it('joins lines that are close together', () => {
    expect(mergeSpans([10, 12], 100)).toEqual([{ start: 7, end: 15, matches: 2 }]);
  });

  it('joins spans that only touch', () => {
    expect(mergeSpans([10, 17], 100)).toEqual([{ start: 7, end: 20, matches: 2 }]);
  });

  it('does not mind being given lines out of order', () => {
    expect(mergeSpans([60, 10], 100)).toEqual(mergeSpans([10, 60], 100));
  });

  it('keeps far apart lines separate', () => {
    expect(mergeSpans([10, 60], 100)).toEqual([
      { start: 7, end: 13, matches: 1 },
      { start: 57, end: 63, matches: 1 },
    ]);
  });
});

describe('buildExcerpt', () => {
  it('returns the head of the file when nothing matched in it', () => {
    const windows = buildExcerpt(numbered(200), []);
    expect(windows).toHaveLength(1);
    expect(windows[0]?.startLine).toBe(1);
    expect(windows[0]?.endLine).toBe(RETRIEVAL_LIMITS.excerptMaxLines);
  });

  it('returns the whole of a short file when nothing matched in it', () => {
    const windows = buildExcerpt('one\ntwo\nthree', []);
    expect(windows[0]).toEqual({ startLine: 1, endLine: 3, text: 'one\ntwo\nthree' });
  });

  it('returns windows in the order they appear in the file', () => {
    const windows = buildExcerpt(numbered(300), [200, 20, 100]);
    expect(windows.map((one) => one.startLine)).toEqual([17, 97, 197]);
  });

  it('never returns more windows than it is allowed', () => {
    const lines = Array.from({ length: 20 }, (_value, index) => (index + 1) * 40);
    const windows = buildExcerpt(numbered(1000), lines);
    expect(windows.length).toBeLessThanOrEqual(RETRIEVAL_LIMITS.excerptMaxWindows);
  });

  it('never returns more lines than it is allowed', () => {
    const lines = Array.from({ length: 20 }, (_value, index) => (index + 1) * 40);
    const windows = buildExcerpt(numbered(1000), lines);
    const total = windows.reduce((sum, one) => sum + (one.endLine - one.startLine + 1), 0);
    expect(total).toBeLessThanOrEqual(RETRIEVAL_LIMITS.excerptMaxLines);
  });

  it('prefers the window that holds the most matches', () => {
    const dense = [500, 501, 502, 503, 504];
    const sparse = [100];
    const windows = buildExcerpt(numbered(1000), [...sparse, ...dense]);
    expect(windows.some((one) => one.startLine <= 500 && one.endLine >= 504)).toBe(true);
  });

  it('clips a very long line', () => {
    const long = 'x'.repeat(RETRIEVAL_LIMITS.excerptMaxLineChars + 100);
    const windows = buildExcerpt(long, [1]);
    expect(windows[0]?.text.length).toBe(RETRIEVAL_LIMITS.excerptMaxLineChars);
  });

  it('redacts a credential that survived the path policy', () => {
    const contents = 'const key = "ghp_abcdefghijklmnopqrstuvwxyz0123";\nexport default key;';
    const text = buildExcerpt(contents, [1])[0]?.text ?? '';

    expect(text).toContain('[redacted]');
    expect(text).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123');
  });

  it('redacts a private key block that no single line would reveal', () => {
    const contents = [
      'const pem = `',
      '-----BEGIN RSA PRIVATE KEY-----',
      'MIIEowIBAAKCAQEAxYZ',
      '-----END RSA PRIVATE KEY-----',
      '`;',
    ].join('\n');

    const text = buildExcerpt(contents, [3])
      .map((one) => one.text)
      .join('\n');

    expect(text).not.toContain('MIIEowIBAAKCAQEAxYZ');
    expect(text).not.toContain('BEGIN RSA PRIVATE KEY');
  });

  it('keeps the line count the same when it redacts a block', () => {
    const lines = [
      'const pem = `',
      '-----BEGIN RSA PRIVATE KEY-----',
      'MIIEowIBAAKCAQEAxYZ',
      '-----END RSA PRIVATE KEY-----',
      '`;',
    ];

    const safe = redactWindowLines(lines);
    expect(safe).toHaveLength(lines.length);
    expect(safe[0]).toBe('const pem = `');
    expect(safe[4]).toBe('`;');
  });

  it('redacts to the end of the window when a key block is never closed', () => {
    const safe = redactWindowLines(['-----BEGIN PRIVATE KEY-----', 'MIIEowIBAAKC', 'more']);
    expect(safe).toEqual(['[redacted]', '[redacted]', '[redacted]']);
  });

  it('returns nothing for an empty file', () => {
    expect(buildExcerpt('', [])).toEqual([{ startLine: 1, endLine: 1, text: '' }]);
  });
});
