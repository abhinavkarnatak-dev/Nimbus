import { Octokit } from '@octokit/rest';

import type { GitHubConfig } from '../config/load.js';
import type { Logger } from '../logging/logger.js';
import { redactValue } from '../logging/redact.js';
import { createAppJwt } from './app-jwt.js';
import {
  LISTING_PERMISSIONS,
  assertListingScope,
  assertNarrowScope,
  listingCacheKey,
  permissionsFor,
  scopeCacheKey,
  type TokenPermissions,
  type TokenScope,
} from './permissions.js';

export const EXPIRY_MARGIN_SECONDS = 300;
export const REQUEST_TIMEOUT_MS = 10_000;

export const LISTING_SCOPE = 'listRepositories';

export interface InstallationToken {
  token: string;
  expiresAt: Date;
  repositoryId: number | null;
  scope: TokenScope['scope'] | typeof LISTING_SCOPE;
}

export interface GitHubTokenProvider {
  readonly name: string;
  getToken(scope: TokenScope): Promise<InstallationToken>;
  getListingToken(installationId: number): Promise<InstallationToken>;
  revoke(token: InstallationToken): Promise<void>;
  clearCache(): void;
}

export const GITHUB_TOKEN_ERROR_CODES = [
  'GITHUB_APP_UNAUTHENTICATED',
  'GITHUB_INSTALLATION_UNAVAILABLE',
  'GITHUB_TOKEN_REFUSED',
  'GITHUB_TOKEN_TOO_BROAD',
] as const;

export type GitHubTokenErrorCode = (typeof GITHUB_TOKEN_ERROR_CODES)[number];

export class GitHubTokenError extends Error {
  readonly code: GitHubTokenErrorCode;

  constructor(code: GitHubTokenErrorCode, message: string, options: { cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'GitHubTokenError';
    this.code = code;
  }
}

export function grantedPermissionsWithin(
  granted: Readonly<Record<string, string>>,
  requested: Readonly<Record<string, string>>,
): boolean {
  return Object.entries(granted).every(([name, level]) => {
    const permitted = requested[name];
    if (permitted === undefined) {
      return false;
    }
    return permitted === 'write' || level === 'read';
  });
}

export function isUsable(
  token: InstallationToken,
  marginSeconds = EXPIRY_MARGIN_SECONDS,
  now: Date = new Date(),
): boolean {
  return token.expiresAt.getTime() - now.getTime() > marginSeconds * 1000;
}

export function describeTokenForLog(token: InstallationToken): Record<string, unknown> {
  return {
    repositoryId: token.repositoryId,
    scope: token.scope,
    expiresAt: token.expiresAt.toISOString(),
  };
}

interface ErrorWithStatus {
  status?: unknown;
}

function statusOf(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }
  const status = (error as ErrorWithStatus).status;
  return typeof status === 'number' ? status : undefined;
}

export interface MintRequest {
  installationId: number;
  repositoryIds?: number[];
  permissions: Readonly<Record<string, string>>;
}

export interface MintResponse {
  token: string;
  expiresAt: string;
  permissions: Readonly<Record<string, string>>;
}

export interface GitHubTransport {
  mint(appJwt: string, request: MintRequest): Promise<MintResponse>;
  revoke(token: string): Promise<void>;
}

export interface GitHubTokenProviderOptions {
  github: GitHubConfig;
  logger: Logger;
  expiryMarginSeconds?: number;
  timeoutMs?: number;
  transport?: GitHubTransport;
}

export function createOctokitTransport(timeoutMs: number): GitHubTransport {
  return {
    async mint(appJwt, request) {
      const response = await new Octokit({
        auth: appJwt,
        request: { timeout: timeoutMs },
      }).rest.apps.createInstallationAccessToken({
        installation_id: request.installationId,
        ...(request.repositoryIds === undefined ? {} : { repository_ids: request.repositoryIds }),
        permissions: request.permissions,
      });

      return {
        token: response.data.token,
        expiresAt: response.data.expires_at,
        permissions: response.data.permissions ?? {},
      };
    },

    async revoke(token) {
      await new Octokit({
        auth: token,
        request: { timeout: timeoutMs },
      }).rest.apps.revokeInstallationAccessToken();
    },
  };
}

export class GitHubAppTokenProvider implements GitHubTokenProvider {
  readonly name = 'github';

  private readonly github: GitHubConfig;
  private readonly logger: Logger;
  private readonly marginSeconds: number;
  private readonly timeoutMs: number;
  private readonly cache = new Map<string, InstallationToken>();
  private readonly inFlight = new Map<string, Promise<InstallationToken>>();
  private readonly transport: GitHubTransport;

  constructor(options: GitHubTokenProviderOptions) {
    this.github = options.github;
    this.logger = options.logger;
    this.marginSeconds = options.expiryMarginSeconds ?? EXPIRY_MARGIN_SECONDS;
    this.timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
    this.transport = options.transport ?? createOctokitTransport(this.timeoutMs);
  }

  async getToken(scope: TokenScope): Promise<InstallationToken> {
    assertNarrowScope(scope);

    return this.cached(scopeCacheKey(scope), async () =>
      this.mint({
        installationId: scope.installationId,
        repositoryIds: [scope.repositoryId],
        permissions: permissionsFor(scope.scope),
        repositoryId: scope.repositoryId,
        scope: scope.scope,
      }),
    );
  }

  async getListingToken(installationId: number): Promise<InstallationToken> {
    assertListingScope(installationId);

    return this.cached(listingCacheKey(installationId), async () =>
      this.mint({
        installationId,
        permissions: LISTING_PERMISSIONS,
        repositoryId: null,
        scope: LISTING_SCOPE,
      }),
    );
  }

  private async cached(
    key: string,
    mint: () => Promise<InstallationToken>,
  ): Promise<InstallationToken> {
    const cached = this.cache.get(key);

    if (cached !== undefined && isUsable(cached, this.marginSeconds)) {
      return cached;
    }
    this.cache.delete(key);

    const existing = this.inFlight.get(key);
    if (existing !== undefined) {
      return existing;
    }

    const pending = mint()
      .then((token) => {
        this.cache.set(key, token);
        return token;
      })
      .finally(() => {
        this.inFlight.delete(key);
      });

    this.inFlight.set(key, pending);
    return pending;
  }

  async revoke(token: InstallationToken): Promise<void> {
    try {
      await this.transport.revoke(token.token);

      for (const [key, cached] of this.cache) {
        if (cached.token === token.token) {
          this.cache.delete(key);
        }
      }
    } catch (error) {
      this.logger.warn(
        { ...describeTokenForLog(token), err: redactValue(error) },
        'Could not hand a GitHub token back early, it will expire on its own',
      );
    }
  }

  clearCache(): void {
    this.cache.clear();
  }

  private async mint(request: {
    installationId: number;
    repositoryIds?: number[];
    permissions: TokenPermissions;
    repositoryId: number | null;
    scope: InstallationToken['scope'];
  }): Promise<InstallationToken> {
    let response: MintResponse;
    try {
      response = await this.transport.mint(
        createAppJwt(this.github.appId, this.github.privateKeyPem),
        {
          installationId: request.installationId,
          ...(request.repositoryIds === undefined ? {} : { repositoryIds: request.repositoryIds }),
          permissions: request.permissions,
        },
      );
    } catch (error) {
      const status = statusOf(error);

      this.logger.error(
        {
          installationId: request.installationId,
          repositoryId: request.repositoryId,
          scope: request.scope,
          status,
          err: redactValue(error),
        },
        'GitHub refused to issue an installation token',
      );

      if (status === 401) {
        throw new GitHubTokenError(
          'GITHUB_APP_UNAUTHENTICATED',
          'Nimbus could not prove itself to GitHub.',
          { cause: error },
        );
      }
      if (status === 404) {
        throw new GitHubTokenError(
          'GITHUB_INSTALLATION_UNAVAILABLE',
          'That GitHub installation is no longer available.',
          { cause: error },
        );
      }
      throw new GitHubTokenError(
        'GITHUB_TOKEN_REFUSED',
        'GitHub would not give Nimbus access to that repository.',
        { cause: error },
      );
    }

    if (!grantedPermissionsWithin(response.permissions, request.permissions)) {
      throw new GitHubTokenError(
        'GITHUB_TOKEN_TOO_BROAD',
        'GitHub returned wider access than Nimbus asked for.',
      );
    }

    const token: InstallationToken = {
      token: response.token,
      expiresAt: new Date(response.expiresAt),
      repositoryId: request.repositoryId,
      scope: request.scope,
    };

    this.logger.info(
      { installationId: request.installationId, ...describeTokenForLog(token) },
      'Minted a narrowed GitHub token',
    );

    return token;
  }
}
