import { describe, expect, it } from 'vitest';

import type { SandboxConfig } from '../config/load.js';
import { E2B_PROVIDER_NAME } from './e2b-provider.js';
import { createSandboxProvider } from './factory.js';
import { FAKE_PROVIDER_NAME } from './fake-provider.js';
import { SandboxError } from './provider.js';

function config(overrides: Partial<SandboxConfig> = {}): SandboxConfig {
  return {
    provider: 'fake',
    maxSeconds: 600,
    allowInternet: false,
    templateId: 'nimbus-sandbox',
    ...overrides,
  };
}

function codeOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return error instanceof SandboxError ? error.code : 'NOT_A_SANDBOX_ERROR';
  }
  return 'NOTHING_THROWN';
}

describe('createSandboxProvider', () => {
  it('builds the fake when the fake is asked for', () => {
    const provider = createSandboxProvider(config());

    expect(provider.name).toBe(FAKE_PROVIDER_NAME);
    expect(provider.real).toBe(false);
  });

  it('builds the real one when e2b is asked for', () => {
    const provider = createSandboxProvider(config({ provider: 'e2b', apiKey: 'e2b_key_value' }));

    expect(provider.name).toBe(E2B_PROVIDER_NAME);
    expect(provider.real).toBe(true);
  });

  it('refuses the real one without a key, rather than quietly falling back to the fake', () => {
    expect(codeOf(() => createSandboxProvider(config({ provider: 'e2b' })))).toBe(
      'SANDBOX_SPEC_INVALID',
    );
    expect(codeOf(() => createSandboxProvider(config({ provider: 'e2b', apiKey: '  ' })))).toBe(
      'SANDBOX_SPEC_INVALID',
    );
  });

  it('does not need a key for the fake', () => {
    expect(() => createSandboxProvider(config())).not.toThrow();
  });
});
