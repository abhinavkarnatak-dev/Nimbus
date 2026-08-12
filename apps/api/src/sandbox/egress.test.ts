import { describe, expect, it } from 'vitest';

import {
  ALL_TRAFFIC,
  BLOCKED_RANGES,
  EGRESS_ALLOWED_HOSTS,
  MAX_EGRESS_HOSTS,
  MAX_EGRESS_SECONDS,
  assertEgressHost,
  assertEgressSeconds,
  closedNetwork,
  looksLikeAddress,
  openedNetwork,
} from './egress.js';
import { SandboxError } from './provider.js';

function codeOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return error instanceof SandboxError ? error.code : 'NOT_A_SANDBOX_ERROR';
  }
  return 'NOTHING_THROWN';
}

describe('closedNetwork', () => {
  it('denies all outbound traffic', () => {
    expect(closedNetwork()).toEqual({ denyOut: [ALL_TRAFFIC] });
  });

  it('names no allowed destination at all', () => {
    expect(closedNetwork().allowOut).toBeUndefined();
  });

  it('is a fresh object each time, so nobody can edit the shared policy', () => {
    const first = closedNetwork();
    first.denyOut.push('example.com');

    expect(closedNetwork().denyOut).toEqual([ALL_TRAFFIC]);
  });
});

describe('assertEgressHost', () => {
  it.each(EGRESS_ALLOWED_HOSTS)('accepts %s', (host) => {
    expect(() => {
      assertEgressHost(host);
    }).not.toThrow();
  });

  it('refuses a host nobody wrote down', () => {
    expect(
      codeOf(() => {
        assertEgressHost('evil.com');
      }),
    ).toBe('SANDBOX_EGRESS_REFUSED');
  });

  it.each([
    ['loopback', '127.0.0.1'],
    ['the cloud metadata address', '169.254.169.254'],
    ['a private address', '10.0.0.5'],
    ['another private address', '192.168.1.1'],
    ['a public address', '8.8.8.8'],
    ['an ipv6 address', '::1'],
    ['a bare number', '2130706433'],
  ])('refuses %s, because a sandbox may only reach a name', (_label, host) => {
    expect(
      codeOf(() => {
        assertEgressHost(host);
      }),
    ).toBe('SANDBOX_EGRESS_REFUSED');
  });

  it.each([
    ['localhost', 'localhost'],
    ['an internal name', 'metadata.google.internal'],
    ['a cluster name', 'redis.svc'],
    ['a local name', 'db.local'],
  ])('refuses %s', (_label, host) => {
    expect(
      codeOf(() => {
        assertEgressHost(host);
      }),
    ).toBe('SANDBOX_EGRESS_REFUSED');
  });

  it.each([
    ['a host with a path', 'github.com/evil'],
    ['a host with a port', 'github.com:443'],
    ['a host with a scheme', 'https://github.com'],
    ['a host with a space', 'github.com evil.com'],
    ['a host with a credential', 'user@github.com'],
    ['an empty host', ''],
    ['a trailing dot', 'github.com.'],
    ['a wildcard', '*.github.com'],
  ])('refuses %s', (_label, host) => {
    expect(
      codeOf(() => {
        assertEgressHost(host);
      }),
    ).toBe('SANDBOX_EGRESS_REFUSED');
  });

  it('refuses a host that is only allowed after cleaning it up', () => {
    expect(
      codeOf(() => {
        assertEgressHost(' github.com ');
      }),
    ).toBe('SANDBOX_EGRESS_REFUSED');
    expect(
      codeOf(() => {
        assertEgressHost('GitHub.com');
      }),
    ).toBe('SANDBOX_EGRESS_REFUSED');
  });
});

describe('looksLikeAddress', () => {
  it.each(['1.2.3.4', '::1', 'fe80::1', '2130706433'])('spots %s', (value) => {
    expect(looksLikeAddress(value)).toBe(true);
  });

  it('does not mistake a name for an address', () => {
    expect(looksLikeAddress('github.com')).toBe(false);
  });
});

describe('openedNetwork', () => {
  it('allows only the named hosts', () => {
    expect(openedNetwork(['github.com']).allowOut).toEqual(['github.com']);
  });

  it('still denies everything else, and the private ranges by name', () => {
    const policy = openedNetwork(['github.com']);

    expect(policy.denyOut).toEqual([ALL_TRAFFIC, ...BLOCKED_RANGES]);
    expect(policy.denyOut[0]).toBe(ALL_TRAFFIC);
    expect(policy.denyOut).toContain('169.254.0.0/16');
    expect(policy.denyOut).toContain('127.0.0.0/8');
    expect(policy.denyOut).toContain('10.0.0.0/8');
    expect(policy.denyOut).toContain('192.168.0.0/16');
    expect(policy.denyOut).toContain('fc00::/7');
  });

  it('removes a repeated host', () => {
    expect(openedNetwork(['github.com', 'github.com']).allowOut).toEqual(['github.com']);
  });

  it('refuses an empty window, because that is a closed network written confusingly', () => {
    expect(codeOf(() => openedNetwork([]))).toBe('SANDBOX_EGRESS_REFUSED');
  });

  it('refuses more hosts than the cap', () => {
    const hosts = new Array<string>(MAX_EGRESS_HOSTS + 1).fill('github.com');
    expect(codeOf(() => openedNetwork(hosts))).toBe('SANDBOX_EGRESS_REFUSED');
  });

  it('refuses the whole internet even when asked politely', () => {
    expect(codeOf(() => openedNetwork([ALL_TRAFFIC]))).toBe('SANDBOX_EGRESS_REFUSED');
    expect(codeOf(() => openedNetwork(['0.0.0.0/0']))).toBe('SANDBOX_EGRESS_REFUSED');
  });

  it('refuses a window where one host out of several is not allowed', () => {
    expect(codeOf(() => openedNetwork(['github.com', 'evil.com']))).toBe('SANDBOX_EGRESS_REFUSED');
  });
});

describe('assertEgressSeconds', () => {
  it('accepts a short window', () => {
    expect(() => {
      assertEgressSeconds(60);
    }).not.toThrow();
  });

  it.each([0, -1, 1.5, Number.NaN, MAX_EGRESS_SECONDS + 1, 86_400])('refuses %s', (seconds) => {
    expect(
      codeOf(() => {
        assertEgressSeconds(seconds);
      }),
    ).toBe('SANDBOX_EGRESS_REFUSED');
  });
});

describe('the allowlist itself', () => {
  it('names only hosts needed to fetch a public repository or its dependencies', () => {
    expect(EGRESS_ALLOWED_HOSTS).toEqual([
      'github.com',
      'codeload.github.com',
      'objects.githubusercontent.com',
      'raw.githubusercontent.com',
      'registry.npmjs.org',
    ]);
  });

  it('holds no address and no internal name', () => {
    for (const host of EGRESS_ALLOWED_HOSTS) {
      expect(looksLikeAddress(host)).toBe(false);
      expect(host.endsWith('.internal')).toBe(false);
    }
  });
});
