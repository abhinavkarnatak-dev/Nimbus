import { describe, expect, it } from 'vitest';

import {
  addDiff,
  binaryDiff,
  deleteDiff,
  editDiff,
  modeChangeDiff,
  renameDiff,
  submoduleDiff,
  symlinkDiff,
} from './patch.fixtures.js';
import {
  PatchParseError,
  REGULAR_MODE,
  SUBMODULE_MODE,
  SYMLINK_MODE,
  headerPaths,
  parsePatch,
} from './parse.js';

describe('parsePatch', () => {
  it('reads an ordinary edit', () => {
    const [file] = parsePatch(editDiff());

    expect(file).toMatchObject({
      oldPath: 'src/app.ts',
      newPath: 'src/app.ts',
      created: false,
      deleted: false,
      renamed: false,
      binary: false,
      addedLines: 1,
      removedLines: 1,
    });
    expect(file?.addedText).toEqual(['const b = 3;']);
  });

  it('reads a new file', () => {
    const [file] = parsePatch(addDiff());

    expect(file).toMatchObject({ created: true, oldPath: null, newPath: 'src/new.ts' });
    expect(file?.newMode).toBe(REGULAR_MODE);
  });

  it('reads a deletion', () => {
    const [file] = parsePatch(deleteDiff());

    expect(file).toMatchObject({ deleted: true, oldPath: 'src/old.ts', newPath: null });
  });

  it('reads a rename with no content change', () => {
    const [file] = parsePatch(renameDiff());

    expect(file).toMatchObject({ renamed: true, oldPath: 'src/old.ts', newPath: 'src/new.ts' });
  });

  it('reads a symbolic link by its mode', () => {
    expect(parsePatch(symlinkDiff())[0]?.newMode).toBe(SYMLINK_MODE);
  });

  it('reads a submodule by its mode', () => {
    expect(parsePatch(submoduleDiff())[0]?.newMode).toBe(SUBMODULE_MODE);
  });

  it('reads a mode change on both sides', () => {
    const [file] = parsePatch(modeChangeDiff());

    expect(file?.oldMode).toBe('100644');
    expect(file?.newMode).toBe('100755');
  });

  it('marks a binary file', () => {
    expect(parsePatch(binaryDiff())[0]?.binary).toBe(true);
  });

  it('reads several files in one patch', () => {
    const files = parsePatch(
      `${editDiff('src/a.ts')}${addDiff('src/b.ts')}${deleteDiff('src/c.ts')}`,
    );

    expect(files.map((file) => file.newPath ?? file.oldPath)).toEqual([
      'src/a.ts',
      'src/b.ts',
      'src/c.ts',
    ]);
  });

  it('returns nothing for an empty patch', () => {
    expect(parsePatch('')).toEqual([]);
  });

  it('does not mistake diff content for a header', () => {
    const patch = [
      'diff --git a/notes.md b/notes.md',
      'index 83db48f..bf269f4 100644',
      '--- a/notes.md',
      '+++ b/notes.md',
      '@@ -1,3 +1,4 @@',
      ' before',
      '+--- a/fake.ts',
      '+new file mode 120000',
      '-@@ -9,9 +9,9 @@',
      '',
    ].join('\n');

    const files = parsePatch(patch);

    expect(files).toHaveLength(1);
    expect(files[0]?.newMode).toBe('100644');
    expect(files[0]?.addedLines).toBe(2);
  });

  it('refuses content before any file header', () => {
    expect(() => parsePatch('surprise\ndiff --git a/x b/x\n')).toThrow(PatchParseError);
  });

  it('refuses a quoted path', () => {
    expect(() => parsePatch('diff --git "a/x" "b/x"\n')).toThrow(PatchParseError);
  });

  it('refuses a header line it does not understand', () => {
    expect(() => parsePatch('diff --git a/x b/x\nwat mode 100644\n')).toThrow(PatchParseError);
  });

  it('refuses a mode that is not six octal digits', () => {
    expect(() => parsePatch('diff --git a/x b/x\nnew file mode 99\n')).toThrow(PatchParseError);
  });

  it('refuses a line inside a hunk that is neither header nor content', () => {
    const patch = [
      'diff --git a/x.ts b/x.ts',
      '--- a/x.ts',
      '+++ b/x.ts',
      '@@ -1 +1 @@',
      'this line has no prefix at all',
      '',
    ].join('\n');

    expect(() => parsePatch(patch)).toThrow(PatchParseError);
  });
});

describe('headerPaths', () => {
  it('splits the two sides', () => {
    expect(headerPaths('diff --git a/src/old.ts b/src/new.ts')).toEqual({
      oldPath: 'src/old.ts',
      newPath: 'src/new.ts',
    });
  });

  it('keeps a path that climbs out so it can be refused later', () => {
    expect(headerPaths('diff --git a/../../etc/passwd b/../../etc/passwd').oldPath).toBe(
      '../../etc/passwd',
    );
  });

  it('refuses a header with only one side', () => {
    expect(() => headerPaths('diff --git a/only.ts')).toThrow(PatchParseError);
  });
});
