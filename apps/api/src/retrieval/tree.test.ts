import { describe, expect, it } from 'vitest';

import type { WorkspaceEntry } from '../sandbox/index.js';
import { RETRIEVAL_LIMITS } from './limits.js';
import { summarizeTree } from './tree.js';

function files(...paths: string[]): WorkspaceEntry[] {
  return paths.map((path) => ({ path, kind: 'file', size: 100, target: null }));
}

describe('summarizeTree', () => {
  it('shows directories with a count and the kinds of file inside', () => {
    const summary = summarizeTree(files('src/a.ts', 'src/b.ts', 'src/c.ts'));
    expect(summary.text).toContain('src/');
    expect(summary.text).toContain('3 files');
    expect(summary.text).toContain('ts');
  });

  it('says file rather than files when there is one', () => {
    expect(summarizeTree(files('src/a.ts')).text).toContain('1 file');
  });

  it('lists the files in a small directory', () => {
    const summary = summarizeTree(files('src/auth/login.ts', 'src/auth/session.ts'));
    expect(summary.text).toContain('login.ts');
    expect(summary.text).toContain('session.ts');
  });

  it('gives a count instead of a list for a crowded directory', () => {
    const many = Array.from(
      { length: RETRIEVAL_LIMITS.treeExpandMaxFiles + 5 },
      (_value, index) => `src/file${String(index)}.ts`,
    );

    const summary = summarizeTree(files(...many));
    expect(summary.text).toContain('files here');
    expect(summary.text).not.toContain('file0.ts');
  });

  it('leaves out everything the policy keeps out', () => {
    const summary = summarizeTree(
      files(
        'src/a.ts',
        '.env',
        'node_modules/left-pad/index.js',
        'credentials.json',
        'dist/bundle.js',
      ),
    );

    expect(summary.text).not.toContain('.env');
    expect(summary.text).not.toContain('node_modules');
    expect(summary.text).not.toContain('credentials');
    expect(summary.text).not.toContain('dist');
    expect(summary.files).toBe(1);
    expect(summary.hidden).toBe(4);
  });

  it('leaves out a nested repository', () => {
    const entries: WorkspaceEntry[] = [
      ...files('src/a.ts', 'other/thing.ts'),
      { path: 'other', kind: 'repository', size: 0, target: null },
    ];

    const summary = summarizeTree(entries);
    expect(summary.text).not.toContain('thing.ts');
    expect(summary.files).toBe(1);
  });

  it('leaves out links, because retrieval only reads regular files', () => {
    const entries: WorkspaceEntry[] = [
      ...files('src/a.ts'),
      { path: 'shortcut.ts', kind: 'symlink', size: 0, target: 'src/a.ts' },
    ];

    expect(summarizeTree(entries).text).not.toContain('shortcut.ts');
  });

  it('stops at its depth limit', () => {
    const deep = `${Array.from({ length: 20 }, (_value, index) => `d${String(index)}`).join('/')}/a.ts`;
    const summary = summarizeTree(files(deep));

    expect(summary.text).not.toContain('d19');
    expect(summary.text).toContain('d0/');
  });

  it('stops at its line limit and says so', () => {
    const wide = Array.from({ length: 400 }, (_value, index) => `src/dir${String(index)}/file.ts`);

    const summary = summarizeTree(files(...wide));
    expect(summary.lines.length).toBeLessThanOrEqual(RETRIEVAL_LIMITS.treeMaxLines);
    expect(summary.truncated).toBe(true);
  });

  it('stops at its character limit, not only its line limit', () => {
    const longNames = Array.from(
      { length: 200 },
      (_value, index) => `src/area${String(index)}/${'a'.repeat(120)}.ts`,
    );

    const summary = summarizeTree(files(...longNames));

    expect(summary.text.length).toBeLessThanOrEqual(RETRIEVAL_LIMITS.treeMaxChars);
    expect(summary.lines.length).toBeLessThan(RETRIEVAL_LIMITS.treeMaxLines);
    expect(summary.truncated).toBe(true);
  });

  it('names the files of a repository the size this one actually is', () => {
    const areas = ['auth', 'agent', 'events', 'orchestrator', 'retrieval', 'routing', 'sessions'];
    const paths = areas.flatMap((area) =>
      Array.from(
        { length: 14 },
        (_value, index) => `apps/api/src/${area}/thing${String(index)}.ts`,
      ),
    );

    const summary = summarizeTree(files(...paths, 'apps/api/src/auth/otp-service.ts'));

    expect(summary.truncated).toBe(false);
    expect(summary.text).toContain('otp-service.ts');
    expect(summary.text).not.toContain('files here');
  });

  it('counts directories', () => {
    const summary = summarizeTree(files('src/auth/login.ts', 'src/http/router.ts', 'README.md'));
    expect(summary.directories).toBe(3);
  });

  it('handles an empty workspace', () => {
    const summary = summarizeTree([]);
    expect(summary.text).toBe('');
    expect(summary.files).toBe(0);
    expect(summary.hidden).toBe(0);
    expect(summary.truncated).toBe(false);
  });

  it('is the same every time', () => {
    const entries = files('src/b.ts', 'src/a.ts', 'docs/z.md');
    expect(summarizeTree(entries).text).toBe(summarizeTree([...entries].reverse()).text);
  });
});
