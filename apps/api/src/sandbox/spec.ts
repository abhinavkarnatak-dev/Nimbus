import { DEFAULT_LIMITS, type EffectiveLimits } from '../config/limits.js';
import type { SandboxConfig } from '../config/load.js';
import { SANDBOX_LIMITS } from './limits.js';
import { SandboxError, assertValidSpec, type SandboxSpec } from './provider.js';

export const DEFAULT_TEMPLATE_ID = 'base';

export const SANDBOX_ENV: Readonly<Record<string, string>> = {
  CI: 'true',
  HOME: '/home/user',
  LANG: 'C.UTF-8',
  NO_COLOR: '1',
  TERM: 'dumb',
  TZ: 'UTC',
};

export function buildSandboxSpec(
  config: SandboxConfig,
  sessionId: string,
  limits: EffectiveLimits = DEFAULT_LIMITS,
): SandboxSpec {
  if (config.allowInternet) {
    throw new SandboxError(
      'SANDBOX_SPEC_INVALID',
      'A sandbox may not be created with unrestricted internet access.',
    );
  }

  const spec: SandboxSpec = {
    sessionId,
    templateId: config.templateId ?? DEFAULT_TEMPLATE_ID,
    workspaceDir: SANDBOX_LIMITS.workspaceDir,
    maxSeconds: config.maxSeconds,
    maxOutputBytes: limits.maxToolOutputBytes,
    maxChangedFiles: limits.maxChangedFiles,
    maxDiffLines: limits.maxDiffLines,
    allowInternet: false,
    env: { ...SANDBOX_ENV },
  };

  assertValidSpec(spec);
  return spec;
}
