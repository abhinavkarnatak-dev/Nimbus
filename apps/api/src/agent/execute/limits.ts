export const EXECUTE_LIMITS = {
  observationMaxChars: 12_000,
  summaryMaxChars: 300,
  sameActionFailuresMax: 2,
  sameActionRepeatsMax: 3,
  recentActionsTracked: 12,
  userMessageMaxChars: 2_000,
} as const;

export type ExecuteLimits = typeof EXECUTE_LIMITS;
