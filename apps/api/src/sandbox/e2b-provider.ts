import type { E2bClient, E2bEntry, E2bHandle, E2bRunResult } from './e2b-client.js';
import { assertEgressSeconds, closedNetwork, openedNetwork } from './egress.js';
import {
  GIT_EXPORT_DIFF,
  GIT_IS_REPOSITORY,
  GIT_MARK_NEW_FILES,
  buildGitPatchExport,
} from './git-patch.js';
import { SANDBOX_LIMITS } from './limits.js';
import {
  SandboxError,
  TERMINAL_STATES,
  assertUsable,
  assertValidArgv,
  assertValidSpec,
  resolveTimeout,
  truncateToBytes,
  type CommandRequest,
  type CommandResult,
  type PatchExport,
  type Sandbox,
  type SandboxProvider,
  type SandboxSpec,
  type SandboxState,
  type SandboxStatus,
  type SandboxTerminationReason,
  type WorkspaceEntry,
} from './provider.js';
import { buildShellCommand } from './shell.js';
import { normalizeWorkspacePath } from './workspace.js';

export const E2B_PROVIDER_NAME = 'e2b';
export const SECURED_CONTROLLER_ACCESS = true;
export const INTERNET_ACCESS = false;
export const ON_DEADLINE = 'kill';
export const OWNER_TAG = 'nimbus';
export const LIST_DEPTH = 12;
export const ROOT_DIR = '/';

export const SANDBOX_USER = 'user';
export const METADATA_ADDRESS = '169.254.169.254';

export const SANDBOX_SETUP: readonly (readonly string[])[] = [
  ['mkdir', '-p', '--', SANDBOX_LIMITS.workspaceDir],
  ['chown', '-R', `${SANDBOX_USER}:${SANDBOX_USER}`, '--', SANDBOX_LIMITS.workspaceDir],
  ['/usr/sbin/iptables', '-A', 'OUTPUT', '-d', METADATA_ADDRESS, '-j', 'DROP'],
];

export interface E2bMetadata extends Record<string, string> {
  owner: string;
  sessionId: string;
}

export function ownerQuery(): Readonly<Record<string, string>> {
  return { owner: OWNER_TAG };
}

function buildMetadata(spec: SandboxSpec): E2bMetadata {
  return { owner: OWNER_TAG, sessionId: spec.sessionId };
}

const GIT_DIRECTORY = '.git';

function relativeToWorkspace(absolute: string): string | null {
  const root = `${SANDBOX_LIMITS.workspaceDir}/`;
  if (!absolute.startsWith(root)) {
    return null;
  }

  const relative = absolute.slice(root.length);
  return relative === '' ? null : relative;
}

function toWorkspacePath(absolute: string): string | null {
  const relative = relativeToWorkspace(absolute);
  if (relative === null) {
    return null;
  }

  try {
    return normalizeWorkspacePath(relative);
  } catch {
    return null;
  }
}

export function findRepositories(entries: readonly E2bEntry[]): Set<string> {
  const repositories = new Set<string>();

  for (const entry of entries) {
    if (entry.type !== 'dir') {
      continue;
    }

    const relative = relativeToWorkspace(entry.path);
    if (relative === null) {
      continue;
    }

    const segments = relative.split('/');
    if (segments[segments.length - 1] !== GIT_DIRECTORY) {
      continue;
    }

    const parent = segments.slice(0, -1).join('/');
    if (parent !== '') {
      repositories.add(parent);
    }
  }

  return repositories;
}

function toWorkspaceEntry(
  entry: E2bEntry,
  repositories: ReadonlySet<string>,
): WorkspaceEntry | null {
  const path = toWorkspacePath(entry.path);
  if (path === null) {
    return null;
  }

  if (entry.type === 'symlink') {
    return { path, kind: 'symlink', size: 0, target: entry.symlinkTarget ?? '' };
  }

  if (entry.type === 'dir') {
    return {
      path,
      kind: repositories.has(path) ? 'repository' : 'directory',
      size: 0,
      target: null,
    };
  }

  return { path, kind: 'file', size: entry.size, target: null };
}

function outcomeOf(result: E2bRunResult): CommandResult['outcome'] {
  if (result.outcome === 'timed_out') {
    return 'timed_out';
  }
  if (result.outcome === 'cancelled') {
    return 'cancelled';
  }
  return result.exitCode === 0 ? 'succeeded' : 'failed';
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

export class E2bSandbox implements Sandbox {
  readonly sandboxId: string;

  private readonly handle: E2bHandle;
  private readonly createdAt: Date;
  private readonly lifetimeMs: number;
  private readonly now: () => number;

  private state: SandboxState = 'ready';
  private commandsRun = 0;
  private outputBytesUsed = 0;
  private terminatedAt: Date | null = null;
  private terminationReason: SandboxTerminationReason | null = null;
  private egressOpen = false;

  constructor(handle: E2bHandle, spec: SandboxSpec, now: () => number = Date.now) {
    this.handle = handle;
    this.sandboxId = handle.sandboxId;
    this.now = now;
    this.createdAt = new Date(now());
    this.lifetimeMs = spec.maxSeconds * 1_000;
  }

  status(): SandboxStatus {
    return {
      sandboxId: this.sandboxId,
      state: this.state,
      createdAt: this.createdAt,
      deadlineAt: new Date(this.createdAt.getTime() + this.lifetimeMs),
      remainingMs: this.remainingMs(),
      commandsRun: this.commandsRun,
      outputBytesUsed: this.outputBytesUsed,
      terminatedAt: this.terminatedAt,
      terminationReason: this.terminationReason,
    };
  }

  async execute(request: CommandRequest): Promise<CommandResult> {
    assertUsable(this.status());
    assertValidArgv(request.argv);

    const timeoutMs = resolveTimeout(request.timeoutMs, this.remainingMs());
    const cwd = this.resolveCwd(request.cwd);
    const command = buildShellCommand(request.argv);

    if (isAborted(request.signal)) {
      return this.cancelled(0);
    }

    this.commandsRun += 1;
    const startedAt = this.now();

    const result = await this.handle.run(command, {
      cwd,
      timeoutMs,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    });

    const durationMs = Math.max(0, this.now() - startedAt);

    if (result.outcome === 'cancelled' || isAborted(request.signal)) {
      return this.cancelled(durationMs);
    }

    const budget = Math.max(0, SANDBOX_LIMITS.outputMaxBytes - this.outputBytesUsed);
    const stdout = truncateToBytes(result.stdout, budget);
    const stderr = truncateToBytes(
      result.stderr,
      Math.max(0, budget - Buffer.byteLength(stdout.text, 'utf8')),
    );

    this.outputBytesUsed +=
      Buffer.byteLength(stdout.text, 'utf8') + Buffer.byteLength(stderr.text, 'utf8');

    return {
      outcome: outcomeOf(result),
      exitCode: result.exitCode,
      stdout: stdout.text,
      stderr: stderr.text,
      truncated: stdout.truncated || stderr.truncated,
      durationMs,
      timedOut: result.outcome === 'timed_out',
    };
  }

  async listEntries(): Promise<WorkspaceEntry[]> {
    assertUsable(this.status());

    const found = await this.handle.list(SANDBOX_LIMITS.workspaceDir, LIST_DEPTH);
    const repositories = findRepositories(found);
    const entries = new Map<string, WorkspaceEntry>();

    for (const entry of found) {
      const mapped = toWorkspaceEntry(entry, repositories);
      if (mapped !== null) {
        entries.set(mapped.path, mapped);
      }

      if (entries.size > SANDBOX_LIMITS.maxWorkspaceFiles) {
        throw new SandboxError('SANDBOX_WORKSPACE_FULL', 'The workspace holds too many files.');
      }
    }

    for (const path of repositories) {
      if (!entries.has(path)) {
        entries.set(path, { path, kind: 'repository', size: 0, target: null });
      }
    }

    return [...entries.values()].sort((left, right) => left.path.localeCompare(right.path));
  }

  async readFile(path: string): Promise<string> {
    assertUsable(this.status());
    const contents = await this.handle.read(this.absolute(path));

    if (Buffer.byteLength(contents, 'utf8') > SANDBOX_LIMITS.fileMaxBytes) {
      throw new SandboxError('SANDBOX_FILE_TOO_LARGE', 'That file is too large to read.');
    }

    return contents;
  }

  async writeFile(path: string, contents: string): Promise<void> {
    assertUsable(this.status());

    if (Buffer.byteLength(contents, 'utf8') > SANDBOX_LIMITS.fileMaxBytes) {
      throw new SandboxError('SANDBOX_FILE_TOO_LARGE', 'That file is too large to write.');
    }

    await this.handle.write(this.absolute(path), contents);
  }

  async exportPatch(): Promise<PatchExport> {
    assertUsable(this.status());

    const inside = await this.runInternally(GIT_IS_REPOSITORY);
    if (inside.exitCode !== 0 || inside.stdout.trim() !== 'true') {
      throw new SandboxError('SANDBOX_PATCH_FAILED', 'The workspace does not hold a repository.');
    }

    const marked = await this.runInternally(GIT_MARK_NEW_FILES);
    if (marked.exitCode !== 0) {
      throw new SandboxError('SANDBOX_PATCH_FAILED', 'The changes could not be prepared.');
    }

    const diff = await this.runInternally(GIT_EXPORT_DIFF);
    if (diff.exitCode !== 0) {
      throw new SandboxError('SANDBOX_PATCH_FAILED', 'The changes could not be read.');
    }

    return buildGitPatchExport(diff.stdout);
  }

  async withEgress<T>(
    hosts: readonly string[],
    seconds: number,
    work: () => Promise<T>,
  ): Promise<T> {
    assertUsable(this.status());
    assertEgressSeconds(seconds);

    if (this.egressOpen) {
      throw new SandboxError('SANDBOX_EGRESS_REFUSED', 'A network window is already open.');
    }

    const opened = openedNetwork(hosts);
    this.egressOpen = true;

    try {
      await this.handle.updateNetwork(opened);
      return await work();
    } finally {
      this.egressOpen = false;
      await this.closeEgress();
    }
  }

  async terminate(reason: SandboxTerminationReason): Promise<void> {
    if (TERMINAL_STATES.includes(this.state)) {
      return;
    }

    this.state = 'terminating';

    try {
      await this.handle.kill();
    } catch (error) {
      this.state = 'failed';
      this.terminatedAt = new Date(this.now());
      this.terminationReason = 'failed';
      throw error;
    }

    this.state = 'terminated';
    this.terminatedAt = new Date(this.now());
    this.terminationReason = reason;
  }

  private async closeEgress(): Promise<void> {
    try {
      await this.handle.updateNetwork(closedNetwork());
    } catch (error) {
      await this.terminate('failed').catch(() => undefined);
      throw new SandboxError(
        'SANDBOX_EGRESS_REFUSED',
        'The network could not be closed again, so the sandbox was destroyed.',
        { cause: error },
      );
    }
  }

  private async runInternally(argv: readonly string[]): Promise<E2bRunResult> {
    const command = buildShellCommand(argv);
    return this.handle.run(command, {
      cwd: SANDBOX_LIMITS.workspaceDir,
      timeoutMs: Math.min(SANDBOX_LIMITS.defaultCommandTimeoutMs, this.remainingMs()),
    });
  }

  private absolute(path: string): string {
    return `${SANDBOX_LIMITS.workspaceDir}/${normalizeWorkspacePath(path)}`;
  }

  private resolveCwd(requested: string | undefined): string {
    if (requested === undefined || requested === SANDBOX_LIMITS.workspaceDir) {
      return SANDBOX_LIMITS.workspaceDir;
    }

    if (requested.startsWith('/')) {
      throw new SandboxError('SANDBOX_PATH_INVALID', 'A command must run inside the workspace.');
    }

    return `${SANDBOX_LIMITS.workspaceDir}/${normalizeWorkspacePath(requested)}`;
  }

  private cancelled(durationMs: number): CommandResult {
    return {
      outcome: 'cancelled',
      exitCode: null,
      stdout: '',
      stderr: '',
      truncated: false,
      durationMs,
      timedOut: false,
    };
  }

  private remainingMs(): number {
    const elapsed = this.now() - this.createdAt.getTime();
    return this.lifetimeMs - elapsed;
  }
}

export interface E2bProviderOptions {
  now?: () => number;
}

export class E2bSandboxProvider implements SandboxProvider {
  readonly name = E2B_PROVIDER_NAME;
  readonly real = true;

  private readonly client: E2bClient;
  private readonly now: () => number;

  constructor(client: E2bClient, options: E2bProviderOptions = {}) {
    this.client = client;
    this.now = options.now ?? Date.now;
  }

  async create(spec: SandboxSpec): Promise<Sandbox> {
    assertValidSpec(spec);

    if (spec.allowInternet) {
      throw new SandboxError(
        'SANDBOX_SPEC_INVALID',
        'A sandbox may not be created with unrestricted internet access.',
      );
    }

    let handle: E2bHandle;
    try {
      handle = await this.client.create({
        template: spec.templateId,
        timeoutMs: spec.maxSeconds * 1_000,
        requestTimeoutMs: SANDBOX_LIMITS.createTimeoutMs,
        envs: { ...spec.env },
        metadata: buildMetadata(spec),
        secure: SECURED_CONTROLLER_ACCESS,
        allowInternetAccess: INTERNET_ACCESS,
        network: closedNetwork(),
        onTimeout: ON_DEADLINE,
      });
    } catch (error) {
      if (error instanceof SandboxError) {
        throw error;
      }
      throw new SandboxError('SANDBOX_CREATE_FAILED', 'A sandbox could not be started.', {
        cause: error,
      });
    }

    await this.prepareSandbox(handle);
    return new E2bSandbox(handle, spec, this.now);
  }

  private async prepareSandbox(handle: E2bHandle): Promise<void> {
    for (const argv of SANDBOX_SETUP) {
      let done;
      try {
        done = await handle.run(buildShellCommand(argv), {
          cwd: ROOT_DIR,
          timeoutMs: SANDBOX_LIMITS.createTimeoutMs,
          user: 'root',
        });
      } catch (error) {
        await handle.kill().catch(() => undefined);
        throw new SandboxError('SANDBOX_CREATE_FAILED', 'A sandbox could not be prepared.', {
          cause: error,
        });
      }

      if (done.outcome !== 'exited' || done.exitCode !== 0) {
        await handle.kill().catch(() => undefined);
        throw new SandboxError('SANDBOX_CREATE_FAILED', 'A sandbox could not be prepared.', {
          cause: new Error(done.stderr || done.stdout || 'no output'),
        });
      }
    }
  }
}
