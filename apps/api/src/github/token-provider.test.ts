import { generateKeyPairSync } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { createTestLogger } from '../http/http.fixtures.js';
import { TokenScopeError, type TokenScope } from './permissions.js';
import {
  GitHubAppTokenProvider,
  GitHubTokenError,
  type GitHubTransport,
  type MintRequest,
  type MintResponse,
} from './token-provider.js';

const keyPair = generateKeyPairSync('rsa', { modulusLength: 2048 });

const GITHUB_CONFIG = {
  appId: '123456',
  appSlug: 'nimbus-test',
  privateKeyPem: keyPair.privateKey.export({ type: 'pkcs1', format: 'pem' }),
  webhookSecret: 'webhook-secret',
  setupCallbackUrl: 'http://localhost:4000/github/setup/callback',
};

function scope(overrides: Partial<TokenScope> = {}): TokenScope {
  return { installationId: 55_000_001, repositoryId: 1_296_269, scope: 'read', ...overrides };
}

interface RecordingTransport extends GitHubTransport {
  readonly mints: MintRequest[];
  readonly appJwts: string[];
  readonly revoked: string[];
}

function transport(
  options: {
    lifetimeSeconds?: number;
    permissions?: Record<string, string>;
    failWith?: Error;
    delayMs?: number;
    revokeFails?: boolean;
  } = {},
): RecordingTransport {
  const mints: MintRequest[] = [];
  const appJwts: string[] = [];
  const revoked: string[] = [];
  let issued = 0;

  return {
    mints,
    appJwts,
    revoked,

    async mint(appJwt: string, request: MintRequest): Promise<MintResponse> {
      appJwts.push(appJwt);
      mints.push(request);

      if (options.delayMs !== undefined) {
        await new Promise((resolve) => setTimeout(resolve, options.delayMs));
      }
      if (options.failWith !== undefined) {
        throw options.failWith;
      }

      issued += 1;
      return {
        token: `ghs_${String(issued).padStart(36, 'x')}`,
        expiresAt: new Date(Date.now() + (options.lifetimeSeconds ?? 3_600) * 1000).toISOString(),
        permissions: options.permissions ?? request.permissions,
      };
    },

    async revoke(token: string): Promise<void> {
      revoked.push(token);
      await Promise.resolve();
      if (options.revokeFails === true) {
        throw new Error('revocation failed');
      }
    },
  };
}

function build(
  wire: GitHubTransport,
  overrides: { expiryMarginSeconds?: number } = {},
): { provider: GitHubAppTokenProvider; lines: ReturnType<typeof createTestLogger>['lines'] } {
  const { logger, lines } = createTestLogger();

  return {
    provider: new GitHubAppTokenProvider({
      github: GITHUB_CONFIG,
      logger,
      transport: wire,
      ...(overrides.expiryMarginSeconds === undefined
        ? {}
        : { expiryMarginSeconds: overrides.expiryMarginSeconds }),
    }),
    lines,
  };
}

describe('what the real provider sends to GitHub', () => {
  it('narrows to exactly one repository', async () => {
    const wire = transport();
    const { provider } = build(wire);

    await provider.getToken(scope());

    expect(wire.mints[0]?.repositoryIds).toEqual([1_296_269]);
  });

  it('sends only the permissions the named scope allows', async () => {
    const wire = transport();
    const { provider } = build(wire);

    await provider.getToken(scope({ scope: 'push' }));

    expect(wire.mints[0]?.permissions).toEqual({ metadata: 'read', contents: 'write' });
  });

  it('authenticates with a freshly signed app token, not a stored credential', async () => {
    const wire = transport();
    const { provider } = build(wire);

    await provider.getToken(scope());

    const jwt = wire.appJwts[0] ?? '';
    expect(jwt.split('.')).toHaveLength(3);
    expect(jwt).not.toContain('PRIVATE KEY');
  });

  it('refuses to send an unnarrowed request at all', async () => {
    const wire = transport();
    const { provider } = build(wire);

    await expect(provider.getToken(scope({ repositoryId: 0 }))).rejects.toThrow(TokenScopeError);
    expect(wire.mints).toHaveLength(0);
  });
});

describe('the real cache', () => {
  it('reuses a live token instead of asking GitHub again', async () => {
    const wire = transport();
    const { provider } = build(wire);

    const first = await provider.getToken(scope());
    const second = await provider.getToken(scope());

    expect(second.token).toBe(first.token);
    expect(wire.mints).toHaveLength(1);
  });

  it('keeps repositories apart', async () => {
    const wire = transport();
    const { provider } = build(wire);

    await provider.getToken(scope({ repositoryId: 1 }));
    await provider.getToken(scope({ repositoryId: 2 }));

    expect(wire.mints).toHaveLength(2);
  });

  it('never serves a read token to something that asked for write', async () => {
    const wire = transport();
    const { provider } = build(wire);

    const reading = await provider.getToken(scope({ scope: 'read' }));
    const pushing = await provider.getToken(scope({ scope: 'push' }));

    expect(pushing.token).not.toBe(reading.token);
    expect(wire.mints[1]?.permissions).toEqual({ metadata: 'read', contents: 'write' });
  });

  it('mints again rather than handing out a token about to expire', async () => {
    const wire = transport({ lifetimeSeconds: 60 });
    const { provider } = build(wire, { expiryMarginSeconds: 300 });

    await provider.getToken(scope());
    await provider.getToken(scope());

    expect(wire.mints).toHaveLength(2);
  });

  it('keeps a token that still has plenty of life', async () => {
    const wire = transport({ lifetimeSeconds: 3_600 });
    const { provider } = build(wire, { expiryMarginSeconds: 300 });

    await provider.getToken(scope());
    await provider.getToken(scope());

    expect(wire.mints).toHaveLength(1);
  });

  it('forgets everything when cleared', async () => {
    const wire = transport();
    const { provider } = build(wire);

    await provider.getToken(scope());
    provider.clearCache();
    await provider.getToken(scope());

    expect(wire.mints).toHaveLength(2);
  });
});

describe('many callers at once', () => {
  it('asks GitHub once, not once per caller', async () => {
    const wire = transport({ delayMs: 20 });
    const { provider } = build(wire);

    const tokens = await Promise.all(
      Array.from({ length: 10 }, async () => provider.getToken(scope())),
    );

    expect(wire.mints).toHaveLength(1);
    expect(new Set(tokens.map((token) => token.token)).size).toBe(1);
  });

  it('still separates different scopes under load', async () => {
    const wire = transport({ delayMs: 20 });
    const { provider } = build(wire);

    await Promise.all([
      provider.getToken(scope({ scope: 'read' })),
      provider.getToken(scope({ scope: 'read' })),
      provider.getToken(scope({ scope: 'push' })),
      provider.getToken(scope({ scope: 'push' })),
    ]);

    expect(wire.mints).toHaveLength(2);
  });

  it('lets a later caller retry after a failure rather than caching the failure', async () => {
    const failing = transport({ failWith: Object.assign(new Error('boom'), { status: 500 }) });
    const { provider } = build(failing);

    await expect(provider.getToken(scope())).rejects.toThrow(GitHubTokenError);
    await expect(provider.getToken(scope())).rejects.toThrow(GitHubTokenError);

    expect(failing.mints).toHaveLength(2);
  });
});

describe('when GitHub says no', () => {
  const cases = [
    [401, 'GITHUB_APP_UNAUTHENTICATED'],
    [404, 'GITHUB_INSTALLATION_UNAVAILABLE'],
    [500, 'GITHUB_TOKEN_REFUSED'],
    [403, 'GITHUB_TOKEN_REFUSED'],
  ] as const;

  for (const [status, code] of cases) {
    it(`turns ${String(status)} into ${code}`, async () => {
      const wire = transport({ failWith: Object.assign(new Error('nope'), { status }) });
      const { provider } = build(wire);

      try {
        await provider.getToken(scope());
        expect.unreachable('should have thrown');
      } catch (error) {
        expect((error as GitHubTokenError).code).toBe(code);
      }
    });
  }

  it('says nothing useful to an attacker in the message', async () => {
    const wire = transport({
      failWith: Object.assign(new Error('token ghs_leakedvaluehere private key at /etc/secret'), {
        status: 401,
      }),
    });
    const { provider } = build(wire);

    try {
      await provider.getToken(scope());
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as GitHubTokenError).message).not.toContain('ghs_leakedvaluehere');
      expect((error as GitHubTokenError).message).not.toContain('/etc/secret');
    }
  });

  it('caches nothing after a failure', async () => {
    const wire = transport({ failWith: Object.assign(new Error('nope'), { status: 404 }) });
    const { provider } = build(wire);

    await expect(provider.getToken(scope())).rejects.toThrow();
    await expect(provider.getToken(scope())).rejects.toThrow();

    expect(wire.mints).toHaveLength(2);
  });
});

describe('when GitHub grants more than was asked for', () => {
  it('throws the token away rather than using it', async () => {
    const wire = transport({ permissions: { metadata: 'read', contents: 'write' } });
    const { provider } = build(wire);

    try {
      await provider.getToken(scope({ scope: 'read' }));
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as GitHubTokenError).code).toBe('GITHUB_TOKEN_TOO_BROAD');
    }
  });

  it('refuses a permission that was never requested', async () => {
    const wire = transport({
      permissions: { metadata: 'read', contents: 'read', actions: 'write' },
    });
    const { provider } = build(wire);

    await expect(provider.getToken(scope({ scope: 'read' }))).rejects.toThrow(GitHubTokenError);
  });

  it('does not cache a token it refused', async () => {
    const wire = transport({ permissions: { metadata: 'read', contents: 'write' } });
    const { provider } = build(wire);

    await expect(provider.getToken(scope({ scope: 'read' }))).rejects.toThrow();
    await expect(provider.getToken(scope({ scope: 'read' }))).rejects.toThrow();

    expect(wire.mints).toHaveLength(2);
  });
});

describe('handing a token back', () => {
  it('tells GitHub and forgets it locally', async () => {
    const wire = transport();
    const { provider } = build(wire);

    const token = await provider.getToken(scope());
    await provider.revoke(token);
    await provider.getToken(scope());

    expect(wire.revoked).toEqual([token.token]);
    expect(wire.mints).toHaveLength(2);
  });

  it('does not fail the caller when revocation fails', async () => {
    const wire = transport({ revokeFails: true });
    const { provider, lines } = build(wire);

    const token = await provider.getToken(scope());

    await expect(provider.revoke(token)).resolves.toBeUndefined();
    expect(JSON.stringify(lines)).toContain('expire on its own');
  });
});

describe('nothing about a token reaches the logs', () => {
  it('logs the mint without the token', async () => {
    const wire = transport();
    const { provider, lines } = build(wire);

    const token = await provider.getToken(scope());

    expect(JSON.stringify(lines)).toContain('Minted a narrowed GitHub token');
    expect(JSON.stringify(lines)).not.toContain(token.token);
  });

  it('logs a failure without the underlying detail leaking a credential', async () => {
    const wire = transport({
      failWith: Object.assign(new Error('bad token ghs_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'), {
        status: 401,
      }),
    });
    const { provider, lines } = build(wire);

    await expect(provider.getToken(scope())).rejects.toThrow();

    expect(JSON.stringify(lines)).not.toContain('ghs_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  });
});
