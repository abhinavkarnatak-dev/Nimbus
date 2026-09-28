import { chmod, mkdir, rm, stat } from 'node:fs/promises';
import { spawn, type ChildProcess } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Logger } from '../logging/logger.js';
import { CodexTextProvider } from './codex-text.js';
import type { CodexProviderSource } from './sources.js';

export interface DeviceAuthChallenge {
  url: string;
  code: string;
  expiresAt: string | null;
}

export interface CodexAuthOptions {
  rootDirectory: string;
  logger: Logger;
  codexPath?: string;
  spawnProcess?: typeof spawn;
}

interface ActiveLogin {
  process: ChildProcess;
  challenge: DeviceAuthChallenge;
  cancelled: { value: boolean };
}

interface PendingLogin {
  process: ChildProcess;
  cancelled: { value: boolean };
  reject: (error: Error) => void;
}

const URL = /https?:\/\/[^\s)]+/i;
const CODE = /(?:code|user code|device code)\s*[:=]?\s*([A-Z0-9-]{4,})/i;

export class CodexAuthService implements CodexProviderSource {
  readonly #root: string;
  readonly #logger: Logger;
  readonly #codexPath: string;
  readonly #spawn: typeof spawn;
  readonly #active = new Map<string, ActiveLogin>();
  readonly #pending = new Map<string, PendingLogin>();

  constructor(options: CodexAuthOptions) {
    this.#root = options.rootDirectory;
    this.#logger = options.logger;
    this.#codexPath = options.codexPath ?? defaultCodexPath();
    this.#spawn = options.spawnProcess ?? spawn;
  }

  async start(userId: string): Promise<DeviceAuthChallenge> {
    const existing = this.#active.get(userId);
    if (existing !== undefined) return existing.challenge;
    if (this.#pending.has(userId)) throw new Error('Codex device login is already in progress.');
    const home = await this.#home(userId);
    const child = this.#spawn(this.#codexPath, ['login', '--device-auth'], {
      env: { ...process.env, CODEX_HOME: home },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const lifecycle = { value: false };
    let rejectPending: ((error: Error) => void) | null = null;
    this.#pending.set(userId, {
      process: child,
      cancelled: lifecycle,
      reject: (error): void => { rejectPending?.(error); },
    });
    let output = '';
    const challengePromise = new Promise<DeviceAuthChallenge>((resolve, reject) => {
      rejectPending = reject;
      const consume = (chunk: Buffer): void => {
        if (lifecycle.value) return;
        output += chunk.toString('utf8');
        const url = URL.exec(output)?.[0];
        const code = CODE.exec(output)?.[1] ?? /\b[A-Z0-9]{6,}\b/.exec(output)?.[0];
        if (url !== undefined && code !== undefined) {
          const challenge = { url, code, expiresAt: null };
          this.#active.set(userId, { process: child, challenge, cancelled: lifecycle });
          this.#pending.delete(userId);
          resolve(challenge);
        }
      };
      child.stdout.on('data', consume);
      child.stderr.on('data', consume);
      child.once('error', reject);
      child.once('exit', (code) => {
        if (!lifecycle.value && !this.#active.has(userId) && code !== 0) {
          reject(new Error('Codex device login failed.'));
        }
        if (this.#active.get(userId)?.cancelled === lifecycle) this.#active.delete(userId);
        if (this.#pending.get(userId)?.cancelled === lifecycle) this.#pending.delete(userId);
      });
      setTimeout(() => {
        if (lifecycle.value || this.#active.has(userId)) return;
        lifecycle.value = true;
        child.kill();
        this.#pending.delete(userId);
        reject(new Error('Codex device login did not provide a challenge.'));
      }, 15_000).unref();
    });
    return await challengePromise;
  }

  async connected(userId: string): Promise<boolean> {
    try {
      await stat(join(await this.#home(userId), 'auth.json'));
      return true;
    } catch {
      return false;
    }
  }

  async disconnect(userId: string): Promise<void> {
    const active = this.#active.get(userId);
    if (active !== undefined) {
      active.cancelled.value = true;
      active.process.kill();
    }
    const pending = this.#pending.get(userId);
    if (pending !== undefined) {
      pending.cancelled.value = true;
      pending.process.kill();
      pending.reject(new Error('Codex device login was cancelled.'));
      this.#pending.delete(userId);
    }
    this.#active.delete(userId);
    await rm(await this.#home(userId), { recursive: true, force: true });
  }

  async for(userId: string): Promise<CodexTextProvider | null> {
    if (!(await this.connected(userId))) return null;
    return new CodexTextProvider({ logger: this.#logger, codexHome: await this.#home(userId) });
  }

  async #home(userId: string): Promise<string> {
    const safe = userId.replace(/[^a-zA-Z0-9_-]/g, '_');
    const home = join(this.#root, safe);
    await mkdir(home, { recursive: true, mode: 0o700 });
    await chmod(home, 0o700);
    return home;
  }
}

function defaultCodexPath(): string {
  const binary = process.platform === 'win32' ? 'codex.cmd' : 'codex';
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'node_modules', '.bin', binary);
}
