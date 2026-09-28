import { chmod, mkdir, readFile, rm } from 'node:fs/promises';
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

const DEVICE_URL = /https:\/\/auth\.openai\.com\/codex\/device\b/i;
const DEVICE_CODE = /\b[A-Z0-9]{4}-[A-Z0-9]{5}\b/i;
const ANSI_ESCAPE = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, 'g');
const ESCAPED_ANSI_ESCAPE = /\\u001b\[[0-?]*[ -/]*[@-~]/gi;
const LITERAL_HEX_ANSI_ESCAPE = /\\x1b\[[0-?]*[ -/]*[@-~]/gi;

export function parseDeviceChallenge(output: string): DeviceAuthChallenge | null {
  const clean = output
    .replace(ANSI_ESCAPE, '')
    .replace(ESCAPED_ANSI_ESCAPE, '')
    .replace(LITERAL_HEX_ANSI_ESCAPE, '');
  if (DEVICE_URL.exec(clean) === null) return null;
  const code = DEVICE_CODE.exec(clean)?.[0];
  if (code === undefined) return null;
  return { url: 'https://auth.openai.com/codex/device', code: code.toUpperCase(), expiresAt: null };
}

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
    this.#logger.info({ userId, home: '[redacted]' }, 'starting Codex device authentication');
    const child = this.#spawn(this.#codexPath, ['login', '--device-auth'], {
      env: { ...process.env, CODEX_HOME: home },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const lifecycle = { value: false };
    let rejectPending: ((error: Error) => void) | null = null;
    this.#pending.set(userId, {
      process: child,
      cancelled: lifecycle,
      reject: (error): void => {
        rejectPending?.(error);
      },
    });
    let output = '';
    const challengePromise = new Promise<DeviceAuthChallenge>((resolve, reject) => {
      rejectPending = reject;
      const consume = (chunk: Buffer): void => {
        if (lifecycle.value) return;
        output += chunk.toString('utf8');
        const challenge = parseDeviceChallenge(output);
        if (challenge !== null) {
          this.#active.set(userId, { process: child, challenge, cancelled: lifecycle });
          this.#pending.delete(userId);
          this.#logger.info({ userId }, 'Codex device authentication challenge received');
          resolve(challenge);
        }
      };
      child.stdout.on('data', consume);
      child.stderr.on('data', consume);
      child.once('error', reject);
      child.once('exit', (code) => {
        if (!lifecycle.value && !this.#active.has(userId) && code !== 0) {
          this.#logger.warn({ userId, exitCode: code }, 'Codex device authentication exited before completion');
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
      const contents = await readFile(join(await this.#home(userId), 'auth.json'), 'utf8');
      const auth = JSON.parse(contents) as unknown;
      if (typeof auth !== 'object' || auth === null) {
        this.#logger.warn({ userId }, 'Codex auth file is not a JSON object');
        return false;
      }
      return true;
    } catch (error) {
      this.#logger.debug({ userId, error: String(error) }, 'Codex credentials are not connected');
      return false;
    }
  }

  async disconnect(userId: string): Promise<void> {
    this.#logger.info({ userId }, 'disconnecting Codex credentials');
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
    const home = await this.#home(userId);
    this.#logger.debug({ userId, home: '[redacted]' }, 'building Codex provider');
    return new CodexTextProvider({ logger: this.#logger, codexHome: home });
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
