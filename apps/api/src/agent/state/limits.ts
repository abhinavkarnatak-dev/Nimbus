export const STATE_LIMITS = {
  maxSteps: 40,
  maxRetries: 6,
  maxDurationMs: 1_800_000,

  checkpointMaxBytes: 262_144,
  checkpointMaxAgeMs: 86_400_000,

  snippetMaxChars: 4_000,
  summaryMaxChars: 500,
} as const;

export type StateLimits = typeof STATE_LIMITS;
