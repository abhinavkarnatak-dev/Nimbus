import { newPrefixedId } from '../lib/id.js';
import { buildPatch } from './diff.js';
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
import { MemoryWorkspace } from './workspace.js';

export const FAKE_PROVIDER_NAME = 'sandbox-fake';

export interface ScriptedCommand {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  durationMs?: number;
  hangs?: boolean;
  writes?: Readonly<Record<string, string>>;
  deletes?: readonly string[];
  fails?: SandboxError;
}

export interface FakeSandboxOptions {
  files?: Readonly<Record<string, string>>;
  links?: Readonly<Record<string, string>>;
  repositories?: readonly string[];
  commands?: Readonly<Record<string, ScriptedCommand>>;
  defaultCommand?: ScriptedCommand;
  createFails?: SandboxError;
  terminateFails?: Error;
  onCommandStarted?: (argv: readonly string[]) => void | Promise<void>;
}

export function commandKey(argv: readonly string[]): string {
  return argv.join(' ');
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

export class FakeSandbox implements Sandbox {
  readonly sandboxId: string;

  private readonly workspace = new MemoryWorkspace();
  private readonly options: FakeSandboxOptions;
  private readonly createdAt: Date;
  private readonly lifetimeMs: number;
  private readonly spec: SandboxSpec;

  private state: SandboxState = 'creating';
  private virtualElapsedMs = 0;
  private commandsRun = 0;
  private outputBytesUsed = 0;
  private terminatedAt: Date | null = null;
  private terminationReason: SandboxTerminationReason | null = null;

  constructor(spec: SandboxSpec, options: FakeSandboxOptions) {
    this.sandboxId = newPrefixedId('sbx');
    this.options = options;
    this.spec = spec;
    this.createdAt = new Date();
    this.lifetimeMs = spec.maxSeconds * 1_000;
    this.workspace.seed(options.files ?? {});
    this.workspace.seedLinks(options.links ?? {});
    this.workspace.seedRepositories(options.repositories ?? []);
    this.state = 'ready';
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

  advanceClock(milliseconds: number): void {
    this.virtualElapsedMs += Math.max(0, milliseconds);
  }

  listFiles(): string[] {
    return this.workspace.list();
  }

  async execute(request: CommandRequest): Promise<CommandResult> {
    assertUsable(this.status());
    assertValidArgv(request.argv);

    const timeoutMs = resolveTimeout(request.timeoutMs, this.remainingMs());
    const script = this.scriptFor(request.argv);

    if (isAborted(request.signal)) {
      return await this.cancelled(0);
    }

    this.commandsRun += 1;
    await this.options.onCommandStarted?.(request.argv);

    if (isAborted(request.signal)) {
      return await this.cancelled(0);
    }

    if (this.state !== 'ready') {
      throw new SandboxError('SANDBOX_NOT_READY', 'This sandbox is not available.');
    }

    if (script.fails !== undefined) {
      throw script.fails;
    }

    const durationMs = script.hangs === true ? Number.POSITIVE_INFINITY : (script.durationMs ?? 0);

    if (durationMs > timeoutMs) {
      this.advanceClock(timeoutMs);
      return {
        outcome: 'timed_out',
        exitCode: null,
        stdout: '',
        stderr: '',
        truncated: false,
        durationMs: timeoutMs,
        timedOut: true,
      };
    }

    this.advanceClock(durationMs);
    this.applyEffects(script);

    const budget = Math.max(0, this.spec.maxOutputBytes - this.outputBytesUsed);
    const stdout = truncateToBytes(script.stdout ?? '', budget);
    const stderr = truncateToBytes(
      script.stderr ?? '',
      Math.max(0, budget - Buffer.byteLength(stdout.text, 'utf8')),
    );

    this.outputBytesUsed +=
      Buffer.byteLength(stdout.text, 'utf8') + Buffer.byteLength(stderr.text, 'utf8');

    const exitCode = script.exitCode ?? 0;
    return {
      outcome: exitCode === 0 ? 'succeeded' : 'failed',
      exitCode,
      stdout: stdout.text,
      stderr: stderr.text,
      truncated: stdout.truncated || stderr.truncated,
      durationMs,
      timedOut: false,
    };
  }

  async listEntries(): Promise<WorkspaceEntry[]> {
    assertUsable(this.status());
    await Promise.resolve();
    return this.workspace.entries();
  }

  async readFile(path: string): Promise<string> {
    assertUsable(this.status());
    await Promise.resolve();
    return this.workspace.read(path);
  }

  async writeFile(path: string, contents: string): Promise<void> {
    assertUsable(this.status());
    await Promise.resolve();
    this.workspace.write(path, contents);
  }

  async markBaseline(): Promise<void> {
    assertUsable(this.status());
    await Promise.resolve();
    this.workspace.markBaseline();
  }

  async exportPatch(): Promise<PatchExport> {
    assertUsable(this.status());
    await Promise.resolve();

    const { baseline, current } = this.workspace.snapshot();
    return buildPatch(baseline, current, {
      maxChangedFiles: this.spec.maxChangedFiles,
      maxDiffLines: this.spec.maxDiffLines,
    });
  }

  async terminate(reason: SandboxTerminationReason): Promise<void> {
    if (TERMINAL_STATES.includes(this.state)) {
      return;
    }

    this.state = 'terminating';
    await Promise.resolve();

    if (this.options.terminateFails !== undefined) {
      this.state = 'failed';
      this.terminatedAt = new Date();
      this.terminationReason = 'failed';
      throw this.options.terminateFails;
    }

    this.workspace.clear();
    this.state = 'terminated';
    this.terminatedAt = new Date();
    this.terminationReason = reason;
  }

  private remainingMs(): number {
    const elapsed = Date.now() - this.createdAt.getTime() + this.virtualElapsedMs;
    return this.lifetimeMs - elapsed;
  }

  private scriptFor(argv: readonly string[]): ScriptedCommand {
    return (
      this.options.commands?.[commandKey(argv)] ??
      this.options.defaultCommand ?? { exitCode: 0, stdout: '' }
    );
  }

  private applyEffects(script: ScriptedCommand): void {
    for (const [path, contents] of Object.entries(script.writes ?? {})) {
      this.workspace.write(path, contents);
    }

    for (const path of script.deletes ?? []) {
      this.workspace.remove(path);
    }
  }

  private async cancelled(durationMs: number): Promise<CommandResult> {
    await this.terminate('cancelled');
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
}

export class FakeSandboxProvider implements SandboxProvider {
  readonly name = FAKE_PROVIDER_NAME;
  readonly real = false;

  readonly created: FakeSandbox[] = [];
  readonly specs: SandboxSpec[] = [];

  private options: FakeSandboxOptions;

  constructor(options: FakeSandboxOptions = {}) {
    this.options = options;
  }

  get liveCount(): number {
    return this.created.filter((sandbox) => sandbox.status().state === 'ready').length;
  }

  configure(options: FakeSandboxOptions): void {
    this.options = { ...this.options, ...options };
  }

  async create(spec: SandboxSpec): Promise<Sandbox> {
    assertValidSpec(spec);
    this.specs.push({ ...spec, env: { ...spec.env } });
    await Promise.resolve();

    if (this.options.createFails !== undefined) {
      throw this.options.createFails;
    }

    const sandbox = new FakeSandbox(spec, this.options);
    this.created.push(sandbox);
    return sandbox;
  }

  reset(): void {
    this.created.length = 0;
    this.specs.length = 0;
  }
}
