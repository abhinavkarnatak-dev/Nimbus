export const LLM_LIMITS = {
  requestTimeoutMs: 60_000,
  visionTimeoutMs: 90_000,

  maxAttempts: 3,
  backoffBaseMs: 500,
  backoffMaxMs: 8_000,
  retryAfterMaxMs: 20_000,

  schemaRepairAttempts: 1,

  maxPromptChars: 300_000,
  maxSystemChars: 20_000,
  maxMessages: 60,
  maxOutputTokens: 4_096,

  geminiThinkingHeadroom: 2_048,

  visionMaxBytes: 5_242_880,
  visionDescriptionMaxChars: 2_000,
  visionMaxOutputTokens: 512,

  errorDetailMaxChars: 300,

  sessionTokenLimit: 400_000,
  sessionMicroCentLimit: 50_000_000,
  sessionCallLimit: 60,
} as const;

export type LlmLimits = typeof LLM_LIMITS;
