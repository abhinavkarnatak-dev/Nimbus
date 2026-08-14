import { describe, expect, it } from 'vitest';

import { type FakeSandbox, FakeSandboxProvider, commandKey } from './fake-provider.js';
import { SANDBOX_LIMITS } from './limits.js';
import { SandboxError, type Sandbox } from './provider.js';
import { testSpec } from './sandbox.fixtures.js';

async function codeOf(work: () => Promise<unknown>): Promise<string> {
  try {
    await work();
  } catch (error) {
    return error instanceof SandboxError ? error.code : 'NOT_A_SANDBOX_ERROR';
  }
  return 'NO_ERROR';
}

async function ready(
  provider: FakeSandboxProvider,
  overrides: Parameters<typeof testSpec>[0] = {},
): Promise<Sandbox> {
  return await provider.create(testSpec(overrides));
}

describe('creating a sandbox', () => {
  it('hands back a ready sandbox with its own identifier', async () => {
    const provider = new FakeSandboxProvider();
    const first = await ready(provider);
    const second = await ready(provider);

    expect(first.status().state).toBe('ready');
    expect(first.sandboxId).toMatch(/^sbx_[0-9A-Za-z_-]{21}$/);
    expect(second.sandboxId).not.toBe(first.sandboxId);
  });

  it('sets a deadline from the requested lifetime', async () => {
    const sandbox = await ready(new FakeSandboxProvider(), { maxSeconds: 60 });
    const status = sandbox.status();

    expect(status.deadlineAt.getTime() - status.createdAt.getTime()).toBe(60_000);
    expect(status.remainingMs).toBeGreaterThan(59_000);
  });

  it('refuses before creating anything when the spec carries a credential', async () => {
    const provider = new FakeSandboxProvider();
    const code = await codeOf(async () =>
      provider.create(testSpec({ env: { GITHUB_TOKEN: 'ghs_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' } })),
    );

    expect(code).toBe('SANDBOX_CREDENTIAL_REFUSED');
    expect(provider.created).toHaveLength(0);
  });

  it('can be made to fail on demand', async () => {
    const provider = new FakeSandboxProvider({
      createFails: new SandboxError('SANDBOX_CREATE_FAILED', 'No capacity.'),
    });

    expect(await codeOf(async () => provider.create(testSpec()))).toBe('SANDBOX_CREATE_FAILED');
    expect(provider.created).toHaveLength(0);
  });

  it('gives each sandbox its own workspace with nothing left over from the last one', async () => {
    const provider = new FakeSandboxProvider({ files: { 'a.txt': 'seeded' } });
    const first = await ready(provider);
    await first.writeFile('scratch.txt', 'left behind');

    const second = await ready(provider);

    expect(await second.readFile('a.txt')).toBe('seeded');
    expect(await codeOf(async () => second.readFile('scratch.txt'))).toBe('SANDBOX_FILE_NOT_FOUND');
  });

  it('records the spec it was asked for without keeping a live reference to it', async () => {
    const provider = new FakeSandboxProvider();
    const spec = testSpec();
    await provider.create(spec);
    spec.env = { CI: 'tampered' };

    expect(provider.specs[0]?.env).toEqual({ CI: 'true', NODE_ENV: 'test' });
  });
});

describe('running a command', () => {
  it('returns the scripted output and counts as a successful run', async () => {
    const provider = new FakeSandboxProvider({
      commands: { 'git status': { stdout: 'clean\n', exitCode: 0 } },
    });
    const sandbox = await ready(provider);
    const result = await sandbox.execute({ argv: ['git', 'status'] });

    expect(result).toMatchObject({
      outcome: 'succeeded',
      exitCode: 0,
      stdout: 'clean\n',
      truncated: false,
      timedOut: false,
    });
    expect(sandbox.status().commandsRun).toBe(1);
  });

  it('reports a non zero exit as failed rather than throwing', async () => {
    const provider = new FakeSandboxProvider({
      commands: { 'npm test': { stderr: '1 failing\n', exitCode: 1 } },
    });
    const result = await (await ready(provider)).execute({ argv: ['npm', 'test'] });

    expect(result.outcome).toBe('failed');
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe('1 failing\n');
  });

  it('falls back to the default command for anything unscripted', async () => {
    const provider = new FakeSandboxProvider({ defaultCommand: { stdout: 'ok', exitCode: 0 } });
    const result = await (await ready(provider)).execute({ argv: ['anything', 'at', 'all'] });

    expect(result.stdout).toBe('ok');
  });

  it('checks the command before running it', async () => {
    const sandbox = await ready(new FakeSandboxProvider());

    expect(await codeOf(async () => sandbox.execute({ argv: [] }))).toBe('SANDBOX_COMMAND_INVALID');
    expect(sandbox.status().commandsRun).toBe(0);
  });

  it('surfaces a scripted failure as a sandbox error', async () => {
    const provider = new FakeSandboxProvider({
      commands: { boom: { fails: new SandboxError('SANDBOX_NOT_READY', 'Gone.') } },
    });

    expect(await codeOf(async () => (await ready(provider)).execute({ argv: ['boom'] }))).toBe(
      'SANDBOX_NOT_READY',
    );
  });

  it('applies the file changes a command was scripted to make', async () => {
    const provider = new FakeSandboxProvider({
      files: { 'a.txt': 'one\n', 'old.txt': 'bye\n' },
      commands: {
        'apply changes': { writes: { 'a.txt': 'two\n', 'new.txt': 'hi\n' }, deletes: ['old.txt'] },
      },
    });
    const sandbox = await ready(provider);
    await sandbox.execute({ argv: ['apply', 'changes'] });

    expect(await sandbox.readFile('a.txt')).toBe('two\n');
    expect(await sandbox.readFile('new.txt')).toBe('hi\n');
    expect(await codeOf(async () => sandbox.readFile('old.txt'))).toBe('SANDBOX_FILE_NOT_FOUND');
  });
});

describe('time limits', () => {
  it('kills a command that would run past its own limit', async () => {
    const provider = new FakeSandboxProvider({ commands: { hang: { hangs: true } } });
    const sandbox = await ready(provider);
    const result = await sandbox.execute({ argv: ['hang'], timeoutMs: 5_000 });

    expect(result).toMatchObject({
      outcome: 'timed_out',
      exitCode: null,
      timedOut: true,
      durationMs: 5_000,
    });
  });

  it('lets a command finish when it fits inside its limit', async () => {
    const provider = new FakeSandboxProvider({
      commands: { slow: { durationMs: 4_000, stdout: 'done' } },
    });
    const result = await (await ready(provider)).execute({ argv: ['slow'], timeoutMs: 5_000 });

    expect(result.outcome).toBe('succeeded');
    expect(result.durationMs).toBe(4_000);
  });

  it('spends the session budget even when a command is killed', async () => {
    const provider = new FakeSandboxProvider({ commands: { hang: { hangs: true } } });
    const sandbox = await ready(provider, { maxSeconds: 30 });

    await sandbox.execute({ argv: ['hang'], timeoutMs: 20_000 });

    expect(sandbox.status().remainingMs).toBeLessThan(10_100);
    expect(sandbox.status().remainingMs).toBeGreaterThan(9_000);
  });

  it('refuses a new command once the session deadline has passed', async () => {
    const provider = new FakeSandboxProvider({ commands: { hang: { hangs: true } } });
    const sandbox = await ready(provider, { maxSeconds: 10 });

    await sandbox.execute({ argv: ['hang'], timeoutMs: 5_000 });
    await sandbox.execute({ argv: ['hang'], timeoutMs: 5_000 });

    expect(await codeOf(async () => sandbox.execute({ argv: ['hang'] }))).toBe('SANDBOX_EXPIRED');
  });

  it('shrinks a command limit to whatever is left of the session', async () => {
    const provider = new FakeSandboxProvider({ commands: { hang: { hangs: true } } });
    const sandbox = await ready(provider, { maxSeconds: 30 });

    const result = await sandbox.execute({
      argv: ['hang'],
      timeoutMs: SANDBOX_LIMITS.maxCommandTimeoutMs,
    });

    expect(result.durationMs).toBeLessThanOrEqual(30_000);
    expect(result.durationMs).toBeGreaterThan(29_000);
  });
});

describe('cancellation', () => {
  it('refuses to start when the signal is already raised, and destroys the sandbox', async () => {
    const provider = new FakeSandboxProvider();
    const sandbox = await ready(provider);
    const controller = new AbortController();
    controller.abort();

    const result = await sandbox.execute({ argv: ['git', 'status'], signal: controller.signal });

    expect(result.outcome).toBe('cancelled');
    expect(sandbox.status().state).toBe('terminated');
    expect(sandbox.status().terminationReason).toBe('cancelled');
  });

  it('stops a command already in flight and destroys the sandbox with it', async () => {
    const controller = new AbortController();
    const provider = new FakeSandboxProvider({
      commands: { hang: { hangs: true } },
      onCommandStarted: () => {
        controller.abort();
      },
    });
    const sandbox = await ready(provider);

    const result = await sandbox.execute({ argv: ['hang'], signal: controller.signal });

    expect(result.outcome).toBe('cancelled');
    expect(result.timedOut).toBe(false);
    expect(sandbox.status().state).toBe('terminated');
  });

  it('leaves nothing runnable after a cancellation', async () => {
    const controller = new AbortController();
    controller.abort();
    const sandbox = await ready(new FakeSandboxProvider());
    await sandbox.execute({ argv: ['x'], signal: controller.signal });

    expect(await codeOf(async () => sandbox.execute({ argv: ['y'] }))).toBe('SANDBOX_NOT_READY');
  });
});

describe('output limits', () => {
  it('truncates output at the cap and says so', async () => {
    const provider = new FakeSandboxProvider({
      commands: { flood: { stdout: 'a'.repeat(SANDBOX_LIMITS.outputMaxBytes + 5_000) } },
    });
    const result = await (await ready(provider)).execute({ argv: ['flood'] });

    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.stdout, 'utf8')).toBe(SANDBOX_LIMITS.outputMaxBytes);
  });

  it('never silently drops output, so a caller always knows it was cut', async () => {
    const provider = new FakeSandboxProvider({
      commands: { small: { stdout: 'short' } },
    });
    const result = await (await ready(provider)).execute({ argv: ['small'] });

    expect(result.truncated).toBe(false);
    expect(result.stdout).toBe('short');
  });

  it('shares one budget across the whole session rather than per command', async () => {
    const half = 'a'.repeat(Math.floor(SANDBOX_LIMITS.outputMaxBytes / 2) + 1);
    const provider = new FakeSandboxProvider({ defaultCommand: { stdout: half } });
    const sandbox = await ready(provider);

    const first = await sandbox.execute({ argv: ['one'] });
    const second = await sandbox.execute({ argv: ['two'] });

    expect(first.truncated).toBe(false);
    expect(second.truncated).toBe(true);
    expect(sandbox.status().outputBytesUsed).toBe(SANDBOX_LIMITS.outputMaxBytes);
  });

  it('counts standard error against the same budget', async () => {
    const provider = new FakeSandboxProvider({
      commands: {
        noisy: {
          stdout: 'a'.repeat(SANDBOX_LIMITS.outputMaxBytes),
          stderr: 'b'.repeat(1_000),
        },
      },
    });
    const result = await (await ready(provider)).execute({ argv: ['noisy'] });

    expect(result.stderr).toBe('');
    expect(result.truncated).toBe(true);
  });
});

describe('exporting a patch', () => {
  it('produces nothing when the workspace was not touched', async () => {
    const provider = new FakeSandboxProvider({ files: { 'a.txt': 'one\n' } });
    const patch = await (await ready(provider)).exportPatch();

    expect(patch.patch).toBe('');
    expect(patch.files).toEqual([]);
  });

  it('describes what the work changed', async () => {
    const provider = new FakeSandboxProvider({ files: { 'a.txt': 'one\n' } });
    const sandbox = await ready(provider);
    await sandbox.writeFile('a.txt', 'two\n');
    await sandbox.writeFile('b.txt', 'new\n');

    const patch = await sandbox.exportPatch();

    expect(patch.files.map((file) => file.changeKind)).toEqual(['modified', 'added']);
    expect(patch.patch).toContain('--- a/a.txt');
    expect(patch.patch).toContain('new file mode 100644');
    expect(patch.bytes).toBeGreaterThan(0);
  });

  it('carries no credential of any kind, because there was never one to carry', async () => {
    const provider = new FakeSandboxProvider({ files: { 'a.txt': 'one\n' } });
    const sandbox = await ready(provider);
    await sandbox.writeFile('a.txt', 'two\n');

    const patch = await sandbox.exportPatch();

    expect(patch.patch).not.toMatch(/ghs_|ghp_|Bearer |mongodb:\/\/|redis:\/\//);
  });
});

describe('marking a baseline', () => {
  it('makes everything written so far count as unchanged', async () => {
    const provider = new FakeSandboxProvider({ files: {} });
    const sandbox = await ready(provider);

    await sandbox.writeFile('a.txt', 'one\n');
    await sandbox.writeFile('b.txt', 'two\n');
    await sandbox.markBaseline();

    expect((await sandbox.exportPatch()).files).toEqual([]);
  });

  it('still reports what changed afterwards', async () => {
    const provider = new FakeSandboxProvider({ files: {} });
    const sandbox = await ready(provider);

    await sandbox.writeFile('a.txt', 'one\n');
    await sandbox.markBaseline();
    await sandbox.writeFile('a.txt', 'two\n');

    const patch = await sandbox.exportPatch();

    expect(patch.files.map((file) => file.path)).toEqual(['a.txt']);
    expect(patch.files[0]?.changeKind).toBe('modified');
  });

  it('forgets a baseline that was seeded before it', async () => {
    const provider = new FakeSandboxProvider({ files: { 'old.txt': 'gone\n' } });
    const sandbox = await ready(provider);

    await sandbox.writeFile('new.txt', 'here\n');
    await sandbox.markBaseline();
    await sandbox.writeFile('new.txt', 'changed\n');

    const patch = await sandbox.exportPatch();

    expect(patch.files.map((file) => file.path)).toEqual(['new.txt']);
  });

  it('refuses once the sandbox is gone', async () => {
    const provider = new FakeSandboxProvider({ files: {} });
    const sandbox = await ready(provider);

    await sandbox.terminate('completed');

    expect(await codeOf(async () => sandbox.markBaseline())).toBe('SANDBOX_NOT_READY');
  });
});

describe('destroying a sandbox', () => {
  it('moves to terminated and remembers why', async () => {
    const sandbox = await ready(new FakeSandboxProvider());
    await sandbox.terminate('completed');

    const status = sandbox.status();

    expect(status.state).toBe('terminated');
    expect(status.terminationReason).toBe('completed');
    expect(status.terminatedAt).toBeInstanceOf(Date);
  });

  it('can be asked twice without changing the answer', async () => {
    const sandbox = await ready(new FakeSandboxProvider());
    await sandbox.terminate('completed');
    const first = sandbox.status().terminatedAt;
    await sandbox.terminate('cancelled');

    expect(sandbox.status().terminationReason).toBe('completed');
    expect(sandbox.status().terminatedAt).toBe(first);
  });

  it.each([
    ['running a command', async (sandbox: Sandbox) => sandbox.execute({ argv: ['git'] })],
    ['reading a file', async (sandbox: Sandbox) => sandbox.readFile('a.txt')],
    ['writing a file', async (sandbox: Sandbox) => sandbox.writeFile('a.txt', 'x')],
    ['exporting a patch', async (sandbox: Sandbox) => sandbox.exportPatch()],
  ])('refuses %s once it is gone', async (_label, operation) => {
    const sandbox = await ready(new FakeSandboxProvider({ files: { 'a.txt': 'one\n' } }));
    await sandbox.terminate('completed');

    expect(await codeOf(async () => operation(sandbox))).toBe('SANDBOX_NOT_READY');
  });

  it('throws away the workspace so nothing survives it', async () => {
    const provider = new FakeSandboxProvider({ files: { 'a.txt': 'secret work\n' } });
    const sandbox = (await ready(provider)) as FakeSandbox;
    await sandbox.terminate('completed');

    expect(sandbox.listFiles()).toEqual([]);
  });

  it('lands in the failed state when destroying itself goes wrong', async () => {
    const provider = new FakeSandboxProvider({ terminateFails: new Error('provider unreachable') });
    const sandbox = await ready(provider);

    await expect(sandbox.terminate('completed')).rejects.toThrow('provider unreachable');
    expect(sandbox.status().state).toBe('failed');
  });

  it('is not counted as live once it is gone', async () => {
    const provider = new FakeSandboxProvider();
    const first = await ready(provider);
    await ready(provider);

    expect(provider.liveCount).toBe(2);
    await first.terminate('completed');
    expect(provider.liveCount).toBe(1);
  });
});

describe('commandKey', () => {
  it('joins the words so a script can be looked up', () => {
    expect(commandKey(['git', 'status', '--porcelain'])).toBe('git status --porcelain');
  });
});
