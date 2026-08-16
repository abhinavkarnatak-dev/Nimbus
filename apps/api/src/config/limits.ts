import { LIMITS } from '@nimbus/contracts';

export interface EffectiveLimits {
  readonly maxAttachmentBytes: number;
  readonly maxToolOutputBytes: number;
  readonly maxAgentSteps: number;
  readonly maxChangedFiles: number;
  readonly maxDiffLines: number;
  readonly maxSandboxSeconds: number;
}

export const HARD_LIMITS: EffectiveLimits = {
  maxAttachmentBytes: LIMITS.maxAttachmentBytes,
  maxToolOutputBytes: LIMITS.toolOutputTotalMaxBytes,
  maxAgentSteps: LIMITS.maxAgentSteps,
  maxChangedFiles: LIMITS.maxChangedFiles,
  maxDiffLines: LIMITS.maxDiffLines,
  maxSandboxSeconds: LIMITS.maxSandboxSeconds,
};

export const DEFAULT_LIMITS: EffectiveLimits = {
  maxAttachmentBytes: LIMITS.maxAttachmentBytes,
  maxToolOutputBytes: LIMITS.toolOutputTotalMaxBytes,
  maxAgentSteps: 30,
  maxChangedFiles: LIMITS.maxChangedFiles,
  maxDiffLines: LIMITS.maxDiffLines,
  maxSandboxSeconds: 1800,
};

export interface PatchCaps {
  readonly maxChangedFiles: number;
  readonly maxDiffLines: number;
}

export function describeLimits(configured: EffectiveLimits): Record<string, number> {
  return {
    maxAttachmentBytes: configured.maxAttachmentBytes,
    maxToolOutputBytes: configured.maxToolOutputBytes,
    maxAgentSteps: configured.maxAgentSteps,
    maxChangedFiles: configured.maxChangedFiles,
    maxDiffLines: configured.maxDiffLines,
    maxSandboxSeconds: configured.maxSandboxSeconds,
  };
}
