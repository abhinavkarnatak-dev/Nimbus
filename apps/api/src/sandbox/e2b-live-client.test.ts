import { describe, expect, it } from 'vitest';

import type { E2bCreateOptions } from './e2b-client.js';
import { LiveE2bClient } from './e2b-live-client.js';
import { closedNetwork } from './egress.js';
import { SANDBOX_LIMITS } from './limits.js';
import { SandboxError } from './provider.js';

const API_KEY = 'e2b_liveliveliveliveliveliveliv';

function options(overrides: Partial<E2bCreateOptions> = {}): E2bCreateOptions {
  return {
    template: 'nimbus-sandbox',
    timeoutMs: 600_000,
    requestTimeoutMs: SANDBOX_LIMITS.createTimeoutMs,
    envs: { CI: 'true' },
    metadata: { owner: 'nimbus', sessionId: 'ses_aaaaaaaaaaaaaaaaaaaaaa' },
    secure: true,
    allowInternetAccess: false,
    network: closedNetwork(),
    onTimeout: 'kill',
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

describe('LiveE2bClient', () => {
  it('refuses to exist without a key', () => {
    expect(codeOf(() => new LiveE2bClient(''))).toBe('SANDBOX_SPEC_INVALID');
    expect(codeOf(() => new LiveE2bClient('   '))).toBe('SANDBOX_SPEC_INVALID');
  });

  it('accepts a key', () => {
    expect(() => new LiveE2bClient(API_KEY)).not.toThrow();
  });
});

describe('the provider key staying outside the sandbox', () => {
  it('allows an ordinary creation through', () => {
    const client = new LiveE2bClient(API_KEY);

    expect(() => {
      client.assertKeyStaysOutside(options());
    }).not.toThrow();
  });

  it('refuses the key as an environment value', () => {
    const client = new LiveE2bClient(API_KEY);

    expect(
      codeOf(() => {
        client.assertKeyStaysOutside(options({ envs: { CI: API_KEY } }));
      }),
    ).toBe('SANDBOX_CREDENTIAL_REFUSED');
  });

  it('refuses the key hidden inside a longer environment value', () => {
    const client = new LiveE2bClient(API_KEY);

    expect(
      codeOf(() => {
        client.assertKeyStaysOutside(options({ envs: { CI: `prefix ${API_KEY} suffix` } }));
      }),
    ).toBe('SANDBOX_CREDENTIAL_REFUSED');
  });

  it('refuses the key as an environment name', () => {
    const client = new LiveE2bClient(API_KEY);

    expect(
      codeOf(() => {
        client.assertKeyStaysOutside(options({ envs: { [API_KEY]: 'true' } }));
      }),
    ).toBe('SANDBOX_CREDENTIAL_REFUSED');
  });

  it('refuses the key in the metadata, which the sandbox can also read back', () => {
    const client = new LiveE2bClient(API_KEY);

    expect(
      codeOf(() => {
        client.assertKeyStaysOutside(
          options({ metadata: { owner: 'nimbus', sessionId: API_KEY } }),
        );
      }),
    ).toBe('SANDBOX_CREDENTIAL_REFUSED');
  });

  it('does not confuse one key for another', () => {
    const client = new LiveE2bClient(API_KEY);

    expect(() => {
      client.assertKeyStaysOutside(options({ envs: { CI: 'e2b_someothersomeothersomeother' } }));
    }).not.toThrow();
  });
});
