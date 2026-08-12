import { CommandExitError, FileType, Sandbox, TimeoutError } from 'e2b';

import type { EgressPolicy } from './egress.js';
import type {
  E2bClient,
  E2bCreateOptions,
  E2bEntry,
  E2bEntryType,
  E2bHandle,
  E2bRunOptions,
  E2bRunResult,
  E2bRunningSandbox,
} from './e2b-client.js';
import { SandboxError } from './provider.js';

const MAX_SWEEP_PAGES = 20;

function toEntryType(type: FileType | undefined): E2bEntryType | null {
  if (type === FileType.FILE) {
    return 'file';
  }
  if (type === FileType.DIR) {
    return 'dir';
  }
  if (type === FileType.SYMLINK) {
    return 'symlink';
  }
  return null;
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

class LiveHandle implements E2bHandle {
  readonly sandboxId: string;

  private readonly sandbox: Sandbox;

  constructor(sandbox: Sandbox) {
    this.sandbox = sandbox;
    this.sandboxId = sandbox.sandboxId;
  }

  async run(command: string, options: E2bRunOptions): Promise<E2bRunResult> {
    try {
      const result = await this.sandbox.commands.run(command, {
        cwd: options.cwd,
        timeoutMs: options.timeoutMs,
        ...(options.user === undefined ? {} : { user: options.user }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });

      return {
        outcome: 'exited',
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
      };
    } catch (error) {
      if (error instanceof CommandExitError) {
        return {
          outcome: 'exited',
          exitCode: error.exitCode,
          stdout: error.stdout,
          stderr: error.stderr,
        };
      }

      if (isAborted(options.signal)) {
        return { outcome: 'cancelled', exitCode: null, stdout: '', stderr: '' };
      }

      if (error instanceof TimeoutError) {
        return { outcome: 'timed_out', exitCode: null, stdout: '', stderr: '' };
      }

      throw new SandboxError('SANDBOX_COMMAND_INVALID', 'That command could not be run.', {
        cause: error,
      });
    }
  }

  async list(path: string, depth: number): Promise<E2bEntry[]> {
    const found = await this.sandbox.files.list(path, { depth });
    const entries: E2bEntry[] = [];

    for (const entry of found) {
      const type = toEntryType(entry.type);
      if (type === null) {
        continue;
      }

      entries.push({
        path: entry.path,
        type,
        size: entry.size,
        symlinkTarget: entry.symlinkTarget ?? null,
      });
    }

    return entries;
  }

  async read(path: string): Promise<string> {
    return this.sandbox.files.read(path, { format: 'text' });
  }

  async write(path: string, contents: string): Promise<void> {
    await this.sandbox.files.write(path, contents);
  }

  async updateNetwork(policy: EgressPolicy): Promise<void> {
    await this.sandbox.updateNetwork({
      ...(policy.allowOut === undefined ? {} : { allowOut: policy.allowOut }),
      denyOut: policy.denyOut,
    });
  }

  async kill(): Promise<void> {
    await this.sandbox.kill();
  }
}

export class LiveE2bClient implements E2bClient {
  private readonly apiKey: string;

  constructor(apiKey: string) {
    if (apiKey.trim() === '') {
      throw new SandboxError('SANDBOX_SPEC_INVALID', 'A sandbox provider needs an api key.');
    }
    this.apiKey = apiKey;
  }

  assertKeyStaysOutside(options: E2bCreateOptions): void {
    const carried = [
      ...Object.keys(options.envs),
      ...Object.values(options.envs),
      ...Object.keys(options.metadata),
      ...Object.values(options.metadata),
    ];

    if (carried.some((value) => value.includes(this.apiKey))) {
      throw new SandboxError(
        'SANDBOX_CREDENTIAL_REFUSED',
        'A sandbox may never receive the provider key.',
      );
    }
  }

  async create(options: E2bCreateOptions): Promise<E2bHandle> {
    this.assertKeyStaysOutside(options);

    const sandbox = await Sandbox.create(options.template, {
      apiKey: this.apiKey,
      timeoutMs: options.timeoutMs,
      requestTimeoutMs: options.requestTimeoutMs,
      envs: { ...options.envs },
      metadata: { ...options.metadata },
      secure: options.secure,
      allowInternetAccess: options.allowInternetAccess,
      network: {
        ...(options.network.allowOut === undefined ? {} : { allowOut: options.network.allowOut }),
        denyOut: options.network.denyOut,
      },
      lifecycle: { onTimeout: options.onTimeout },
    });

    return new LiveHandle(sandbox);
  }

  async list(metadata: Readonly<Record<string, string>>): Promise<E2bRunningSandbox[]> {
    const paginator = Sandbox.list({
      apiKey: this.apiKey,
      query: { metadata: { ...metadata }, state: ['running', 'paused'] },
    });

    const running: E2bRunningSandbox[] = [];

    for (let page = 0; page < MAX_SWEEP_PAGES && paginator.hasNext; page += 1) {
      const items = await paginator.nextItems();
      for (const item of items) {
        running.push({
          sandboxId: item.sandboxId,
          metadata: item.metadata,
          startedAt: item.startedAt,
          endAt: item.endAt,
        });
      }
    }

    return running;
  }

  async kill(sandboxId: string): Promise<boolean> {
    return Sandbox.kill(sandboxId, { apiKey: this.apiKey });
  }
}
