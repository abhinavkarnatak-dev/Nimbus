import { describe, expect, it } from 'vitest';

import { FakeSandboxProvider, buildSandboxSpec, type Sandbox } from '../../sandbox/index.js';
import { FakeRepositorySource, type FakeRepositoryOptions } from './fake.js';
import { CLONE_LIMITS, TREE_MODES } from './limits.js';
import { planClone, skipReasonFor, type TreeEntry } from './plan.js';
import { emptyStats, type RepositoryReference } from './source.js';

const REFERENCE: RepositoryReference = {
  owner: 'shopfront',
  name: 'web',
  commitSha: 'a'.repeat(40),
  token: 'a token that never leaves the backend',
};

async function emptySandbox(): Promise<Sandbox> {
  const provider = new FakeSandboxProvider({ files: {} });

  return await provider.create(
    buildSandboxSpec(
      { provider: 'fake', maxSeconds: 60, allowInternet: false, templateId: 'test' },
      'ses_aaaaaaaaaaaaaaaaaaaaa',
    ),
  );
}

async function cloneOf(options: FakeRepositoryOptions): Promise<{
  sandbox: Sandbox;
  result: Awaited<ReturnType<FakeRepositorySource['cloneInto']>>;
}> {
  const sandbox = await emptySandbox();
  const source = new FakeRepositorySource(options);

  return { sandbox, result: await source.cloneInto(sandbox, REFERENCE) };
}

function blob(path: string, size = 100): TreeEntry {
  return { path, mode: TREE_MODES.file, type: 'blob', size };
}

describe('what the clone refuses to write', () => {
  it('never writes a credential file into the sandbox', async () => {
    const { sandbox, result } = await cloneOf({
      files: { 'src/a.ts': 'export const a = 1;\n', '.env': 'GEMINI_API_KEY=real\n' },
    });

    const entries = await sandbox.listEntries();

    expect(result.paths).toContain('src/a.ts');
    expect(result.paths).not.toContain('.env');
    expect(entries.map((entry) => entry.path)).not.toContain('.env');
  });

  it('counts why it skipped, so a partial clone is visible', async () => {
    const { result } = await cloneOf({
      files: { 'src/a.ts': 'a\n', '.env': 'x\n' },
    });

    expect(result.stats.skipped.ignored_path).toBe(1);
    expect(result.partial).toBe(true);
  });

  it('never writes a private key', () => {
    expect(skipReasonFor(blob('deploy/id_rsa'), 0, 0)).toBe('ignored_path');
    expect(skipReasonFor(blob('certs/server.pem'), 0, 0)).toBe('ignored_path');
  });

  it('never writes anything out of node_modules or .git', () => {
    expect(skipReasonFor(blob('node_modules/left-pad/index.js'), 0, 0)).toBe('ignored_path');
    expect(skipReasonFor(blob('.git/config'), 0, 0)).toBe('ignored_path');
  });

  it('skips a symlink, because a link can point outside the workspace', () => {
    const link: TreeEntry = { path: 'src/link.ts', mode: TREE_MODES.symlink, type: 'blob' };

    expect(skipReasonFor(link, 0, 0)).toBe('symlink');
  });

  it('skips a submodule, because it is a second repository', () => {
    const nested: TreeEntry = { path: 'vendor/lib', mode: TREE_MODES.submodule, type: 'commit' };

    expect(skipReasonFor(nested, 0, 0)).toBe('submodule');
  });

  it('skips a file larger than one file is allowed to be', () => {
    expect(skipReasonFor(blob('src/huge.ts', CLONE_LIMITS.maxFileBytes + 1), 0, 0)).toBe(
      'too_large',
    );
  });

  it('stops once the whole clone has spent its bytes', () => {
    expect(skipReasonFor(blob('src/a.ts', 1_000), CLONE_LIMITS.maxTotalBytes, 0)).toBe(
      'budget_spent',
    );
  });

  it('stops once it has taken enough files', () => {
    expect(skipReasonFor(blob('src/a.ts', 10), 0, CLONE_LIMITS.maxFiles)).toBe('budget_spent');
  });

  it('takes an ordinary source file', () => {
    expect(skipReasonFor(blob('src/auth/login.ts', 400), 0, 0)).toBeNull();
  });
});

describe('planClone', () => {
  it('keeps the files worth having and counts the rest', () => {
    const plan = planClone([
      blob('src/a.ts'),
      blob('.env'),
      { path: 'src/link.ts', mode: TREE_MODES.symlink, type: 'blob' },
      { path: 'docs', mode: TREE_MODES.directory, type: 'tree' },
    ]);

    expect(plan.files.map((file) => file.path)).toEqual(['src/a.ts']);
    expect(plan.stats.skipped.ignored_path).toBe(1);
    expect(plan.stats.skipped.symlink).toBe(1);
  });

  it('ignores directory entries entirely, they are not files', () => {
    const plan = planClone([{ path: 'src', mode: TREE_MODES.directory, type: 'tree' }]);

    expect(plan.files).toEqual([]);
    expect(plan.stats).toEqual(emptyStats());
  });

  it('stops adding once the total is spent, and says so', () => {
    const each = CLONE_LIMITS.maxFileBytes;
    const fit = Math.floor(CLONE_LIMITS.maxTotalBytes / each);
    const entries = Array.from({ length: fit + 3 }, (_unused, index) =>
      blob(`src/file${String(index)}.ts`, each),
    );

    const plan = planClone(entries);

    expect(plan.files).toHaveLength(fit);
    expect(plan.stats.skipped.budget_spent).toBe(3);
  });

  it('skips a single file too big for the per file limit before any budget', () => {
    const plan = planClone([blob('src/huge.ts', CLONE_LIMITS.maxFileBytes + 1)]);

    expect(plan.files).toEqual([]);
    expect(plan.stats.skipped.too_large).toBe(1);
    expect(plan.stats.skipped.budget_spent).toBe(0);
  });
});

describe('the clone itself', () => {
  it('writes every readable file at the commit it was asked for', async () => {
    const { sandbox, result } = await cloneOf({
      files: { 'src/a.ts': 'export const a = 1;\n', 'README.md': '# hello\n' },
    });

    const entries = (await sandbox.listEntries()).map((entry) => entry.path);

    expect(result.commitSha).toBe(REFERENCE.commitSha);
    expect(entries).toContain('src/a.ts');
    expect(entries).toContain('README.md');
  });

  it('writes the contents, not just the names', async () => {
    const { sandbox } = await cloneOf({ files: { 'src/a.ts': 'export const a = 1;\n' } });

    expect(await sandbox.readFile('src/a.ts')).toBe('export const a = 1;\n');
  });

  it('reports what it wrote', async () => {
    const { result } = await cloneOf({ files: { 'src/a.ts': 'a\n', 'src/b.ts': 'b\n' } });

    expect(result.stats.filesWritten).toBe(2);
    expect(result.stats.bytesWritten).toBeGreaterThan(0);
    expect(result.partial).toBe(false);
  });

  it('refuses a truncated listing rather than cloning half a repository', async () => {
    const source = new FakeRepositorySource({ files: { 'src/a.ts': 'a\n' }, truncated: true });

    await expect(source.cloneInto(await emptySandbox(), REFERENCE)).rejects.toThrow(
      expect.objectContaining({ code: 'CLONE_TREE_TRUNCATED' }) as Error,
    );
  });

  it('says plainly when the commit is not there', async () => {
    const source = new FakeRepositorySource({ files: {}, missing: true });

    await expect(source.cloneInto(await emptySandbox(), REFERENCE)).rejects.toThrow(
      expect.objectContaining({ code: 'CLONE_COMMIT_NOT_FOUND' }) as Error,
    );
  });

  it('is handed a token, and the sandbox never sees it', async () => {
    const source = new FakeRepositorySource({ files: { 'src/a.ts': 'a\n' } });
    const sandbox = await emptySandbox();

    await source.cloneInto(sandbox, REFERENCE);

    for (const entry of await sandbox.listEntries()) {
      if (entry.kind !== 'file') {
        continue;
      }
      expect(await sandbox.readFile(entry.path)).not.toContain(REFERENCE.token);
    }
  });

  it('records which commit it was asked for, so a test can check', async () => {
    const source = new FakeRepositorySource({ files: { 'src/a.ts': 'a\n' } });

    await source.cloneInto(await emptySandbox(), REFERENCE);

    expect(source.calls[0]?.commitSha).toBe(REFERENCE.commitSha);
  });
});
