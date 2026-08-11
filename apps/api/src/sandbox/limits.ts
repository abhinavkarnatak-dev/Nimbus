import { LIMITS } from '@nimbus/contracts';

export const SANDBOX_LIMITS = {
  workspaceDir: '/workspace',

  createTimeoutMs: 60_000,
  terminateTimeoutMs: 15_000,
  defaultCommandTimeoutMs: 120_000,
  maxCommandTimeoutMs: 600_000,
  minCommandTimeoutMs: 1_000,

  outputMaxBytes: LIMITS.toolOutputTotalMaxBytes,
  fileMaxBytes: 1_048_576,
  patchMaxBytes: 1_048_576,
  patchMaxFiles: LIMITS.maxChangedFiles,
  patchMaxLines: LIMITS.maxDiffLines,
  diffMaxFileLines: 20_000,

  maxArgvEntries: 64,
  maxArgChars: 4_096,
  maxEnvEntries: 32,
  maxEnvNameChars: 64,
  maxEnvValueChars: 4_096,
  maxWorkspaceFiles: 5_000,
  maxWorkspaceBytes: 33_554_432,
} as const;

export type SandboxLimits = typeof SANDBOX_LIMITS;
