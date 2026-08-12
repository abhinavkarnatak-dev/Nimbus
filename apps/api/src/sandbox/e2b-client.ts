import type { EgressPolicy } from './egress.js';

export const E2B_ENTRY_TYPES = ['file', 'dir', 'symlink'] as const;

export type E2bEntryType = (typeof E2B_ENTRY_TYPES)[number];

export interface E2bCreateOptions {
  template: string;
  timeoutMs: number;
  requestTimeoutMs: number;
  envs: Readonly<Record<string, string>>;
  metadata: Readonly<Record<string, string>>;
  secure: boolean;
  allowInternetAccess: boolean;
  network: EgressPolicy;
  onTimeout: 'kill';
}

export const E2B_USERS = ['root', 'user'] as const;

export type E2bUser = (typeof E2B_USERS)[number];

export interface E2bRunOptions {
  cwd: string;
  timeoutMs: number;
  user?: E2bUser;
  signal?: AbortSignal;
}

export const E2B_RUN_OUTCOMES = ['exited', 'timed_out', 'cancelled'] as const;

export type E2bRunOutcome = (typeof E2B_RUN_OUTCOMES)[number];

export interface E2bRunResult {
  outcome: E2bRunOutcome;
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export interface E2bEntry {
  path: string;
  type: E2bEntryType;
  size: number;
  symlinkTarget: string | null;
}

export interface E2bHandle {
  readonly sandboxId: string;
  run(command: string, options: E2bRunOptions): Promise<E2bRunResult>;
  list(path: string, depth: number): Promise<E2bEntry[]>;
  read(path: string): Promise<string>;
  write(path: string, contents: string): Promise<void>;
  updateNetwork(policy: EgressPolicy): Promise<void>;
  kill(): Promise<void>;
}

export interface E2bRunningSandbox {
  sandboxId: string;
  metadata: Readonly<Record<string, string>>;
  startedAt: Date;
  endAt: Date;
}

export interface E2bClient {
  create(options: E2bCreateOptions): Promise<E2bHandle>;
  list(metadata: Readonly<Record<string, string>>): Promise<E2bRunningSandbox[]>;
  kill(sandboxId: string): Promise<boolean>;
}
