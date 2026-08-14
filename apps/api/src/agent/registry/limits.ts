import { LIMITS } from '@nimbus/contracts';

export const REGISTRY_LIMITS = {
  readTimeoutMs: 10_000,
  writeTimeoutMs: 15_000,
  searchTimeoutMs: 20_000,
  commandTimeoutMs: 120_000,
  checkTimeoutMs: 300_000,
  instantTimeoutMs: 5_000,

  outputMaxChars: LIMITS.toolOutputChunkMaxChars,
  summaryMaxChars: LIMITS.summaryMaxChars,
  pathsPerRecordMax: 20,
  descriptionMaxChars: 400,

  messageMaxChars: LIMITS.messageMaxChars,
  questionMaxChars: LIMITS.messageMaxChars,
} as const;

export type RegistryLimits = typeof REGISTRY_LIMITS;
