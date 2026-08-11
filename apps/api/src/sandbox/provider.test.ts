import { describe, expect, it } from 'vitest';

import { SANDBOX_LIMITS } from './limits.js';
import {
  ALLOWED_ENV_NAMES,
  SandboxError,
  assertNoCredentials,
  assertUsable,
  assertValidArgv,
  assertValidSpec,
  describeSandboxForLog,
  looksLikeCredential,
  resolveTimeout,
  type SandboxStatus,
} from './provider.js';
import { testSpec } from './sandbox.fixtures.js';

function codeOf(work: () => unknown): string {
  try {
    work();
  } catch (error) {
    return error instanceof SandboxError ? error.code : 'NOT_A_SANDBOX_ERROR';
  }
  return 'NO_ERROR';
}

function readyStatus(overrides: Partial<SandboxStatus> = {}): SandboxStatus {
  const createdAt = new Date('2026-08-12T10:00:00.000Z');

  return {
    sandboxId: 'sbx_0123456789abcdefghijk',
    state: 'ready',
    createdAt,
    deadlineAt: new Date(createdAt.getTime() + 1_800_000),
    remainingMs: 1_800_000,
    commandsRun: 0,
    outputBytesUsed: 0,
    terminatedAt: null,
    terminationReason: null,
    ...overrides,
  };
}

describe('the credential guard', () => {
  it('accepts the environment variables a sandbox is allowed to have', () => {
    expect(() => {
      assertNoCredentials({ CI: 'true', NODE_ENV: 'test', TZ: 'UTC' });
    }).not.toThrow();
  });

  it('accepts an empty environment', () => {
    expect(() => {
      assertNoCredentials({});
    }).not.toThrow();
  });

  it('refuses any name outside the allowed list, even a harmless looking one', () => {
    expect(
      codeOf(() => {
        assertNoCredentials({ MY_FEATURE_FLAG: 'on' });
      }),
    ).toBe('SANDBOX_CREDENTIAL_REFUSED');
  });

  it.each([
    ['GITHUB_TOKEN', 'ghs_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'],
    ['DATABASE_PASSWORD', 'hunter2hunter2'],
    ['SESSION_SECRET', 'a'.repeat(40)],
    ['GH_PAT', 'github_pat_aaaaaaaaaaaaaaaaaaaaaaaa'],
    ['API_KEY', 'sk-aaaaaaaaaaaaaaaaaaaa'],
    ['SMTP_PASSWORD', 'letmein12345'],
    ['E2B_API_KEY', 'e2b_aaaaaaaaaaaaaaaaaaaaaaaa'],
  ])('refuses %s outright', (name, value) => {
    expect(
      codeOf(() => {
        assertNoCredentials({ [name]: value });
      }),
    ).toBe('SANDBOX_CREDENTIAL_REFUSED');
  });

  it('refuses a credential smuggled into an allowed name', () => {
    expect(
      codeOf(() => {
        assertNoCredentials({ PATH: '/usr/bin:ghs_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' });
      }),
    ).toBe('SANDBOX_CREDENTIAL_REFUSED');
  });

  it('refuses an internal service address even without a password in it', () => {
    expect(
      codeOf(() => {
        assertNoCredentials({ HOME: 'mongodb://127.0.0.1:27017/nimbus' });
      }),
    ).toBe('SANDBOX_CREDENTIAL_REFUSED');
    expect(
      codeOf(() => {
        assertNoCredentials({ HOME: 'redis://127.0.0.1:6379' });
      }),
    ).toBe('SANDBOX_CREDENTIAL_REFUSED');
  });

  it('refuses a private key pasted into an allowed name', () => {
    const key = '-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----';

    expect(
      codeOf(() => {
        assertNoCredentials({ HOME: key });
      }),
    ).toBe('SANDBOX_CREDENTIAL_REFUSED');
  });

  it('refuses a name that is not a plain environment variable name', () => {
    expect(
      codeOf(() => {
        assertNoCredentials({ 'no-hyphens': 'x' });
      }),
    ).toBe('SANDBOX_SPEC_INVALID');
    expect(
      codeOf(() => {
        assertNoCredentials({ lowercase: 'x' });
      }),
    ).toBe('SANDBOX_SPEC_INVALID');
  });

  it('refuses more variables than the limit allows', () => {
    const env: Record<string, string> = {};
    for (let index = 0; index <= SANDBOX_LIMITS.maxEnvEntries; index += 1) {
      env[`CI_${String(index)}`] = 'x';
    }

    expect(
      codeOf(() => {
        assertNoCredentials(env);
      }),
    ).toBe('SANDBOX_SPEC_INVALID');
  });

  it('refuses an oversized value', () => {
    const value = 'a'.repeat(SANDBOX_LIMITS.maxEnvValueChars + 1);

    expect(
      codeOf(() => {
        assertNoCredentials({ TERM: value });
      }),
    ).toBe('SANDBOX_SPEC_INVALID');
  });

  it('refuses a value carrying a null byte', () => {
    expect(
      codeOf(() => {
        assertNoCredentials({ TERM: `xterm${String.fromCharCode(0)}` });
      }),
    ).toBe('SANDBOX_SPEC_INVALID');
  });

  it('never lists a secret sounding name as allowed', () => {
    for (const name of ALLOWED_ENV_NAMES) {
      expect(
        codeOf(() => {
          assertNoCredentials({ [name]: 'value' });
        }),
      ).toBe('NO_ERROR');
    }
  });
});

describe('looksLikeCredential', () => {
  it('leaves ordinary values alone', () => {
    expect(looksLikeCredential('true')).toBe(false);
    expect(looksLikeCredential('/usr/local/bin:/usr/bin')).toBe(false);
    expect(looksLikeCredential('UTC')).toBe(false);
  });

  it('spots token shapes and connection strings', () => {
    expect(looksLikeCredential('ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')).toBe(true);
    expect(looksLikeCredential('postgres://user:pass@host/db')).toBe(true);
    expect(looksLikeCredential('Bearer abcdefghijklmnop')).toBe(true);
  });
});

describe('spec validation', () => {
  it('accepts a well formed spec', () => {
    expect(() => {
      assertValidSpec(testSpec());
    }).not.toThrow();
  });

  it('refuses a missing session or template', () => {
    expect(
      codeOf(() => {
        assertValidSpec(testSpec({ sessionId: '  ' }));
      }),
    ).toBe('SANDBOX_SPEC_INVALID');
    expect(
      codeOf(() => {
        assertValidSpec(testSpec({ templateId: '' }));
      }),
    ).toBe('SANDBOX_SPEC_INVALID');
  });

  it('refuses a workspace directory that is relative or climbs', () => {
    expect(
      codeOf(() => {
        assertValidSpec(testSpec({ workspaceDir: 'workspace' }));
      }),
    ).toBe('SANDBOX_SPEC_INVALID');
    expect(
      codeOf(() => {
        assertValidSpec(testSpec({ workspaceDir: '/workspace/../etc' }));
      }),
    ).toBe('SANDBOX_SPEC_INVALID');
  });

  it('refuses a lifetime outside the allowed range', () => {
    expect(
      codeOf(() => {
        assertValidSpec(testSpec({ maxSeconds: 0 }));
      }),
    ).toBe('SANDBOX_SPEC_INVALID');
    expect(
      codeOf(() => {
        assertValidSpec(testSpec({ maxSeconds: 7_201 }));
      }),
    ).toBe('SANDBOX_SPEC_INVALID');
    expect(
      codeOf(() => {
        assertValidSpec(testSpec({ maxSeconds: 1.5 }));
      }),
    ).toBe('SANDBOX_SPEC_INVALID');
  });

  it('refuses a credential carried in the spec', () => {
    expect(
      codeOf(() => {
        assertValidSpec(testSpec({ env: { GITHUB_TOKEN: 'ghs_aaaaaaaaaaaaaaaaaaaaaaaaaaaa' } }));
      }),
    ).toBe('SANDBOX_CREDENTIAL_REFUSED');
  });
});

describe('argv validation', () => {
  it('accepts an ordinary command given as separate words', () => {
    expect(() => {
      assertValidArgv(['git', 'status', '--porcelain']);
    }).not.toThrow();
  });

  it('refuses an empty command', () => {
    expect(
      codeOf(() => {
        assertValidArgv([]);
      }),
    ).toBe('SANDBOX_COMMAND_INVALID');
    expect(
      codeOf(() => {
        assertValidArgv(['   ']);
      }),
    ).toBe('SANDBOX_COMMAND_INVALID');
  });

  it('refuses too many words', () => {
    const argv = new Array<string>(SANDBOX_LIMITS.maxArgvEntries + 1).fill('x');

    expect(
      codeOf(() => {
        assertValidArgv(argv);
      }),
    ).toBe('SANDBOX_COMMAND_INVALID');
  });

  it('refuses an oversized word', () => {
    const argv = ['echo', 'a'.repeat(SANDBOX_LIMITS.maxArgChars + 1)];

    expect(
      codeOf(() => {
        assertValidArgv(argv);
      }),
    ).toBe('SANDBOX_COMMAND_INVALID');
  });

  it('refuses a null byte inside a word', () => {
    expect(
      codeOf(() => {
        assertValidArgv(['echo', `a${String.fromCharCode(0)}b`]);
      }),
    ).toBe('SANDBOX_COMMAND_INVALID');
  });

  it('keeps shell punctuation as one harmless word rather than treating it as syntax', () => {
    expect(() => {
      assertValidArgv(['echo', 'hello; rm -rf /']);
    }).not.toThrow();
  });
});

describe('resolveTimeout', () => {
  it('uses the default when nothing is asked for', () => {
    expect(resolveTimeout(undefined, 1_800_000)).toBe(SANDBOX_LIMITS.defaultCommandTimeoutMs);
  });

  it('never exceeds the hard ceiling', () => {
    expect(resolveTimeout(SANDBOX_LIMITS.maxCommandTimeoutMs + 60_000, 1_800_000)).toBe(
      SANDBOX_LIMITS.maxCommandTimeoutMs,
    );
  });

  it('shrinks to whatever is left of the session', () => {
    expect(resolveTimeout(120_000, 45_000)).toBe(45_000);
  });

  it('refuses once too little of the session remains to be useful', () => {
    expect(codeOf(() => resolveTimeout(1_000, 10))).toBe('SANDBOX_EXPIRED');
    expect(codeOf(() => resolveTimeout(1_000, -5_000))).toBe('SANDBOX_EXPIRED');
  });

  it('refuses a nonsense time limit', () => {
    expect(codeOf(() => resolveTimeout(10, 1_800_000))).toBe('SANDBOX_COMMAND_INVALID');
    expect(codeOf(() => resolveTimeout(1.5, 1_800_000))).toBe('SANDBOX_COMMAND_INVALID');
  });
});

describe('assertUsable', () => {
  it('allows a ready sandbox with time left', () => {
    expect(() => {
      assertUsable(readyStatus());
    }).not.toThrow();
  });

  it.each(['creating', 'terminating', 'terminated', 'failed'] as const)(
    'refuses a sandbox that is %s',
    (state) => {
      expect(
        codeOf(() => {
          assertUsable(readyStatus({ state }));
        }),
      ).toBe('SANDBOX_NOT_READY');
    },
  );

  it('refuses a ready sandbox that has run out of time', () => {
    expect(
      codeOf(() => {
        assertUsable(readyStatus({ remainingMs: 0 }));
      }),
    ).toBe('SANDBOX_EXPIRED');
  });
});

describe('describeSandboxForLog', () => {
  it('reports state without leaking anything about the work', () => {
    const described = describeSandboxForLog(
      readyStatus({ commandsRun: 3, outputBytesUsed: 120, remainingMs: -50 }),
    );

    expect(described).toEqual({
      sandboxId: 'sbx_0123456789abcdefghijk',
      state: 'ready',
      commandsRun: 3,
      outputBytesUsed: 120,
      remainingMs: 0,
      terminationReason: null,
    });
  });
});
