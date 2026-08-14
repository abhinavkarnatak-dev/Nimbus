export const POLICY_LIMITS = {
  approvalTtlMs: 900_000,
  approvalsPerSessionMax: 20,

  patchFilesBeforeApproval: 10,
  patchLinesBeforeApproval: 400,

  reasonMaxChars: 300,
  pathsPerEffectMax: 20,
  hashDepthMax: 12,
} as const;

export type PolicyLimits = typeof POLICY_LIMITS;
