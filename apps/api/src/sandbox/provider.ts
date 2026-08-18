import { LIMITS } from '@nimbus/contracts';

import { isSecretKey, redactString } from '../logging/redact.js';
import { SANDBOX_LIMITS } from './limits.js';

export const SANDBOX_STATES = ['creating', 'ready', 'terminating', 'terminated', 'failed'] as const;

export type SandboxState = (typeof SANDBOX_STATES)[number];

export const TERMINAL_STATES: readonly SandboxState[] = ['terminated', 'failed'];

export const SANDBOX_TERMINATION_REASONS = [
  'completed',
  'cancelled',
  'expired',
  'failed',
  'swept',
] as const;

export type SandboxTerminationReason = (typeof SANDBOX_TERMINATION_REASONS)[number];

export const COMMAND_OUTCOMES = ['succeeded', 'failed', 'timed_out', 'cancelled'] as const;

export type CommandOutcome = (typeof COMMAND_OUTCOMES)[number];

export const SANDBOX_ERROR_CODES = [
  'SANDBOX_SPEC_INVALID',
  'SANDBOX_CREDENTIAL_REFUSED',
  'SANDBOX_CREATE_FAILED',
  'SANDBOX_NOT_READY',
  'SANDBOX_EXPIRED',
  'SANDBOX_COMMAND_INVALID',
  'SANDBOX_PATH_INVALID',
  'SANDBOX_FILE_TOO_LARGE',
  'SANDBOX_FILE_NOT_FOUND',
  'SANDBOX_WORKSPACE_FULL',
  'SANDBOX_PATCH_TOO_LARGE',
  'SANDBOX_PATCH_FAILED',
  'SANDBOX_BINARY_FILE',
  'SANDBOX_EGRESS_REFUSED',
  'SANDBOX_TERMINATE_FAILED',
] as const;

export type SandboxErrorCode = (typeof SANDBOX_ERROR_CODES)[number];

export class SandboxError extends Error {
  readonly code: SandboxErrorCode;

  constructor(code: SandboxErrorCode, message: string, options: { cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'SandboxError';
    this.code = code;
  }
}

export const ALLOWED_ENV_NAMES: readonly string[] = [
  'CI',
  'HOME',
  'LANG',
  'LC_ALL',
  'NO_COLOR',
  'NODE_ENV',
  'PATH',
  'PWD',
  'SHELL',
  'TERM',
  'TMPDIR',
  'TZ',
];

const ENV_NAME_PATTERN = /^[A-Z][A-Z0-9_]*$/;
const INTERNAL_URL_PATTERN =
  /\b(?:mongodb(?:\+srv)?|redis|rediss|amqp|postgres(?:ql)?|mysql):\/\//i;
const NUL = String.fromCharCode(0);

export interface SandboxSpec {
  sessionId: string;
  templateId: string;
  workspaceDir: string;
  maxSeconds: number;
  maxOutputBytes: number;
  maxChangedFiles: number;
  maxDiffLines: number;
  allowInternet: boolean;
  env: Readonly<Record<string, string>>;
}

export interface SandboxStatus {
  sandboxId: string;
  state: SandboxState;
  createdAt: Date;
  deadlineAt: Date;
  remainingMs: number;
  commandsRun: number;
  outputBytesUsed: number;
  terminatedAt: Date | null;
  terminationReason: SandboxTerminationReason | null;
}

export interface CommandRequest {
  argv: readonly string[];
  cwd?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface CommandResult {
  outcome: CommandOutcome;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  durationMs: number;
  timedOut: boolean;
}

export const WORKSPACE_ENTRY_KINDS = ['file', 'directory', 'symlink', 'repository'] as const;

export type WorkspaceEntryKind = (typeof WORKSPACE_ENTRY_KINDS)[number];

export interface WorkspaceEntry {
  path: string;
  kind: WorkspaceEntryKind;
  size: number;
  target: string | null;
}

export interface PatchedFile {
  path: string;
  changeKind: 'added' | 'modified' | 'deleted';
  addedLines: number;
  removedLines: number;
}

export interface PatchExport {
  patch: string;
  files: readonly PatchedFile[];
  addedLines: number;
  removedLines: number;
  bytes: number;
}

export interface Sandbox {
  readonly sandboxId: string;
  status(): SandboxStatus;
  execute(request: CommandRequest): Promise<CommandResult>;
  listEntries(): Promise<WorkspaceEntry[]>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, contents: string): Promise<void>;
  removeFile(path: string): Promise<void>;
  markBaseline(): Promise<void>;
  exportPatch(): Promise<PatchExport>;
  terminate(reason: SandboxTerminationReason): Promise<void>;
}

export interface SandboxProvider {
  readonly name: string;
  readonly real: boolean;
  create(spec: SandboxSpec): Promise<Sandbox>;
}

export function looksLikeCredential(value: string): boolean {
  return redactString(value) !== value || INTERNAL_URL_PATTERN.test(value);
}

export function assertNoCredentials(env: Readonly<Record<string, string>>): void {
  const names = Object.keys(env);

  if (names.length > SANDBOX_LIMITS.maxEnvEntries) {
    throw new SandboxError('SANDBOX_SPEC_INVALID', 'Too many environment variables were supplied.');
  }

  for (const name of names) {
    if (name.length > SANDBOX_LIMITS.maxEnvNameChars || !ENV_NAME_PATTERN.test(name)) {
      throw new SandboxError(
        'SANDBOX_SPEC_INVALID',
        'An environment variable name is not usable in a sandbox.',
      );
    }

    if (!ALLOWED_ENV_NAMES.includes(name) || isSecretKey(name)) {
      throw new SandboxError(
        'SANDBOX_CREDENTIAL_REFUSED',
        'A sandbox may only receive environment variables from the allowed list.',
      );
    }

    const value = env[name] ?? '';
    if (value.length > SANDBOX_LIMITS.maxEnvValueChars || value.includes(NUL)) {
      throw new SandboxError(
        'SANDBOX_SPEC_INVALID',
        'An environment variable value is not usable in a sandbox.',
      );
    }

    if (looksLikeCredential(value)) {
      throw new SandboxError(
        'SANDBOX_CREDENTIAL_REFUSED',
        'A sandbox may never receive a credential.',
      );
    }
  }
}

export function assertValidSpec(spec: SandboxSpec): void {
  if (spec.sessionId.trim() === '' || spec.templateId.trim() === '') {
    throw new SandboxError('SANDBOX_SPEC_INVALID', 'A sandbox needs a session and a template.');
  }

  if (!spec.workspaceDir.startsWith('/') || spec.workspaceDir.includes('..')) {
    throw new SandboxError('SANDBOX_SPEC_INVALID', 'The workspace directory is not usable.');
  }

  if (
    !Number.isInteger(spec.maxSeconds) ||
    spec.maxSeconds <= 0 ||
    spec.maxSeconds > LIMITS.maxSandboxSeconds
  ) {
    throw new SandboxError('SANDBOX_SPEC_INVALID', 'The sandbox lifetime is out of range.');
  }

  const caps: [number, number, string][] = [
    [spec.maxOutputBytes, LIMITS.toolOutputTotalMaxBytes, 'output budget'],
    [spec.maxChangedFiles, LIMITS.maxChangedFiles, 'changed file limit'],
    [spec.maxDiffLines, LIMITS.maxDiffLines, 'changed line limit'],
  ];

  for (const [asked, ceiling, what] of caps) {
    if (!Number.isInteger(asked) || asked <= 0 || asked > ceiling) {
      throw new SandboxError('SANDBOX_SPEC_INVALID', `The sandbox ${what} is out of range.`);
    }
  }

  assertNoCredentials(spec.env);
}

export function assertValidArgv(argv: readonly string[]): void {
  if (argv.length === 0 || argv.length > SANDBOX_LIMITS.maxArgvEntries) {
    throw new SandboxError('SANDBOX_COMMAND_INVALID', 'That command could not be read.');
  }

  for (const argument of argv) {
    if (
      typeof argument !== 'string' ||
      argument.length > SANDBOX_LIMITS.maxArgChars ||
      argument.includes(NUL)
    ) {
      throw new SandboxError('SANDBOX_COMMAND_INVALID', 'That command could not be read.');
    }
  }

  if (argv[0]?.trim() === '') {
    throw new SandboxError('SANDBOX_COMMAND_INVALID', 'That command could not be read.');
  }
}

export function resolveTimeout(requestedMs: number | undefined, remainingMs: number): number {
  if (remainingMs < SANDBOX_LIMITS.minCommandTimeoutMs) {
    throw new SandboxError('SANDBOX_EXPIRED', 'This sandbox has run out of time.');
  }

  const requested = requestedMs ?? SANDBOX_LIMITS.defaultCommandTimeoutMs;
  if (!Number.isInteger(requested) || requested < SANDBOX_LIMITS.minCommandTimeoutMs) {
    throw new SandboxError('SANDBOX_COMMAND_INVALID', 'That time limit is out of range.');
  }

  return Math.min(requested, SANDBOX_LIMITS.maxCommandTimeoutMs, remainingMs);
}

export function assertUsable(status: SandboxStatus): void {
  if (status.state !== 'ready') {
    throw new SandboxError('SANDBOX_NOT_READY', 'This sandbox is not available.');
  }

  if (status.remainingMs <= 0) {
    throw new SandboxError('SANDBOX_EXPIRED', 'This sandbox has run out of time.');
  }
}

export function truncateToBytes(
  value: string,
  limit: number,
): { text: string; truncated: boolean } {
  if (limit <= 0) {
    return { text: '', truncated: value !== '' };
  }

  const buffer = Buffer.from(value, 'utf8');
  if (buffer.byteLength <= limit) {
    return { text: value, truncated: false };
  }
  return { text: buffer.subarray(0, limit).toString('utf8'), truncated: true };
}

export function describeSandboxForLog(status: SandboxStatus): Record<string, unknown> {
  return {
    sandboxId: status.sandboxId,
    state: status.state,
    commandsRun: status.commandsRun,
    outputBytesUsed: status.outputBytesUsed,
    remainingMs: Math.max(0, status.remainingMs),
    terminationReason: status.terminationReason,
  };
}
