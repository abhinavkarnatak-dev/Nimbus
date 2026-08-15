export const ORCHESTRATOR_LIMITS = {
  leaseSeconds: 45,
  heartbeatMs: 15_000,
  pollMs: 2_000,
  claimBatch: 10,
  maxRecoveries: 3,
  runningConcurrently: 2,
} as const;

export type OrchestratorLimits = typeof ORCHESTRATOR_LIMITS;
