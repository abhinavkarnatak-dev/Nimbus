import { describe, expect, it } from 'vitest';

import { FakeSandboxProvider, type Sandbox } from '../../sandbox/index.js';
import { testSpec } from '../../sandbox/sandbox.fixtures.js';
import { ToolError } from './errors.js';
import { applyPatch, createFile, listTree, readFile, searchCode } from './file-tools.js';
import { TOOL_LIMITS } from './limits.js';

const FILES: Record<string, string> = {
  'README.md': '# Demo\n\nA small repository.\n',
  'src/index.ts': 'import { greet } from "./greet.js";\n\ngreet("world");\n',
  'src/greet.ts': 'export function greet(name: string): string {\n  return `Hi ${name}`;\n}\n',
  'src/auth/login.ts': 'export const login = true;\n',
  'docs/guide.md': 'Read me later.\n',
  'package.json': '{ "name": "demo" }\n',
  '.env': 'SECRET_TOKEN=supersecretvalue\n',
  'node_modules/left-pad/index.js': 'module.exports = 1;\n',
  'dist/bundle.js': 'console.log(1);\n',
  'logo.png': `PNG${String.fromCharCode(0)}binarydata`,
  '.github/workflows/ci.yml': 'name: ci\n',
};

const LINKS: Record<string, string> = {
  'notes.txt': '/etc/passwd',
  'escape-dir': '/etc',
  'inside.txt': 'src/greet.ts',
};

const REPOSITORIES = ['vendor-lib'];

async function workspace(
  overrides: Record<string, string> = {},
): Promise<{ sandbox: Sandbox; provider: FakeSandboxProvider }> {
  const provider = new FakeSandboxProvider({
    files: { ...FILES, ...overrides, 'vendor-lib/main.go': 'package main\n' },
    links: LINKS,
    repositories: REPOSITORIES,
  });
  return { sandbox: await provider.create(testSpec()), provider };
}

async function codeOf(work: () => Promise<unknown>): Promise<string> {
  try {
    await work();
  } catch (error) {
    return error instanceof ToolError ? error.code : 'NOT_A_TOOL_ERROR';
  }
  return 'NO_ERROR';
}

describe('list_tree', () => {
  it('lists the repository without the parts the agent should not see', async () => {
    const { sandbox } = await workspace();
    const result = await listTree(sandbox);
    const paths = result.entries.map((entry) => entry.path);

    expect(paths).toContain('src/index.ts');
    expect(paths).toContain('README.md');
    expect(paths).not.toContain('.env');
    expect(paths).not.toContain('logo.png');
    expect(paths).not.toContain('node_modules/left-pad/index.js');
    expect(paths).not.toContain('dist/bundle.js');
  });

  it('says how much it hid rather than hiding that it hid anything', async () => {
    const { sandbox } = await workspace();
    const result = await listTree(sandbox);

    expect(result.hiddenByPolicy).toBeGreaterThan(0);
  });

  it('leaves out a link that points outside, and keeps one that points inside', async () => {
    const { sandbox } = await workspace();
    const paths = (await listTree(sandbox)).entries.map((entry) => entry.path);

    expect(paths).not.toContain('notes.txt');
    expect(paths).not.toContain('escape-dir');
    expect(paths).toContain('inside.txt');
  });

  it('shows a nested repository as a folder but never its contents', async () => {
    const { sandbox } = await workspace();
    const paths = (await listTree(sandbox)).entries.map((entry) => entry.path);

    expect(paths).toContain('vendor-lib');
    expect(paths).not.toContain('vendor-lib/main.go');
  });

  it('can be narrowed to one folder', async () => {
    const { sandbox } = await workspace();
    const paths = (await listTree(sandbox, { path: 'src' })).entries.map((entry) => entry.path);

    expect(paths).toContain('src/greet.ts');
    expect(paths).not.toContain('README.md');
  });

  it('stops at the limit and says it was cut', async () => {
    const { sandbox } = await workspace();
    const result = await listTree(sandbox, { maxEntries: 2 });

    expect(result.entries).toHaveLength(2);
    expect(result.truncated).toBe(true);
    expect(result.totalMatched).toBeGreaterThan(2);
  });

  it('refuses to be pointed at an ignored folder', async () => {
    const { sandbox } = await workspace();

    expect(await codeOf(async () => listTree(sandbox, { path: 'node_modules' }))).toBe(
      'PATH_IGNORED',
    );
  });
});

describe('search_code', () => {
  it('finds a string and reports where it is', async () => {
    const { sandbox } = await workspace();
    const result = await searchCode(sandbox, { query: 'greet' });

    expect(result.matches.map((match) => match.path)).toContain('src/greet.ts');
    expect(result.matches[0]?.line).toBeGreaterThan(0);
  });

  it('ignores case unless asked not to', async () => {
    const { sandbox } = await workspace();

    expect((await searchCode(sandbox, { query: 'GREET' })).matches.length).toBeGreaterThan(0);
    expect(
      (await searchCode(sandbox, { query: 'GREET', caseSensitive: true })).matches,
    ).toHaveLength(0);
  });

  it('never reads a secret file, even when the search would match it', async () => {
    const { sandbox } = await workspace();
    const result = await searchCode(sandbox, { query: 'supersecretvalue' });

    expect(result.matches).toHaveLength(0);
    expect(result.filesSkipped).toBeGreaterThan(0);
  });

  it('never searches inside a nested repository', async () => {
    const { sandbox } = await workspace();
    const result = await searchCode(sandbox, { query: 'package main' });

    expect(result.matches).toHaveLength(0);
  });

  it('skips a binary file rather than returning nonsense from it', async () => {
    const { sandbox } = await workspace();
    const result = await searchCode(sandbox, { query: 'binarydata' });

    expect(result.matches).toHaveLength(0);
  });

  it('stops at the match limit and says so', async () => {
    const { sandbox } = await workspace({ 'many.txt': 'hit\n'.repeat(50) });
    const result = await searchCode(sandbox, { query: 'hit', maxMatches: 5 });

    expect(result.matches).toHaveLength(5);
    expect(result.truncated).toBe(true);
  });

  it('clips a very long matching line and says it clipped it', async () => {
    const long = `start${'x'.repeat(TOOL_LIMITS.searchMaxLineChars + 100)}\n`;
    const { sandbox } = await workspace({ 'long.txt': long });
    const match = (await searchCode(sandbox, { query: 'start' })).matches[0];

    expect(match?.text).toHaveLength(TOOL_LIMITS.searchMaxLineChars);
    expect(match?.lineTruncated).toBe(true);
  });

  it('can be narrowed by path', async () => {
    const { sandbox } = await workspace();
    const result = await searchCode(sandbox, { query: 'e', pathPrefix: 'docs' });

    expect(result.matches.every((match) => match.path.startsWith('docs'))).toBe(true);
  });

  it.each([
    ['an empty query', ''],
    ['an absurdly long query', 'x'.repeat(TOOL_LIMITS.searchQueryMaxChars + 1)],
  ])('refuses %s', async (_label, query) => {
    const { sandbox } = await workspace();

    expect(await codeOf(async () => searchCode(sandbox, { query }))).toBe('SEARCH_INVALID');
  });
});

describe('read_file', () => {
  it('reads an ordinary file', async () => {
    const { sandbox } = await workspace();
    const result = await readFile(sandbox, { path: 'src/greet.ts' });

    expect(result.contents).toContain('export function greet');
    expect(result.totalLines).toBeGreaterThan(1);
    expect(result.isProtected).toBe(false);
  });

  it('reads a range of lines', async () => {
    const { sandbox } = await workspace({ 'many.txt': 'a\nb\nc\nd\ne\n' });
    const result = await readFile(sandbox, { path: 'many.txt', startLine: 2, lineCount: 2 });

    expect(result.contents).toBe('b\nc');
    expect(result.startLine).toBe(2);
    expect(result.endLine).toBe(3);
    expect(result.truncated).toBe(true);
  });

  it('says when a file is protected, without refusing to read it', async () => {
    const { sandbox } = await workspace();

    expect((await readFile(sandbox, { path: 'package.json' })).isProtected).toBe(true);
    expect((await readFile(sandbox, { path: '.github/workflows/ci.yml' })).isProtected).toBe(true);
  });

  it('follows a link that stays inside the workspace', async () => {
    const { sandbox } = await workspace();
    const result = await readFile(sandbox, { path: 'inside.txt' });

    expect(result.path).toBe('src/greet.ts');
  });

  it.each([
    ['a link pointing out of the workspace', 'notes.txt', 'PATH_OUTSIDE_WORKSPACE'],
    ['a path through a directory link pointing out', 'escape-dir/passwd', 'PATH_OUTSIDE_WORKSPACE'],
    ['a climb out of the workspace', '../../etc/passwd', 'PATH_INVALID'],
    ['an absolute path', '/etc/passwd', 'PATH_INVALID'],
    ['a file inside a nested repository', 'vendor-lib/main.go', 'PATH_NESTED_REPOSITORY'],
    ['an environment file', '.env', 'PATH_IGNORED'],
    ['a file inside node_modules', 'node_modules/left-pad/index.js', 'PATH_IGNORED'],
    ['a binary file', 'logo.png', 'PATH_IGNORED'],
    ['a directory', 'src', 'PATH_NOT_A_FILE'],
    ['a file that is not there', 'nowhere.ts', 'FILE_NOT_FOUND'],
  ])('refuses %s', async (_label, path, expected) => {
    const { sandbox } = await workspace();

    expect(await codeOf(async () => readFile(sandbox, { path }))).toBe(expected);
  });

  it('refuses a file that is too large', async () => {
    const { sandbox } = await workspace({
      'big.txt': 'x'.repeat(TOOL_LIMITS.readMaxBytes + 1_000),
    });

    expect(await codeOf(async () => readFile(sandbox, { path: 'big.txt' }))).toBe('FILE_TOO_LARGE');
  });

  it('refuses a file that is not text even when its name says otherwise', async () => {
    const { sandbox } = await workspace({
      'sneaky.txt': `data${String.fromCharCode(0)}more`,
    });

    expect(await codeOf(async () => readFile(sandbox, { path: 'sneaky.txt' }))).toBe(
      'FILE_NOT_TEXT',
    );
  });
});

describe('create_file', () => {
  it('creates a new file', async () => {
    const { sandbox } = await workspace();
    const result = await createFile(sandbox, {
      path: 'src/new.ts',
      contents: 'export const a = 1;\n',
    });

    expect(result.path).toBe('src/new.ts');
    expect(await sandbox.readFile('src/new.ts')).toBe('export const a = 1;\n');
  });

  it('refuses to overwrite, because overwriting is what patching is for', async () => {
    const { sandbox } = await workspace();

    expect(
      await codeOf(async () => createFile(sandbox, { path: 'README.md', contents: 'nope' })),
    ).toBe('FILE_EXISTS');
  });

  it('flags a protected path without refusing it', async () => {
    const { sandbox } = await workspace();
    const result = await createFile(sandbox, {
      path: '.github/workflows/release.yml',
      contents: 'name: release\n',
    });

    expect(result.isProtected).toBe(true);
  });

  it.each([
    ['a path out of the workspace', '../evil.txt', 'PATH_INVALID'],
    ['a link pointing out of the workspace', 'notes.txt', 'PATH_OUTSIDE_WORKSPACE'],
    ['a file inside a nested repository', 'vendor-lib/new.go', 'PATH_NESTED_REPOSITORY'],
    ['an environment file', '.env.production', 'PATH_IGNORED'],
  ])('refuses %s', async (_label, path, expected) => {
    const { sandbox } = await workspace();

    expect(await codeOf(async () => createFile(sandbox, { path, contents: 'x' }))).toBe(expected);
  });

  it('refuses contents that are too large', async () => {
    const { sandbox } = await workspace();
    const contents = 'x'.repeat(TOOL_LIMITS.createMaxBytes + 1);

    expect(await codeOf(async () => createFile(sandbox, { path: 'big.txt', contents }))).toBe(
      'FILE_TOO_LARGE',
    );
  });

  it('refuses contents that are not text', async () => {
    const { sandbox } = await workspace();
    const contents = `a${String.fromCharCode(0)}b`;

    expect(await codeOf(async () => createFile(sandbox, { path: 'bin.txt', contents }))).toBe(
      'FILE_NOT_TEXT',
    );
  });
});

describe('apply_patch', () => {
  const patchFor = (path: string, from: string, to: string): string =>
    [`--- a/${path}`, `+++ b/${path}`, '@@ -1,1 +1,1 @@', `-${from}`, `+${to}`, ''].join('\n');

  it('changes a file and reports what it changed', async () => {
    const { sandbox } = await workspace({ 'one.txt': 'before\n' });
    const result = await applyPatch(sandbox, { patch: patchFor('one.txt', 'before', 'after') });

    expect(await sandbox.readFile('one.txt')).toBe('after\n');
    expect(result.files[0]).toMatchObject({
      path: 'one.txt',
      changeKind: 'modified',
      addedLines: 1,
      removedLines: 1,
    });
  });

  it('applies matching context when a model supplied a stale hunk line number', async () => {
    const { sandbox } = await workspace({ 'one.txt': 'first\nsecond\nthird\n' });
    await applyPatch(sandbox, {
      patch: ['--- a/one.txt', '+++ b/one.txt', '@@ -20,1 +20,1 @@', '-second', '+updated', ''].join('\n'),
    });
    expect(await sandbox.readFile('one.txt')).toBe('first\nupdated\nthird\n');
  });

  it('creates a file the patch adds', async () => {
    const { sandbox } = await workspace();
    const patch = ['--- /dev/null', '+++ b/fresh.txt', '@@ -0,0 +1,1 @@', '+hello', ''].join('\n');

    await applyPatch(sandbox, { patch });

    expect(await sandbox.readFile('fresh.txt')).toBe('hello\n');
  });

  it('names every protected path it touched', async () => {
    const { sandbox } = await workspace();
    const patch = [
      '--- a/.github/workflows/ci.yml',
      '+++ b/.github/workflows/ci.yml',
      '@@ -1,1 +1,1 @@',
      '-name: ci',
      '+name: broken',
      '',
    ].join('\n');

    const result = await applyPatch(sandbox, { patch });

    expect(result.protectedPaths).toEqual(['.github/workflows/ci.yml']);
  });

  it('checks every path in the patch the same way as any other path', async () => {
    const { sandbox } = await workspace();

    expect(
      await codeOf(async () => applyPatch(sandbox, { patch: patchFor('notes.txt', 'a', 'b') })),
    ).toBe('PATH_OUTSIDE_WORKSPACE');
    expect(
      await codeOf(async () =>
        applyPatch(sandbox, { patch: patchFor('vendor-lib/main.go', 'a', 'b') }),
      ),
    ).toBe('PATH_NESTED_REPOSITORY');
    expect(
      await codeOf(async () => applyPatch(sandbox, { patch: patchFor('.env', 'a', 'b') })),
    ).toBe('PATH_IGNORED');
  });

  it('refuses a deletion, which needs an approval that does not exist yet', async () => {
    const { sandbox } = await workspace();
    const patch = ['--- a/README.md', '+++ /dev/null', '@@ -1,1 +0,0 @@', '-# Demo', ''].join('\n');

    expect(await codeOf(async () => applyPatch(sandbox, { patch }))).toBe(
      'PATCH_APPROVAL_REQUIRED',
    );
  });

  it('refuses a rename for the same reason', async () => {
    const { sandbox } = await workspace();
    const patch = [
      '--- a/README.md',
      '+++ b/READTHIS.md',
      '@@ -1,1 +1,1 @@',
      '-# Demo',
      '+# Demo',
      '',
    ].join('\n');

    expect(await codeOf(async () => applyPatch(sandbox, { patch }))).toBe(
      'PATCH_APPROVAL_REQUIRED',
    );
  });

  it('refuses when the surrounding lines have moved on', async () => {
    const { sandbox } = await workspace({ 'one.txt': 'something else\n' });

    expect(
      await codeOf(async () =>
        applyPatch(sandbox, { patch: patchFor('one.txt', 'before', 'after') }),
      ),
    ).toBe('PATCH_CONTEXT_MISMATCH');
  });

  it('changes nothing at all when one file in the patch is refused', async () => {
    const { sandbox } = await workspace({ 'one.txt': 'before\n' });
    const patch = [
      patchFor('one.txt', 'before', 'after'),
      patchFor('vendor-lib/main.go', 'a', 'b'),
    ].join('');

    expect(await codeOf(async () => applyPatch(sandbox, { patch }))).toBe('PATH_NESTED_REPOSITORY');
    expect(await sandbox.readFile('one.txt')).toBe('before\n');
  });

  it('refuses to patch a file that is not there', async () => {
    const { sandbox } = await workspace();

    expect(
      await codeOf(async () => applyPatch(sandbox, { patch: patchFor('missing.txt', 'a', 'b') })),
    ).toBe('FILE_NOT_FOUND');
  });

  it('refuses to add a file that already exists', async () => {
    const { sandbox } = await workspace();
    const patch = ['--- /dev/null', '+++ b/README.md', '@@ -0,0 +1,1 @@', '+hi', ''].join('\n');

    expect(await codeOf(async () => applyPatch(sandbox, { patch }))).toBe('FILE_EXISTS');
  });
});
