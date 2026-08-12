import { newPrefixedId } from '../lib/id.js';
import type {
  E2bClient,
  E2bCreateOptions,
  E2bEntry,
  E2bHandle,
  E2bRunOptions,
  E2bRunResult,
  E2bRunningSandbox,
} from './e2b-client.js';
import { SANDBOX_SETUP } from './e2b-provider.js';
import type { EgressPolicy } from './egress.js';
import { SandboxError } from './provider.js';
import { buildShellCommand } from './shell.js';

const SETUP_COMMANDS: readonly string[] = SANDBOX_SETUP.map((argv) => buildShellCommand(argv));

export interface ScriptedRun {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  outcome?: E2bRunResult['outcome'];
  fails?: Error;
}

export interface FakeE2bOptions {
  entries?: readonly E2bEntry[];
  files?: Readonly<Record<string, string>>;
  runs?: Readonly<Record<string, ScriptedRun>>;
  defaultRun?: ScriptedRun;
  createFails?: Error;
  setupFails?: ScriptedRun;
  killFails?: Error;
  networkFails?: Error;
  running?: readonly E2bRunningSandbox[];
}

export interface RecordedRun {
  command: string;
  options: E2bRunOptions;
}

export class FakeE2bHandle implements E2bHandle {
  readonly sandboxId: string;
  readonly runs: RecordedRun[] = [];
  readonly writes: { path: string; contents: string }[] = [];
  readonly networks: EgressPolicy[] = [];

  killed = 0;

  private readonly options: FakeE2bOptions;
  private readonly files: Map<string, string>;

  constructor(sandboxId: string, options: FakeE2bOptions) {
    this.sandboxId = sandboxId;
    this.options = options;
    this.files = new Map(Object.entries(options.files ?? {}));
  }

  async run(command: string, options: E2bRunOptions): Promise<E2bRunResult> {
    this.runs.push({ command, options });
    await Promise.resolve();

    const script =
      this.options.runs?.[command] ??
      (SETUP_COMMANDS.includes(command)
        ? (this.options.setupFails ?? { exitCode: 0 })
        : (this.options.defaultRun ?? {}));

    if (script.fails !== undefined) {
      throw script.fails;
    }

    return {
      outcome: script.outcome ?? 'exited',
      exitCode:
        script.outcome === undefined || script.outcome === 'exited' ? (script.exitCode ?? 0) : null,
      stdout: script.stdout ?? '',
      stderr: script.stderr ?? '',
    };
  }

  async list(path: string, depth: number): Promise<E2bEntry[]> {
    await Promise.resolve();
    const prefix = `${path}/`;
    return (this.options.entries ?? []).filter(
      (entry) =>
        entry.path.startsWith(prefix) && entry.path.slice(prefix.length).split('/').length <= depth,
    );
  }

  async read(path: string): Promise<string> {
    await Promise.resolve();
    const contents = this.files.get(path);
    if (contents === undefined) {
      throw new SandboxError('SANDBOX_FILE_NOT_FOUND', 'That file does not exist.');
    }
    return contents;
  }

  async write(path: string, contents: string): Promise<void> {
    await Promise.resolve();
    this.writes.push({ path, contents });
    this.files.set(path, contents);
  }

  async updateNetwork(policy: EgressPolicy): Promise<void> {
    await Promise.resolve();
    this.networks.push(policy);
    if (this.options.networkFails !== undefined) {
      throw this.options.networkFails;
    }
  }

  async kill(): Promise<void> {
    await Promise.resolve();
    this.killed += 1;
    if (this.options.killFails !== undefined) {
      throw this.options.killFails;
    }
  }
}

export class FakeE2bClient implements E2bClient {
  readonly created: E2bCreateOptions[] = [];
  readonly handles: FakeE2bHandle[] = [];
  readonly killedIds: string[] = [];
  readonly listQueries: Readonly<Record<string, string>>[] = [];

  private readonly options: FakeE2bOptions;

  constructor(options: FakeE2bOptions = {}) {
    this.options = options;
  }

  async create(options: E2bCreateOptions): Promise<E2bHandle> {
    this.created.push(options);
    await Promise.resolve();

    if (this.options.createFails !== undefined) {
      throw this.options.createFails;
    }

    const handle = new FakeE2bHandle(newPrefixedId('sbx'), this.options);
    this.handles.push(handle);
    return handle;
  }

  async list(metadata: Readonly<Record<string, string>>): Promise<E2bRunningSandbox[]> {
    this.listQueries.push(metadata);
    await Promise.resolve();
    return [...(this.options.running ?? [])];
  }

  async kill(sandboxId: string): Promise<boolean> {
    this.killedIds.push(sandboxId);
    await Promise.resolve();
    if (this.options.killFails !== undefined) {
      throw this.options.killFails;
    }
    return true;
  }
}
