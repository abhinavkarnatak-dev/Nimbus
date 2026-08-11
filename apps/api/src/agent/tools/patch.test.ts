import { describe, expect, it } from 'vitest';

import { buildPatch } from '../../sandbox/index.js';
import { ToolError } from './errors.js';
import { TOOL_LIMITS } from './limits.js';
import { NO_NEWLINE_MARKER, applyPatchToFile, parsePatch, type PatchFile } from './patch.js';

function at(files: readonly PatchFile[], index: number): PatchFile {
  const file = files[index];

  if (file === undefined) {
    throw new Error(`expected a file section at position ${String(index)}`);
  }
  return file;
}

function sectionOf(patch: string): PatchFile {
  return at(parsePatch(patch), 0);
}

function codeOf(work: () => unknown): string {
  try {
    work();
  } catch (error) {
    return error instanceof ToolError ? error.code : 'NOT_A_TOOL_ERROR';
  }
  return 'NO_ERROR';
}

function lines(count: number, prefix = 'line'): string {
  return `${Array.from({ length: count }, (_v, index) => `${prefix} ${String(index + 1)}`).join('\n')}\n`;
}

const SIMPLE = [
  'diff --git a/src/a.ts b/src/a.ts',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,3 +1,3 @@',
  ' one',
  '-two',
  '+TWO',
  ' three',
  '',
].join('\n');

describe('parsePatch', () => {
  it('reads a plain modification', () => {
    const files = parsePatch(SIMPLE);

    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({
      oldPath: 'src/a.ts',
      newPath: 'src/a.ts',
      changeKind: 'modified',
      addedLines: 1,
      removedLines: 1,
    });
    expect(files[0]?.hunks[0]).toMatchObject({ beforeStart: 1, beforeCount: 3, afterCount: 3 });
  });

  it('reads a new file', () => {
    const files = parsePatch(
      ['--- /dev/null', '+++ b/new.txt', '@@ -0,0 +1,1 @@', '+hello', ''].join('\n'),
    );

    expect(files[0]).toMatchObject({ oldPath: null, newPath: 'new.txt', changeKind: 'added' });
  });

  it('reads a deleted file', () => {
    const files = parsePatch(
      ['--- a/gone.txt', '+++ /dev/null', '@@ -1,1 +0,0 @@', '-bye', ''].join('\n'),
    );

    expect(files[0]).toMatchObject({ newPath: null, changeKind: 'deleted' });
  });

  it('reads a rename', () => {
    const files = parsePatch(
      ['--- a/old.txt', '+++ b/new.txt', '@@ -1,1 +1,1 @@', '-a', '+b', ''].join('\n'),
    );

    expect(files[0]).toMatchObject({
      oldPath: 'old.txt',
      newPath: 'new.txt',
      changeKind: 'renamed',
    });
  });

  it('reads several files in one patch', () => {
    const patch = [
      SIMPLE,
      ['--- a/b.txt', '+++ b/b.txt', '@@ -1,1 +1,1 @@', '-x', '+y', ''].join('\n'),
    ].join('');

    expect(parsePatch(patch)).toHaveLength(2);
  });

  it('handles windows line endings in the patch itself', () => {
    expect(parsePatch(SIMPLE.replace(/\n/g, '\r\n'))).toHaveLength(1);
  });

  it('accepts a hunk header without counts, which means one line', () => {
    const files = parsePatch(
      ['--- a/a.txt', '+++ b/a.txt', '@@ -1 +1 @@', '-a', '+b', ''].join('\n'),
    );

    expect(files[0]?.hunks[0]).toMatchObject({ beforeCount: 1, afterCount: 1 });
  });

  it.each([
    ['it is empty', ''],
    ['it is only whitespace', '   \n  '],
    ['there are no file sections', 'just some text\nand more\n'],
    ['a hunk arrives before any file', '@@ -1,1 +1,1 @@\n-a\n+b\n'],
    ['a new path has no old path', '+++ b/a.txt\n@@ -1,1 +1,1 @@\n-a\n+b\n'],
    ['a file section has no hunks', '--- a/a.txt\n+++ b/a.txt\n'],
    ['both sides are dev null', '--- /dev/null\n+++ /dev/null\n@@ -1,1 +1,1 @@\n-a\n+b\n'],
  ])('refuses a patch where %s', (_label, patch) => {
    expect(codeOf(() => parsePatch(patch))).toBe('PATCH_MALFORMED');
  });

  it('refuses a hunk header that lies about its contents', () => {
    const patch = [
      '--- a/a.txt',
      '+++ b/a.txt',
      '@@ -1,9 +1,9 @@',
      ' one',
      '-two',
      '+TWO',
      '',
    ].join('\n');

    expect(codeOf(() => parsePatch(patch))).toBe('PATCH_MALFORMED');
  });

  it('refuses a patch touching too many files', () => {
    const sections: string[] = [];
    for (let index = 0; index <= TOOL_LIMITS.patchMaxFiles; index += 1) {
      sections.push(
        [`--- /dev/null`, `+++ b/f${String(index)}.txt`, '@@ -0,0 +1,1 @@', '+x', ''].join('\n'),
      );
    }

    expect(codeOf(() => parsePatch(sections.join('')))).toBe('PATCH_TOO_LARGE');
  });

  it('refuses a patch changing too many lines', () => {
    const added = Array.from(
      { length: TOOL_LIMITS.patchMaxLines + 1 },
      (_v, index) => `+line ${String(index)}`,
    );
    const patch = [
      '--- /dev/null',
      '+++ b/big.txt',
      `@@ -0,0 +1,${String(added.length)} @@`,
      ...added,
      '',
    ].join('\n');

    expect(codeOf(() => parsePatch(patch))).toBe('PATCH_TOO_LARGE');
  });

  it('refuses a patch larger than the byte cap', () => {
    const huge = `--- a/a.txt\n+++ b/a.txt\n@@ -1,1 +1,1 @@\n-a\n+${'x'.repeat(TOOL_LIMITS.patchMaxBytes)}\n`;

    expect(codeOf(() => parsePatch(huge))).toBe('PATCH_TOO_LARGE');
  });
});

describe('applyPatchToFile', () => {
  it('applies an ordinary change', () => {
    const file = sectionOf(SIMPLE);

    expect(applyPatchToFile(file, 'one\ntwo\nthree\n')).toBe('one\nTWO\nthree\n');
  });

  it('creates a new file from nothing', () => {
    const file = sectionOf(
      ['--- /dev/null', '+++ b/new.txt', '@@ -0,0 +1,2 @@', '+one', '+two', ''].join('\n'),
    );

    expect(applyPatchToFile(file, null)).toBe('one\ntwo\n');
  });

  it('refuses when the surrounding lines do not match', () => {
    const file = sectionOf(SIMPLE);

    expect(codeOf(() => applyPatchToFile(file, 'one\nCHANGED\nthree\n'))).toBe(
      'PATCH_CONTEXT_MISMATCH',
    );
  });

  it('refuses when the file has moved on and the context sits elsewhere', () => {
    const file = sectionOf(SIMPLE);

    expect(codeOf(() => applyPatchToFile(file, 'zero\none\ntwo\nthree\n'))).toBe(
      'PATCH_CONTEXT_MISMATCH',
    );
  });

  it('refuses when the hunk starts past the end of the file', () => {
    const file = sectionOf(
      ['--- a/a.txt', '+++ b/a.txt', '@@ -50,1 +50,1 @@', '-a', '+b', ''].join('\n'),
    );

    expect(codeOf(() => applyPatchToFile(file, 'a\n'))).toBe('PATCH_CONTEXT_MISMATCH');
  });

  it('keeps the untouched parts of a longer file exactly as they were', () => {
    const original = lines(20);
    const file = sectionOf(
      [
        '--- a/a.txt',
        '+++ b/a.txt',
        '@@ -9,3 +9,3 @@',
        ' line 9',
        '-line 10',
        '+line ten',
        ' line 11',
        '',
      ].join('\n'),
    );

    const result = applyPatchToFile(file, original);

    expect(result).toBe(original.replace('line 10\n', 'line ten\n'));
  });

  it('applies two hunks in one file', () => {
    const original = lines(20);
    const file = sectionOf(
      [
        '--- a/a.txt',
        '+++ b/a.txt',
        '@@ -1,2 +1,2 @@',
        '-line 1',
        '+first',
        ' line 2',
        '@@ -18,2 +18,2 @@',
        ' line 18',
        '-line 19',
        '+nineteen',
        '',
      ].join('\n'),
    );

    const result = applyPatchToFile(file, original);

    expect(result).toContain('first\n');
    expect(result).toContain('nineteen\n');
    expect(result).toContain('line 20\n');
  });

  it('honours a missing final newline', () => {
    const file = sectionOf(
      ['--- a/a.txt', '+++ b/a.txt', '@@ -1,1 +1,1 @@', '-one', '+two', NO_NEWLINE_MARKER, ''].join(
        '\n',
      ),
    );

    expect(applyPatchToFile(file, 'one\n')).toBe('two');
  });
});

describe('a patch written by the sandbox can be read back by the tools', () => {
  it('round trips a modification', () => {
    const before = lines(12);
    const after = before.replace('line 6', 'line six');

    const written = buildPatch(new Map([['a.txt', before]]), new Map([['a.txt', after]]));
    const parsed = parsePatch(written.patch);

    expect(applyPatchToFile(at(parsed, 0), before)).toBe(after);
  });

  it('round trips a new file', () => {
    const written = buildPatch(new Map(), new Map([['fresh.txt', 'alpha\nbeta\n']]));
    const parsed = parsePatch(written.patch);

    expect(applyPatchToFile(at(parsed, 0), null)).toBe('alpha\nbeta\n');
  });

  it('round trips a file with no final newline', () => {
    const written = buildPatch(new Map([['a.txt', 'one\n']]), new Map([['a.txt', 'two']]));
    const parsed = parsePatch(written.patch);

    expect(applyPatchToFile(at(parsed, 0), 'one\n')).toBe('two');
  });

  it('round trips several files at once', () => {
    const written = buildPatch(
      new Map([['a.txt', 'one\n']]),
      new Map([
        ['a.txt', 'ONE\n'],
        ['b.txt', 'new\n'],
      ]),
    );
    const parsed = parsePatch(written.patch);

    expect(parsed).toHaveLength(2);
    expect(applyPatchToFile(at(parsed, 0), 'one\n')).toBe('ONE\n');
    expect(applyPatchToFile(at(parsed, 1), null)).toBe('new\n');
  });
});
