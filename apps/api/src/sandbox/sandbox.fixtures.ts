import { DEFAULT_LIMITS } from '../config/limits.js';
import { SANDBOX_LIMITS } from './limits.js';
import type { SandboxSpec } from './provider.js';

export function testSpec(overrides: Partial<SandboxSpec> = {}): SandboxSpec {
  return {
    sessionId: 'ses_0123456789abcdefghijk',
    templateId: 'nimbus-sandbox',
    workspaceDir: SANDBOX_LIMITS.workspaceDir,
    maxSeconds: 1_800,
    maxOutputBytes: DEFAULT_LIMITS.maxToolOutputBytes,
    maxChangedFiles: DEFAULT_LIMITS.maxChangedFiles,
    maxDiffLines: DEFAULT_LIMITS.maxDiffLines,
    allowInternet: false,
    env: { CI: 'true', NODE_ENV: 'test' },
    ...overrides,
  };
}
