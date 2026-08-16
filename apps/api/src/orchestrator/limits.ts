import { POLICY_LIMITS } from '../agent/policy/limits.js';

export const ORCHESTRATOR_LIMITS = {
  leaseSeconds: 45,
  heartbeatMs: 15_000,
  pollMs: 2_000,
  claimBatch: 10,
  maxRecoveries: 3,
  runningConcurrently: 2,
} as const;

export const WAIT_LIMITS = {
  clarificationMs: 24 * 60 * 60 * 1_000,
  approvalMs: POLICY_LIMITS.approvalTtlMs,
  sweepIntervalMs: 60_000,
  sweepBatch: 50,
} as const;

export type OrchestratorLimits = typeof ORCHESTRATOR_LIMITS;
export type WaitLimits = typeof WAIT_LIMITS;
