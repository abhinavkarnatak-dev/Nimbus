import { generateKeyPairSync, createVerify } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { createTestLogger } from '../http/http.fixtures.js';
import { REDACTED, redactString } from '../logging/redact.js';
import {
  JWT_BACKDATE_SECONDS,
  JWT_MAX_LIFETIME_SECONDS,
  AppJwtError,
  buildAppJwtClaims,
  createAppJwt,
} from './app-jwt.js';
import { FakeGitHubTokenProvider } from './fake-token-provider.js';
import {
  FORBIDDEN_PERMISSIONS,
  SCOPE_PERMISSIONS,
  TOKEN_SCOPE_NAMES,
  TokenScopeError,
  assertNarrowScope,
  grantedPermissionsAreWithin,
  permissionsFor,
  scopeCacheKey,
  type TokenScope,
} from './permissions.js';
import { describeTokenForLog, isUsable, type InstallationToken } from './token-provider.js';

const APP_ID = '123456';
const keyPair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PRIVATE_KEY = keyPair.privateKey.export({ type: 'pkcs1', format: 'pem' });

function decodeSegment(segment: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')) as Record<string, unknown>;
}

function scope(overrides: Partial<TokenScope> = {}): TokenScope {
  return { installationId: 55_000_001, repositoryId: 1_296_269, scope: 'read', ...overrides };
}

describe('the app token', () => {
  it('has three parts and says it is RS256', () => {
    const jwt = createAppJwt(APP_ID, PRIVATE_KEY);
    const parts = jwt.split('.');

    expect(parts).toHaveLength(3);
    expect(decodeSegment(parts[0] ?? '')).toEqual({ alg: 'RS256', typ: 'JWT' });
  });

  it('says which app it belongs to', () => {
    const claims = decodeSegment(createAppJwt(APP_ID, PRIVATE_KEY).split('.')[1] ?? '');

    expect(claims['iss']).toBe(APP_ID);
  });

  it('is backdated, because server clocks drift', () => {
    const now = 1_800_000_000;
    const claims = buildAppJwtClaims(APP_ID, now);

    expect(claims.iat).toBe(now - JWT_BACKDATE_SECONDS);
    expect(claims.iat).toBeLessThan(now);
  });

  it('never asks for longer than GitHub allows', () => {
    const now = 1_800_000_000;
    const claims = buildAppJwtClaims(APP_ID, now);

    expect(claims.exp - claims.iat).toBeLessThanOrEqual(JWT_MAX_LIFETIME_SECONDS);
    expect(claims.exp - now).toBeLessThan(JWT_MAX_LIFETIME_SECONDS);
    expect(claims.exp).toBeGreaterThan(now);
  });

  it('is really signed by the private key', () => {
    const jwt = createAppJwt(APP_ID, PRIVATE_KEY);
    const [header, payload, signature] = jwt.split('.');

    const verified = createVerify('RSA-SHA256')
      .update(`${header ?? ''}.${payload ?? ''}`)
      .verify(keyPair.publicKey, Buffer.from(signature ?? '', 'base64url'));

    expect(verified).toBe(true);
  });

  it('cannot be verified with somebody else key', () => {
    const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const jwt = createAppJwt(APP_ID, PRIVATE_KEY);
    const [header, payload, signature] = jwt.split('.');

    const verified = createVerify('RSA-SHA256')
      .update(`${header ?? ''}.${payload ?? ''}`)
      .verify(other.publicKey, Buffer.from(signature ?? '', 'base64url'));

    expect(verified).toBe(false);
  });

  it('never contains the private key', () => {
    expect(createAppJwt(APP_ID, PRIVATE_KEY)).not.toContain('PRIVATE KEY');
  });

  it('fails clearly when the key is not usable', () => {
    expect(() => createAppJwt(APP_ID, 'not-a-key')).toThrow(AppJwtError);
  });

  it('reports a key problem without printing the key', () => {
    try {
      createAppJwt(
        APP_ID,
        '-----BEGIN RSA PRIVATE KEY-----\nrubbish\n-----END RSA PRIVATE KEY-----',
      );
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as AppJwtError).message).not.toContain('rubbish');
    }
  });
});

describe('permission sets', () => {
  it('gives reading the least it can', () => {
    expect(SCOPE_PERMISSIONS.read).toEqual({ metadata: 'read', contents: 'read' });
  });

  it('only adds write where an operation truly needs it', () => {
    expect(SCOPE_PERMISSIONS.push).toEqual({ metadata: 'read', contents: 'write' });
    expect(SCOPE_PERMISSIONS.pullRequest).toEqual({
      metadata: 'read',
      contents: 'write',
      pull_requests: 'write',
    });
  });

  it('never asks for anything the threat model forbids', () => {
    for (const name of TOKEN_SCOPE_NAMES) {
      for (const permission of Object.keys(permissionsFor(name))) {
        expect(FORBIDDEN_PERMISSIONS).not.toContain(permission);
      }
    }
  });

  it('keeps metadata read only in every set', () => {
    for (const name of TOKEN_SCOPE_NAMES) {
      expect(permissionsFor(name)['metadata']).toBe('read');
    }
  });
});

describe('the narrowing guard', () => {
  it('accepts a properly narrowed request', () => {
    expect(() => {
      assertNarrowScope(scope());
    }).not.toThrow();
  });

  it('refuses a request with no repository', () => {
    expect(() => {
      assertNarrowScope(scope({ repositoryId: 0 }));
    }).toThrow(TokenScopeError);
  });

  it('refuses a repository that is not a real id', () => {
    expect(() => {
      assertNarrowScope(scope({ repositoryId: -1 }));
    }).toThrow(TokenScopeError);
    expect(() => {
      assertNarrowScope(scope({ repositoryId: 1.5 }));
    }).toThrow(TokenScopeError);
  });

  it('refuses a request with no installation', () => {
    expect(() => {
      assertNarrowScope(scope({ installationId: 0 }));
    }).toThrow(TokenScopeError);
  });

  it('refuses a scope nobody defined', () => {
    expect(() => {
      assertNarrowScope(scope({ scope: 'admin' as TokenScope['scope'] }));
    }).toThrow(TokenScopeError);
  });
});

describe('what GitHub gives back', () => {
  it('accepts exactly what was asked for', () => {
    expect(grantedPermissionsAreWithin({ metadata: 'read', contents: 'read' }, 'read')).toBe(true);
  });

  it('accepts less than was asked for', () => {
    expect(grantedPermissionsAreWithin({ metadata: 'read', contents: 'read' }, 'push')).toBe(true);
  });

  it('refuses a wider level than was asked for', () => {
    expect(grantedPermissionsAreWithin({ metadata: 'read', contents: 'write' }, 'read')).toBe(
      false,
    );
  });

  it('refuses a permission that was never requested', () => {
    expect(
      grantedPermissionsAreWithin({ metadata: 'read', contents: 'read', actions: 'write' }, 'read'),
    ).toBe(false);
  });
});

describe('cache keys', () => {
  it('separate different repositories', () => {
    expect(scopeCacheKey(scope({ repositoryId: 1 }))).not.toBe(
      scopeCacheKey(scope({ repositoryId: 2 })),
    );
  });

  it('separate different permission sets, so a read token cannot serve a write', () => {
    expect(scopeCacheKey(scope({ scope: 'read' }))).not.toBe(
      scopeCacheKey(scope({ scope: 'push' })),
    );
  });

  it('separate different installations', () => {
    expect(scopeCacheKey(scope({ installationId: 1 }))).not.toBe(
      scopeCacheKey(scope({ installationId: 2 })),
    );
  });
});

describe('deciding a token is too old', () => {
  const token = (secondsLeft: number): InstallationToken => ({
    token: 'ghs_example',
    expiresAt: new Date(Date.now() + secondsLeft * 1000),
    repositoryId: 1,
    scope: 'read',
  });

  it('uses a token with plenty of life left', () => {
    expect(isUsable(token(3_600))).toBe(true);
  });

  it('discards one that is about to expire, rather than failing mid operation', () => {
    expect(isUsable(token(30))).toBe(false);
    expect(isUsable(token(299))).toBe(false);
  });

  it('discards one that already expired', () => {
    expect(isUsable(token(-10))).toBe(false);
  });
});

describe('what a token looks like in the logs', () => {
  it('describes it without including it', () => {
    const described = describeTokenForLog({
      token: 'ghs_supersecrettokenvalue',
      expiresAt: new Date('2026-08-11T12:00:00.000Z'),
      repositoryId: 1_296_269,
      scope: 'push',
    });

    expect(JSON.stringify(described)).not.toContain('ghs_supersecrettokenvalue');
    expect(described['repositoryId']).toBe(1_296_269);
    expect(described['scope']).toBe('push');
  });
});

describe('the strict fake', () => {
  it('gives a token for a properly narrowed request', async () => {
    const provider = new FakeGitHubTokenProvider();

    const token = await provider.getToken(scope());

    expect(token.token).toMatch(/^ghs_/);
    expect(token.repositoryId).toBe(1_296_269);
    expect(token.scope).toBe('read');
  });

  it('mints tokens shaped the way GitHub really shapes them', async () => {
    const provider = new FakeGitHubTokenProvider();

    const token = await provider.getToken(scope());

    expect(token.token).toMatch(/^ghs_[A-Za-z0-9]{36}$/);
  });

  it('refuses a request with no repository, the way a careful caller never would', async () => {
    const provider = new FakeGitHubTokenProvider();

    await expect(provider.getToken(scope({ repositoryId: 0 }))).rejects.toThrow(TokenScopeError);
  });

  it('refuses an installation it has never heard of', async () => {
    const provider = new FakeGitHubTokenProvider({ knownInstallationIds: [42] });

    await expect(provider.getToken(scope({ installationId: 99 }))).rejects.toThrow();
  });

  it('records exactly what was asked for, so tests can check the narrowing', async () => {
    const provider = new FakeGitHubTokenProvider();

    await provider.getToken(scope({ scope: 'pullRequest' }));

    expect(provider.requests[0]).toEqual({
      installationId: 55_000_001,
      repositoryId: 1_296_269,
      scope: 'pullRequest',
    });
  });

  it('reuses a live token instead of minting again', async () => {
    const provider = new FakeGitHubTokenProvider();

    const first = await provider.getToken(scope());
    const second = await provider.getToken(scope());

    expect(second.token).toBe(first.token);
    expect(provider.mintCount).toBe(1);
  });

  it('mints separately for a different repository', async () => {
    const provider = new FakeGitHubTokenProvider();

    const first = await provider.getToken(scope({ repositoryId: 1 }));
    const second = await provider.getToken(scope({ repositoryId: 2 }));

    expect(second.token).not.toBe(first.token);
    expect(provider.mintCount).toBe(2);
  });

  it('mints separately for a wider permission set', async () => {
    const provider = new FakeGitHubTokenProvider();

    const reading = await provider.getToken(scope({ scope: 'read' }));
    const pushing = await provider.getToken(scope({ scope: 'push' }));

    expect(pushing.token).not.toBe(reading.token);
    expect(pushing.scope).toBe('push');
  });

  it('mints a fresh token once the old one is too old', async () => {
    const provider = new FakeGitHubTokenProvider();

    const first = await provider.getToken(scope());
    provider.expireEverything();
    const second = await provider.getToken(scope());

    expect(second.token).not.toBe(first.token);
    expect(provider.mintCount).toBe(2);
  });

  it('forgets a token once it has been handed back', async () => {
    const provider = new FakeGitHubTokenProvider();

    const first = await provider.getToken(scope());
    await provider.revoke(first);
    const second = await provider.getToken(scope());

    expect(provider.revoked).toEqual([first.token]);
    expect(second.token).not.toBe(first.token);
  });
});

describe('both shapes of real GitHub token are masked', () => {
  const SHORT = ['ghs', 'notARealTokenItOnlyExistsForThisTest'].join('_');
  const LONG = `ghs_${'A'.repeat(60)}.${'B'.repeat(160)}.${'C'.repeat(160)}`;

  it('masks the short form completely', () => {
    expect(redactString(`failed using ${SHORT} while pushing`)).toBe(
      `failed using ${REDACTED} while pushing`,
    );
  });

  it('masks the long dotted form completely, not just its first segment', () => {
    const redacted = redactString(`failed using ${LONG} while pushing`);

    expect(redacted).toBe(`failed using ${REDACTED} while pushing`);
    expect(redacted).not.toContain('B'.repeat(12));
    expect(redacted).not.toContain('C'.repeat(12));
  });

  it('leaves no readable run of a long token behind', () => {
    const redacted = redactString(LONG);

    for (let start = 0; start + 12 <= LONG.length; start += 1) {
      expect(redacted).not.toContain(LONG.slice(start, start + 12));
    }
  });

  it('does not swallow an ordinary sentence after a token', () => {
    const redacted = redactString(`token was ${SHORT}. Then it failed.`);

    expect(redacted).toContain('Then it failed.');
  });
});

describe('a token never reaches the logs', () => {
  it('holds even when the caller logs the whole object carelessly', async () => {
    const { logger, lines } = createTestLogger();
    const provider = new FakeGitHubTokenProvider();

    const token = await provider.getToken(scope());
    logger.info({ token }, 'a careless log line');

    expect(JSON.stringify(lines)).not.toContain(token.token);
  });

  it('holds when the token is buried inside a message string', async () => {
    const { logger, lines } = createTestLogger();
    const provider = new FakeGitHubTokenProvider();

    const token = await provider.getToken(scope());
    logger.warn(`something went wrong using ${token.token}`);

    expect(JSON.stringify(lines)).not.toContain(token.token);
  });
});
