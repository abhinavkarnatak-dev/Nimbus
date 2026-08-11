import { describe, expect, it } from 'vitest';

import {
  DIFF_DP_MAX_LINES,
  NO_NEWLINE_MARKER,
  buildPatch,
  diffLines,
  splitLines,
  unifiedDiff,
} from './diff.js';
import { SANDBOX_LIMITS } from './limits.js';
import { SandboxError } from './provider.js';

function lines(count: number, prefix = 'line'): string {
  return `${Array.from({ length: count }, (_value, index) => `${prefix} ${String(index + 1)}`).join('\n')}\n`;
}

function patchOf(baseline: Record<string, string>, current: Record<string, string>): string {
  return buildPatch(new Map(Object.entries(baseline)), new Map(Object.entries(current))).patch;
}

describe('splitLines', () => {
  it('treats an empty file as having no lines', () => {
    expect(splitLines('')).toEqual({ lines: [], endsWithNewline: true });
  });

  it('does not invent a trailing empty line', () => {
    expect(splitLines('a\nb\n')).toEqual({ lines: ['a', 'b'], endsWithNewline: true });
  });

  it('remembers a missing final newline', () => {
    expect(splitLines('a\nb')).toEqual({ lines: ['a', 'b'], endsWithNewline: false });
  });
});

describe('diffLines', () => {
  it('reports nothing changed when the sides match', () => {
    const operations = diffLines(['a', 'b'], ['a', 'b']);

    expect(operations.every((operation) => operation.kind === 'context')).toBe(true);
  });

  it('finds a single replaced line rather than replacing everything', () => {
    const operations = diffLines(['a', 'b', 'c'], ['a', 'B', 'c']);

    expect(operations.filter((operation) => operation.kind === 'remove')).toEqual([
      { kind: 'remove', text: 'b' },
    ]);
    expect(operations.filter((operation) => operation.kind === 'add')).toEqual([
      { kind: 'add', text: 'B' },
    ]);
  });

  it('keeps shared lines as context when a block is inserted', () => {
    const operations = diffLines(['a', 'd'], ['a', 'b', 'c', 'd']);

    expect(operations.map((operation) => operation.kind)).toEqual([
      'context',
      'add',
      'add',
      'context',
    ]);
  });
});

describe('unifiedDiff', () => {
  it('produces nothing when a file is unchanged', () => {
    expect(unifiedDiff('a.txt', 'same\n', 'same\n')).toEqual({
      text: '',
      addedLines: 0,
      removedLines: 0,
    });
  });

  it('writes an ordinary modification with surrounding context', () => {
    const before = lines(8);
    const after = before.replace('line 4', 'line four');

    expect(unifiedDiff('src/a.ts', before, after).text).toBe(
      [
        'diff --git a/src/a.ts b/src/a.ts',
        '--- a/src/a.ts',
        '+++ b/src/a.ts',
        '@@ -1,7 +1,7 @@',
        ' line 1',
        ' line 2',
        ' line 3',
        '-line 4',
        '+line four',
        ' line 5',
        ' line 6',
        ' line 7',
        '',
      ].join('\n'),
    );
  });

  it('marks a new file', () => {
    const diff = unifiedDiff('new.txt', null, 'hello\n');

    expect(diff.text).toBe(
      [
        'diff --git a/new.txt b/new.txt',
        'new file mode 100644',
        '--- /dev/null',
        '+++ b/new.txt',
        '@@ -0,0 +1,1 @@',
        '+hello',
        '',
      ].join('\n'),
    );
    expect(diff.addedLines).toBe(1);
    expect(diff.removedLines).toBe(0);
  });

  it('marks a deleted file', () => {
    const diff = unifiedDiff('gone.txt', 'bye\n', null);

    expect(diff.text).toBe(
      [
        'diff --git a/gone.txt b/gone.txt',
        'deleted file mode 100644',
        '--- a/gone.txt',
        '+++ /dev/null',
        '@@ -1,1 +0,0 @@',
        '-bye',
        '',
      ].join('\n'),
    );
    expect(diff.removedLines).toBe(1);
  });

  it('records that the new content has no final newline', () => {
    const diff = unifiedDiff('a.txt', 'one\n', 'two');

    expect(diff.text.split('\n')).toContain(NO_NEWLINE_MARKER);
    expect(diff.text.endsWith(`${NO_NEWLINE_MARKER}\n`)).toBe(true);
  });

  it('records that the old content had no final newline', () => {
    const diff = unifiedDiff('a.txt', 'one', 'two\n');
    const body = diff.text.split('\n');

    expect(body[body.indexOf('-one') + 1]).toBe(NO_NEWLINE_MARKER);
  });

  it('marks the shared line once when neither side has a final newline', () => {
    const diff = unifiedDiff('a.txt', 'a\nb', 'a\nc\nb');
    const marks = diff.text.split('\n').filter((line) => line === NO_NEWLINE_MARKER);

    expect(marks).toHaveLength(1);
  });

  it('does not count the no newline marker as a changed line', () => {
    const diff = unifiedDiff('a.txt', 'one\n', 'two');

    expect(diff.addedLines).toBe(1);
    expect(diff.removedLines).toBe(1);
  });

  it('produces two hunks for two edits far apart', () => {
    const before = lines(40);
    const after = before.replace('line 2\n', 'line two\n').replace('line 38\n', 'line thirty\n');
    const hunkHeaders = unifiedDiff('a.txt', before, after)
      .text.split('\n')
      .filter((line) => line.startsWith('@@'));

    expect(hunkHeaders).toHaveLength(2);
  });

  it('falls back to replacing the file wholly when it is too large to compare line by line', () => {
    const before = lines(DIFF_DP_MAX_LINES + 1);
    const after = before.replace('line 1\n', 'changed\n');
    const diff = unifiedDiff('big.txt', before, after);

    expect(diff.removedLines).toBe(1);
    expect(diff.addedLines).toBe(1);
  });
});

describe('buildPatch', () => {
  it('returns an empty patch when nothing changed', () => {
    const result = buildPatch(new Map([['a.txt', 'same\n']]), new Map([['a.txt', 'same\n']]));

    expect(result).toEqual({
      patch: '',
      files: [],
      addedLines: 0,
      removedLines: 0,
      bytes: 0,
    });
  });

  it('lists every kind of change in path order', () => {
    const result = buildPatch(
      new Map([
        ['b.txt', 'old\n'],
        ['c.txt', 'gone\n'],
      ]),
      new Map([
        ['a.txt', 'brand new\n'],
        ['b.txt', 'new\n'],
      ]),
    );

    expect(result.files).toEqual([
      { path: 'a.txt', changeKind: 'added', addedLines: 1, removedLines: 0 },
      { path: 'b.txt', changeKind: 'modified', addedLines: 1, removedLines: 1 },
      { path: 'c.txt', changeKind: 'deleted', addedLines: 0, removedLines: 1 },
    ]);
    expect(result.addedLines).toBe(2);
    expect(result.removedLines).toBe(2);
    expect(result.bytes).toBe(Buffer.byteLength(result.patch, 'utf8'));
  });

  it('joins the sections so the whole patch is one applyable document', () => {
    const patch = patchOf({}, { 'a.txt': 'one\n', 'b.txt': 'two\n' });

    expect(patch.split('diff --git')).toHaveLength(3);
    expect(patch.endsWith('\n')).toBe(true);
  });

  it('refuses a change touching too many files', () => {
    const current: Record<string, string> = {};
    for (let index = 0; index <= SANDBOX_LIMITS.patchMaxFiles; index += 1) {
      current[`file-${String(index)}.txt`] = 'x\n';
    }

    expect(() => patchOf({}, current)).toThrow(SandboxError);
    expect(() => patchOf({}, current)).toThrow(/too many files/);
  });

  it('refuses a change with too many lines', () => {
    expect(() => patchOf({}, { 'big.txt': lines(SANDBOX_LIMITS.patchMaxLines + 1) })).toThrow(
      /too large/,
    );
  });

  it('carries no credentials of its own, being only the changed lines', () => {
    const patch = patchOf({ 'a.txt': 'one\n' }, { 'a.txt': 'two\n' });

    expect(patch).not.toMatch(/token|secret|password|Bearer/i);
  });
});
