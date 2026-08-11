import { randomBytes } from 'node:crypto';

import {
  assertNarrowScope,
  scopeCacheKey,
  TokenScopeError,
  type TokenScope,
} from './permissions.js';
import {
  EXPIRY_MARGIN_SECONDS,
  GitHubTokenError,
  isUsable,
  type GitHubTokenProvider,
  type InstallationToken,
} from './token-provider.js';

export const FAKE_TOKEN_LIFETIME_SECONDS = 3_600;
export const GITHUB_TOKEN_BODY_LENGTH = 36;

const TOKEN_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

function fakeTokenBody(): string {
  const bytes = randomBytes(GITHUB_TOKEN_BODY_LENGTH);
  const characters: string[] = [];

  for (const byte of bytes) {
    characters.push(TOKEN_ALPHABET.charAt(byte % TOKEN_ALPHABET.length));
  }
  return characters.join('');
}

export interface FakeTokenProviderOptions {
  knownInstallationIds?: readonly number[];
  lifetimeSeconds?: number;
  expiryMarginSeconds?: number;
}

export class FakeGitHubTokenProvider implements GitHubTokenProvider {
  readonly name = 'github-fake';

  readonly requests: TokenScope[] = [];
  readonly revoked: string[] = [];

  private readonly known: Set<number> | undefined;
  private readonly lifetimeSeconds: number;
  private readonly marginSeconds: number;
  private readonly cache = new Map<string, InstallationToken>();
  private failure: GitHubTokenError | undefined;
  private issued = 0;

  constructor(options: FakeTokenProviderOptions = {}) {
    this.known =
      options.knownInstallationIds === undefined
        ? undefined
        : new Set(options.knownInstallationIds);
    this.lifetimeSeconds = options.lifetimeSeconds ?? FAKE_TOKEN_LIFETIME_SECONDS;
    this.marginSeconds = options.expiryMarginSeconds ?? EXPIRY_MARGIN_SECONDS;
  }

  get mintCount(): number {
    return this.issued;
  }

  async getToken(scope: TokenScope): Promise<InstallationToken> {
    assertNarrowScope(scope);
    this.requests.push({ ...scope });

    if (this.known !== undefined && !this.known.has(scope.installationId)) {
      throw new GitHubTokenError(
        'GITHUB_INSTALLATION_UNAVAILABLE',
        'That GitHub installation is no longer available.',
      );
    }

    if (this.failure !== undefined) {
      throw this.failure;
    }

    const key = scopeCacheKey(scope);
    const cached = this.cache.get(key);
    if (cached !== undefined && isUsable(cached, this.marginSeconds)) {
      return cached;
    }

    this.issued += 1;
    const token: InstallationToken = {
      token: `ghs_${fakeTokenBody()}`,
      expiresAt: new Date(Date.now() + this.lifetimeSeconds * 1000),
      repositoryId: scope.repositoryId,
      scope: scope.scope,
    };

    this.cache.set(key, token);
    await Promise.resolve();
    return token;
  }

  async revoke(token: InstallationToken): Promise<void> {
    this.revoked.push(token.token);

    for (const [key, cached] of this.cache) {
      if (cached.token === token.token) {
        this.cache.delete(key);
      }
    }
    await Promise.resolve();
  }

  clearCache(): void {
    this.cache.clear();
  }

  expireEverything(): void {
    for (const [key, token] of this.cache) {
      this.cache.set(key, { ...token, expiresAt: new Date(Date.now() - 1_000) });
    }
  }

  willFail(error: GitHubTokenError): void {
    this.failure = error;
  }

  stopFailing(): void {
    this.failure = undefined;
  }

  reset(): void {
    this.cache.clear();
    this.requests.length = 0;
    this.revoked.length = 0;
    this.failure = undefined;
    this.issued = 0;
  }
}

export { TokenScopeError };
