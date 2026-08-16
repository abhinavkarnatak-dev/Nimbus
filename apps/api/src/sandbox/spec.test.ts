import { LIMITS } from '@nimbus/contracts';
import { describe, expect, it } from 'vitest';

import { DEFAULT_LIMITS } from '../config/limits.js';
import { testConfig } from '../http/http.fixtures.js';
import { SANDBOX_LIMITS } from './limits.js';
import { SandboxError, assertNoCredentials } from './provider.js';
import { DEFAULT_TEMPLATE_ID, SANDBOX_ENV, buildSandboxSpec } from './spec.js';

const SESSION_ID = 'ses_0123456789abcdefghijk';

describe('buildSandboxSpec', () => {
  it('builds a usable spec from the real configuration', () => {
    const spec = buildSandboxSpec(testConfig().sandbox, SESSION_ID);

    expect(spec).toEqual({
      sessionId: SESSION_ID,
      templateId: DEFAULT_TEMPLATE_ID,
      workspaceDir: SANDBOX_LIMITS.workspaceDir,
      maxSeconds: 1_800,
      maxOutputBytes: DEFAULT_LIMITS.maxToolOutputBytes,
      maxChangedFiles: DEFAULT_LIMITS.maxChangedFiles,
      maxDiffLines: DEFAULT_LIMITS.maxDiffLines,
      allowInternet: false,
      env: SANDBOX_ENV,
    });
  });

  it('carries the configured limits rather than the built in ones', () => {
    const spec = buildSandboxSpec(testConfig().sandbox, SESSION_ID, {
      ...DEFAULT_LIMITS,
      maxToolOutputBytes: 4_096,
      maxChangedFiles: 3,
      maxDiffLines: 40,
    });

    expect(spec.maxOutputBytes).toBe(4_096);
    expect(spec.maxChangedFiles).toBe(3);
    expect(spec.maxDiffLines).toBe(40);
  });

  it('refuses a spec asking for more than this build supports', () => {
    for (const widened of [
      { maxToolOutputBytes: LIMITS.toolOutputTotalMaxBytes + 1 },
      { maxChangedFiles: LIMITS.maxChangedFiles + 1 },
      { maxDiffLines: LIMITS.maxDiffLines + 1 },
    ]) {
      expect(() =>
        buildSandboxSpec(testConfig().sandbox, SESSION_ID, { ...DEFAULT_LIMITS, ...widened }),
      ).toThrow(SandboxError);
    }
  });

  it('falls back to the default template when none is configured', () => {
    const spec = buildSandboxSpec(testConfig({ SANDBOX_TEMPLATE_ID: '' }).sandbox, SESSION_ID);

    expect(spec.templateId).toBe(DEFAULT_TEMPLATE_ID);
  });

  it('defaults to a template the provider really has, so a first run works', () => {
    expect(DEFAULT_TEMPLATE_ID).toBe('base');
  });

  it('takes the session lifetime from configuration', () => {
    const spec = buildSandboxSpec(testConfig({ SANDBOX_MAX_SECONDS: '600' }).sandbox, SESSION_ID);

    expect(spec.maxSeconds).toBe(600);
  });

  it('refuses to build a spec that would allow unrestricted internet', () => {
    expect(() =>
      buildSandboxSpec(testConfig({ SANDBOX_ALLOW_INTERNET: 'true' }).sandbox, SESSION_ID),
    ).toThrow(SandboxError);
  });

  it('never copies the api key into the sandbox environment', () => {
    const config = testConfig({ E2B_API_KEY: 'e2b_secretkeyvalue0123456789' }).sandbox;
    const spec = buildSandboxSpec(config, SESSION_ID);

    expect(config.apiKey).toBe('e2b_secretkeyvalue0123456789');
    expect(JSON.stringify(spec)).not.toContain('e2b_secretkeyvalue0123456789');
  });

  it('passes its own environment through the credential guard', () => {
    expect(() => {
      assertNoCredentials(SANDBOX_ENV);
    }).not.toThrow();
  });

  it('hands out a fresh environment object each time', () => {
    const first = buildSandboxSpec(testConfig().sandbox, SESSION_ID);
    const second = buildSandboxSpec(testConfig().sandbox, SESSION_ID);

    expect(first.env).not.toBe(second.env);
    expect(first.env).toEqual(second.env);
  });

  it('refuses an unusable session identifier', () => {
    expect(() => buildSandboxSpec(testConfig().sandbox, '   ')).toThrow(SandboxError);
  });
});
