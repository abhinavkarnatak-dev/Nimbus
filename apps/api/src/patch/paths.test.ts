import { describe, expect, it } from 'vitest';

import {
  hasTraversal,
  isAbsolutePath,
  isNestedRepository,
  isSubmoduleFile,
  touchesGitDirectory,
} from './paths.js';

describe('isAbsolutePath', () => {
  const absolute = ['/etc/passwd', '\\windows\\system32', 'C:/Windows', 'c:\\Windows'];
  const relative = ['src/app.ts', './src/app.ts', 'a/b/c.ts', 'C.ts'];

  for (const path of absolute) {
    it(`treats ${path} as absolute`, () => {
      expect(isAbsolutePath(path)).toBe(true);
    });
  }

  for (const path of relative) {
    it(`treats ${path} as relative`, () => {
      expect(isAbsolutePath(path)).toBe(false);
    });
  }
});

describe('hasTraversal', () => {
  it('spots a climb with forward slashes', () => {
    expect(hasTraversal('../../etc/passwd')).toBe(true);
    expect(hasTraversal('src/../../secrets')).toBe(true);
  });

  it('spots a climb with backslashes', () => {
    expect(hasTraversal('..\\..\\etc\\passwd')).toBe(true);
  });

  it('leaves a file whose name merely starts with dots alone', () => {
    expect(hasTraversal('src/..hidden.ts')).toBe(false);
    expect(hasTraversal('src/app.ts')).toBe(false);
  });
});

describe('touchesGitDirectory and isNestedRepository', () => {
  it('separates our own git directory from a second one', () => {
    expect(touchesGitDirectory('.git/hooks/pre-commit')).toBe(true);
    expect(isNestedRepository('.git/hooks/pre-commit')).toBe(false);

    expect(touchesGitDirectory('vendor/thing/.git/config')).toBe(false);
    expect(isNestedRepository('vendor/thing/.git/config')).toBe(true);
  });

  it('leaves ordinary dot files alone', () => {
    expect(touchesGitDirectory('.gitignore')).toBe(false);
    expect(isNestedRepository('src/.gitkeep')).toBe(false);
  });
});

describe('isSubmoduleFile', () => {
  it('spots the submodule list wherever it sits', () => {
    expect(isSubmoduleFile('.gitmodules')).toBe(true);
    expect(isSubmoduleFile('nested/.gitmodules')).toBe(true);
  });

  it('leaves a similar name alone', () => {
    expect(isSubmoduleFile('.gitmodules.bak')).toBe(false);
    expect(isSubmoduleFile('gitmodules')).toBe(false);
  });
});
