import { describe, expect, it } from 'vitest';

import type { WorkspaceEntry } from '../../sandbox/index.js';
import { ToolError } from './errors.js';
import { TOOL_LIMITS } from './limits.js';
import { WorkspaceIndex, assertReadable, assertRegularFile } from './resolve.js';

function file(path: string, size = 10): WorkspaceEntry {
  return { path, kind: 'file', size, target: null };
}

function directory(path: string): WorkspaceEntry {
  return { path, kind: 'directory', size: 0, target: null };
}

function link(path: string, target: string): WorkspaceEntry {
  return { path, kind: 'symlink', size: 0, target };
}

function repository(path: string): WorkspaceEntry {
  return { path, kind: 'repository', size: 0, target: null };
}

const INDEX = new WorkspaceIndex([
  file('README.md'),
  directory('src'),
  file('src/index.ts'),
  file('src/auth/login.ts'),
  directory('docs'),
  file('docs/guide.md'),
  file('.env'),
  file('logo.png'),
  file('package.json'),
  link('notes.txt', '/etc/passwd'),
  link('escape-dir', '/etc'),
  link('root-link', '/workspace'),
  link('inside.txt', 'src/index.ts'),
  link('inside-relative.txt', './index.ts'),
  link('docs-alias', '/workspace/docs'),
  link('climber.txt', '../../../etc/passwd'),
  link('loop-a', 'loop-b'),
  link('loop-b', 'loop-a'),
  link('self', 'self'),
  repository('vendor-lib'),
  file('vendor-lib/main.go'),
]);

function codeOf(work: () => unknown): string {
  try {
    work();
  } catch (error) {
    return error instanceof ToolError ? error.code : 'NOT_A_TOOL_ERROR';
  }
  return 'NO_ERROR';
}

describe('plain string checks', () => {
  it('accepts an ordinary relative path', () => {
    expect(INDEX.resolve('src/index.ts').path).toBe('src/index.ts');
  });

  it('tidies a leading dot slash and doubled slashes', () => {
    expect(INDEX.resolve('./src//index.ts').path).toBe('src/index.ts');
  });

  it.each([
    ['an absolute posix path', '/etc/passwd'],
    ['an absolute windows path', 'C:/Windows/System32/config'],
    ['a climbing path', '../secrets.txt'],
    ['a climb buried in the middle', 'src/../../etc/passwd'],
    ['a backslash climb', String.raw`..\..\etc\passwd`],
    ['the git directory', '.git/config'],
    ['a git directory further down', 'src/.git/config'],
    ['an empty path', ''],
    ['only whitespace', '   '],
    ['a trailing slash', 'src/'],
    ['a single dot segment', 'src/./index.ts'],
  ])('refuses %s', (_label, path) => {
    expect(codeOf(() => INDEX.resolve(path))).toBe('PATH_INVALID');
  });

  it('refuses a null byte, which is how a checked path and a used path come apart', () => {
    expect(codeOf(() => INDEX.resolve(`src/index.ts${String.fromCharCode(0)}.png`))).toBe(
      'PATH_INVALID',
    );
  });

  it('refuses a path nested absurdly deep', () => {
    const deep = new Array<string>(TOOL_LIMITS.pathSegmentsMax + 1).fill('a').join('/');

    expect(codeOf(() => INDEX.resolve(deep))).toBe('PATH_INVALID');
  });
});

describe('symlink escape, which no string check can catch', () => {
  it('refuses a file that is really a link out of the workspace', () => {
    expect(codeOf(() => INDEX.resolve('notes.txt'))).toBe('PATH_OUTSIDE_WORKSPACE');
  });

  it('refuses a path whose parent directory is a link out', () => {
    expect(codeOf(() => INDEX.resolve('escape-dir/passwd'))).toBe('PATH_OUTSIDE_WORKSPACE');
  });

  it('refuses a relative link that climbs above the workspace', () => {
    expect(codeOf(() => INDEX.resolve('climber.txt'))).toBe('PATH_OUTSIDE_WORKSPACE');
  });

  it('allows a link that stays inside, because real repositories use those', () => {
    const resolved = INDEX.resolve('inside.txt');

    expect(resolved.path).toBe('src/index.ts');
    expect(resolved.followedLinks).toBe(1);
  });

  it('resolves a relative link against the directory holding the link', () => {
    expect(INDEX.resolve('inside-relative.txt').path).toBe('index.ts');
  });

  it('follows a link to a directory and keeps the rest of the path', () => {
    expect(INDEX.resolve('docs-alias/guide.md').path).toBe('docs/guide.md');
  });

  it('reports the workspace root itself as not a file', () => {
    expect(codeOf(() => INDEX.resolve('root-link'))).toBe('PATH_NOT_A_FILE');
  });

  it('gives up on two links pointing at each other', () => {
    expect(codeOf(() => INDEX.resolve('loop-a'))).toBe('PATH_LINK_LOOP');
  });

  it('gives up on a link pointing at itself', () => {
    expect(codeOf(() => INDEX.resolve('self'))).toBe('PATH_LINK_LOOP');
  });

  it('refuses a link into the git directory', () => {
    const index = new WorkspaceIndex([link('sneaky.txt', '/workspace/.git/config')]);

    expect(codeOf(() => index.resolve('sneaky.txt'))).toBe('PATH_INVALID');
  });
});

describe('a repository inside the repository', () => {
  it('refuses anything underneath it', () => {
    expect(codeOf(() => INDEX.resolve('vendor-lib/main.go'))).toBe('PATH_NESTED_REPOSITORY');
  });

  it('lets the folder itself resolve, so it can be reported rather than hidden', () => {
    expect(INDEX.resolve('vendor-lib').kind).toBe('repository');
  });
});

describe('what the resolution reports back', () => {
  it('says whether the resolved path is protected, not the requested one', () => {
    const index = new WorkspaceIndex([
      link('harmless.txt', '.github/workflows/ci.yml'),
      file('.github/workflows/ci.yml'),
    ]);

    expect(index.resolve('harmless.txt').protected).toBe(true);
  });

  it('reports an ordinary file as not protected', () => {
    expect(INDEX.resolve('src/index.ts').protected).toBe(false);
  });

  it('reports a path that does not exist as missing rather than refusing it', () => {
    expect(INDEX.resolve('src/brand-new.ts').kind).toBe('missing');
  });
});

describe('assertReadable', () => {
  it.each([
    ['an environment file', '.env'],
    ['an image', 'logo.png'],
  ])('refuses %s', (_label, path) => {
    expect(
      codeOf(() => {
        assertReadable(INDEX.resolve(path));
      }),
    ).toBe('PATH_IGNORED');
  });

  it('allows ordinary source', () => {
    expect(() => {
      assertReadable(INDEX.resolve('src/index.ts'));
    }).not.toThrow();
  });

  it('allows a protected file to be read, because reading it is not the danger', () => {
    expect(() => {
      assertReadable(INDEX.resolve('package.json'));
    }).not.toThrow();
  });
});

describe('assertRegularFile', () => {
  it('accepts a file', () => {
    expect(() => {
      assertRegularFile(INDEX.resolve('README.md'));
    }).not.toThrow();
  });

  it('refuses a directory', () => {
    expect(
      codeOf(() => {
        assertRegularFile(INDEX.resolve('src'));
      }),
    ).toBe('PATH_NOT_A_FILE');
  });

  it('refuses something that is not there', () => {
    expect(
      codeOf(() => {
        assertRegularFile(INDEX.resolve('nowhere.ts'));
      }),
    ).toBe('FILE_NOT_FOUND');
  });
});
