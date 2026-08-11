import { describe, expect, it } from 'vitest';

import { SANDBOX_LIMITS } from './limits.js';
import { SandboxError } from './provider.js';
import { MemoryWorkspace, normalizeWorkspacePath } from './workspace.js';

function codeOf(work: () => unknown): string {
  try {
    work();
  } catch (error) {
    return error instanceof SandboxError ? error.code : 'NOT_A_SANDBOX_ERROR';
  }
  return 'NO_ERROR';
}

describe('normalizeWorkspacePath', () => {
  it('accepts an ordinary relative path', () => {
    expect(normalizeWorkspacePath('src/index.ts')).toBe('src/index.ts');
  });

  it('tidies a leading dot slash and repeated slashes', () => {
    expect(normalizeWorkspacePath('./src//index.ts')).toBe('src/index.ts');
  });

  it.each([
    ['an absolute posix path', '/etc/passwd'],
    ['an absolute windows path', 'C:/Windows/System32'],
    ['a climbing path', '../secrets.txt'],
    ['a climb hidden in the middle', 'src/../../secrets.txt'],
    ['the git directory', '.git/config'],
    ['a git path further down', 'src/.git/config'],
    ['an empty path', ''],
    ['a directory', 'src/'],
  ])('refuses %s', (_label, path) => {
    expect(codeOf(() => normalizeWorkspacePath(path))).toBe('SANDBOX_PATH_INVALID');
  });

  it('refuses a path longer than the limit', () => {
    expect(codeOf(() => normalizeWorkspacePath('a'.repeat(500)))).toBe('SANDBOX_PATH_INVALID');
  });
});

describe('MemoryWorkspace', () => {
  it('reads back what was seeded', () => {
    const workspace = new MemoryWorkspace();
    workspace.seed({ 'a.txt': 'hello' });

    expect(workspace.read('a.txt')).toBe('hello');
    expect(workspace.has('a.txt')).toBe(true);
    expect(workspace.list()).toEqual(['a.txt']);
  });

  it('refuses to read a file that is not there', () => {
    expect(codeOf(() => new MemoryWorkspace().read('missing.txt'))).toBe('SANDBOX_FILE_NOT_FOUND');
  });

  it('refuses to remove a file that is not there', () => {
    expect(
      codeOf(() => {
        new MemoryWorkspace().remove('missing.txt');
      }),
    ).toBe('SANDBOX_FILE_NOT_FOUND');
  });

  it('writes and overwrites', () => {
    const workspace = new MemoryWorkspace();
    workspace.write('a.txt', 'one');
    workspace.write('a.txt', 'two');

    expect(workspace.read('a.txt')).toBe('two');
    expect(workspace.fileCount()).toBe(1);
  });

  it('refuses a file larger than the limit', () => {
    const workspace = new MemoryWorkspace();
    const oversized = 'a'.repeat(SANDBOX_LIMITS.fileMaxBytes + 1);

    expect(
      codeOf(() => {
        workspace.write('big.txt', oversized);
      }),
    ).toBe('SANDBOX_FILE_TOO_LARGE');
    expect(workspace.has('big.txt')).toBe(false);
  });

  it('refuses to hold more files than the limit', () => {
    const workspace = new MemoryWorkspace();
    for (let index = 0; index < SANDBOX_LIMITS.maxWorkspaceFiles; index += 1) {
      workspace.write(`f${String(index)}.txt`, 'x');
    }

    expect(
      codeOf(() => {
        workspace.write('one-too-many.txt', 'x');
      }),
    ).toBe('SANDBOX_WORKSPACE_FULL');
  });

  it('puts the previous contents back when a write would overfill the workspace', () => {
    const workspace = new MemoryWorkspace();
    const chunk = 'a'.repeat(SANDBOX_LIMITS.fileMaxBytes);
    const wholeChunks = Math.floor(SANDBOX_LIMITS.maxWorkspaceBytes / SANDBOX_LIMITS.fileMaxBytes);

    for (let index = 0; index < wholeChunks - 1; index += 1) {
      workspace.write(`f${String(index)}.txt`, chunk);
    }
    workspace.write('filler.txt', 'a'.repeat(100));
    workspace.write('kept.txt', 'original');

    expect(
      codeOf(() => {
        workspace.write('kept.txt', chunk);
      }),
    ).toBe('SANDBOX_WORKSPACE_FULL');
    expect(workspace.read('kept.txt')).toBe('original');
  });

  it('keeps the baseline separate from the current contents', () => {
    const workspace = new MemoryWorkspace();
    workspace.seed({ 'a.txt': 'original' });
    workspace.write('a.txt', 'changed');
    workspace.write('b.txt', 'added');

    const { baseline, current } = workspace.snapshot();

    expect(baseline.get('a.txt')).toBe('original');
    expect(baseline.has('b.txt')).toBe(false);
    expect(current.get('a.txt')).toBe('changed');
    expect(current.get('b.txt')).toBe('added');
  });

  it('hands out copies so a caller cannot edit the workspace behind its back', () => {
    const workspace = new MemoryWorkspace();
    workspace.seed({ 'a.txt': 'original' });

    workspace.snapshot().current.set('a.txt', 'tampered');

    expect(workspace.read('a.txt')).toBe('original');
  });

  it('reports the bytes it is holding', () => {
    const workspace = new MemoryWorkspace();
    workspace.write('a.txt', 'abc');
    workspace.write('b.txt', 'de');

    expect(workspace.usedBytes()).toBe(5);
  });

  it('is empty after being cleared', () => {
    const workspace = new MemoryWorkspace();
    workspace.seed({ 'a.txt': 'hello' });
    workspace.seedLinks({ 'link.txt': 'a.txt' });
    workspace.seedRepositories(['vendor']);
    workspace.clear();

    expect(workspace.list()).toEqual([]);
    expect(workspace.entries()).toEqual([]);
    expect(workspace.snapshot().baseline.size).toBe(0);
  });
});

describe('reporting what is in the workspace', () => {
  it('describes files with their size', () => {
    const workspace = new MemoryWorkspace();
    workspace.seed({ 'a.txt': 'hello' });

    expect(workspace.entries()).toEqual([{ path: 'a.txt', kind: 'file', size: 5, target: null }]);
  });

  it('invents the directories that hold the files', () => {
    const workspace = new MemoryWorkspace();
    workspace.seed({ 'src/deep/thing.ts': 'x' });

    expect(workspace.entries().map((entry) => `${entry.kind}:${entry.path}`)).toEqual([
      'directory:src',
      'directory:src/deep',
      'file:src/deep/thing.ts',
    ]);
  });

  it('reports a link and where it points, without following it', () => {
    const workspace = new MemoryWorkspace();
    workspace.seedLinks({ 'notes.txt': '/etc/passwd' });

    expect(workspace.entries()).toEqual([
      { path: 'notes.txt', kind: 'symlink', size: 0, target: '/etc/passwd' },
    ]);
  });

  it('reports a nested repository as its own kind', () => {
    const workspace = new MemoryWorkspace();
    workspace.seedRepositories(['vendor/lib']);

    expect(workspace.entries().map((entry) => entry.kind)).toEqual(['directory', 'repository']);
  });

  it('lets a link win over a file at the same path, as a real filesystem would', () => {
    const workspace = new MemoryWorkspace();
    workspace.seed({ 'a.txt': 'hello' });
    workspace.seedLinks({ 'a.txt': '/etc/passwd' });

    expect(workspace.entries()[0]?.kind).toBe('symlink');
  });

  it('returns entries in a stable order', () => {
    const workspace = new MemoryWorkspace();
    workspace.seed({ 'b.txt': 'x', 'a.txt': 'x' });

    expect(workspace.entries().map((entry) => entry.path)).toEqual(['a.txt', 'b.txt']);
  });

  it('refuses a link with no target', () => {
    const workspace = new MemoryWorkspace();

    expect(
      codeOf(() => {
        workspace.seedLinks({ 'bad.txt': '' });
      }),
    ).toBe('SANDBOX_PATH_INVALID');
  });
});
