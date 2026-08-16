import { LIMITS } from '@nimbus/contracts';
import { describe, expect, it } from 'vitest';

import { minimalEnv } from './env.fixtures.js';
import { DEFAULT_LIMITS, HARD_LIMITS, describeLimits, type EffectiveLimits } from './limits.js';
import { ConfigError, loadConfig } from './load.js';

const NAMES = Object.keys(DEFAULT_LIMITS) as (keyof EffectiveLimits)[];

function issuesOf(env: Record<string, string | undefined>): string[] {
  try {
    loadConfig(env);
  } catch (error) {
    return error instanceof ConfigError ? [...error.issues] : ['NOT_A_CONFIG_ERROR'];
  }
  return [];
}

describe('the ceilings this build supports', () => {
  it('takes every ceiling from the contract rather than restating one', () => {
    expect(HARD_LIMITS.maxAttachmentBytes).toBe(LIMITS.maxAttachmentBytes);
    expect(HARD_LIMITS.maxToolOutputBytes).toBe(LIMITS.toolOutputTotalMaxBytes);
    expect(HARD_LIMITS.maxAgentSteps).toBe(LIMITS.maxAgentSteps);
    expect(HARD_LIMITS.maxChangedFiles).toBe(LIMITS.maxChangedFiles);
    expect(HARD_LIMITS.maxDiffLines).toBe(LIMITS.maxDiffLines);
    expect(HARD_LIMITS.maxSandboxSeconds).toBe(LIMITS.maxSandboxSeconds);
  });

  it('never ships a default above its own ceiling', () => {
    for (const name of NAMES) {
      expect(DEFAULT_LIMITS[name], name).toBeLessThanOrEqual(HARD_LIMITS[name]);
    }
  });

  it('describes every limit it holds, so the startup line cannot go stale', () => {
    const described = describeLimits(DEFAULT_LIMITS);

    expect(Object.keys(described).sort()).toEqual([...NAMES].sort());
  });
});

describe('configuration may tighten a limit', () => {
  it('takes a lower value for every one of them', () => {
    const config = loadConfig({
      ...minimalEnv(),
      MAX_ATTACHMENT_BYTES: '1024',
      MAX_TOOL_OUTPUT_BYTES: '4096',
      MAX_AGENT_STEPS: '7',
      MAX_CHANGED_FILES: '3',
      MAX_DIFF_LINES: '40',
      SANDBOX_MAX_SECONDS: '60',
    });

    expect(config.limits).toEqual({
      maxAttachmentBytes: 1024,
      maxToolOutputBytes: 4096,
      maxAgentSteps: 7,
      maxChangedFiles: 3,
      maxDiffLines: 40,
      maxSandboxSeconds: 60,
    });
  });

  it('falls back to the shipped defaults when nothing is configured', () => {
    expect(loadConfig(minimalEnv()).limits).toEqual(DEFAULT_LIMITS);
  });
});

describe('configuration may never widen a limit', () => {
  const settings: Readonly<Record<string, number>> = {
    MAX_ATTACHMENT_BYTES: HARD_LIMITS.maxAttachmentBytes,
    MAX_TOOL_OUTPUT_BYTES: HARD_LIMITS.maxToolOutputBytes,
    MAX_AGENT_STEPS: HARD_LIMITS.maxAgentSteps,
    MAX_CHANGED_FILES: HARD_LIMITS.maxChangedFiles,
    MAX_DIFF_LINES: HARD_LIMITS.maxDiffLines,
    SANDBOX_MAX_SECONDS: HARD_LIMITS.maxSandboxSeconds,
  };

  for (const [setting, ceiling] of Object.entries(settings)) {
    it(`accepts ${setting} exactly at the ceiling`, () => {
      expect(issuesOf({ ...minimalEnv(), [setting]: String(ceiling) })).toEqual([]);
    });

    it(`fails startup for ${setting} one above the ceiling`, () => {
      const issues = issuesOf({ ...minimalEnv(), [setting]: String(ceiling + 1) });

      expect(issues.join('\n')).toContain(setting);
      expect(issues.join('\n')).toContain(String(ceiling));
    });
  }

  it('names every setting that is too high rather than only the first', () => {
    const issues = issuesOf({
      ...minimalEnv(),
      MAX_CHANGED_FILES: String(HARD_LIMITS.maxChangedFiles + 1),
      MAX_DIFF_LINES: String(HARD_LIMITS.maxDiffLines + 1),
      MAX_AGENT_STEPS: String(HARD_LIMITS.maxAgentSteps + 1),
    });

    expect(issues.join('\n')).toContain('MAX_CHANGED_FILES');
    expect(issues.join('\n')).toContain('MAX_DIFF_LINES');
    expect(issues.join('\n')).toContain('MAX_AGENT_STEPS');
  });

  it('refuses zero and a negative value too', () => {
    expect(issuesOf({ ...minimalEnv(), MAX_AGENT_STEPS: '0' })).not.toEqual([]);
    expect(issuesOf({ ...minimalEnv(), MAX_CHANGED_FILES: '-1' })).not.toEqual([]);
  });
});
