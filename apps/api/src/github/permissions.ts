export const TOKEN_SCOPE_NAMES = ['read', 'push', 'pullRequest'] as const;

export type TokenScopeName = (typeof TOKEN_SCOPE_NAMES)[number];

export type PermissionLevel = 'read' | 'write';

export type TokenPermissions = Readonly<Record<string, PermissionLevel>>;

export const SCOPE_PERMISSIONS: Readonly<Record<TokenScopeName, TokenPermissions>> = {
  read: { metadata: 'read', contents: 'read' },
  push: { metadata: 'read', contents: 'write' },
  pullRequest: { metadata: 'read', contents: 'write', pull_requests: 'write' },
};

export const FORBIDDEN_PERMISSIONS = [
  'administration',
  'secrets',
  'actions',
  'workflows',
  'members',
  'organization_administration',
  'organization_secrets',
  'organization_hooks',
  'packages',
  'deployments',
  'environments',
] as const;

export interface TokenScope {
  installationId: number;
  repositoryId: number;
  scope: TokenScopeName;
}

export class TokenScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TokenScopeError';
  }
}

export const LISTING_PERMISSIONS: TokenPermissions = { metadata: 'read' };

export const LISTING_CACHE_KEY_PREFIX = 'listing';

export function listingCacheKey(installationId: number): string {
  return [LISTING_CACHE_KEY_PREFIX, installationId].join(':');
}

export function assertListingScope(installationId: number): void {
  if (!Number.isInteger(installationId) || installationId <= 0) {
    throw new TokenScopeError('A listing token needs a real installation.');
  }
}

export function isTokenScopeName(value: string): value is TokenScopeName {
  return (TOKEN_SCOPE_NAMES as readonly string[]).includes(value);
}

export function permissionsFor(scope: TokenScopeName): TokenPermissions {
  const name: string = scope;

  if (!isTokenScopeName(name)) {
    throw new TokenScopeError(`Unknown token scope: ${name}`);
  }
  return SCOPE_PERMISSIONS[name];
}

export function assertNarrowScope(scope: TokenScope): void {
  if (!Number.isInteger(scope.installationId) || scope.installationId <= 0) {
    throw new TokenScopeError('A token request needs a real installation.');
  }

  if (!Number.isInteger(scope.repositoryId) || scope.repositoryId <= 0) {
    throw new TokenScopeError('A token must be narrowed to exactly one repository.');
  }

  const name: string = scope.scope;
  if (!isTokenScopeName(name)) {
    throw new TokenScopeError(`Unknown token scope: ${name}`);
  }

  const requested = Object.keys(permissionsFor(scope.scope));
  const forbidden = requested.filter((name) =>
    FORBIDDEN_PERMISSIONS.includes(name as (typeof FORBIDDEN_PERMISSIONS)[number]),
  );

  if (forbidden.length > 0) {
    throw new TokenScopeError(`A token must never request: ${forbidden.join(', ')}`);
  }
}

export function scopeCacheKey(scope: TokenScope): string {
  return [scope.installationId, scope.repositoryId, scope.scope].join(':');
}

export function grantedPermissionsAreWithin(
  granted: Readonly<Record<string, string>>,
  scope: TokenScopeName,
): boolean {
  const allowed = permissionsFor(scope);

  return Object.entries(granted).every(([name, level]) => {
    const permitted = allowed[name];
    if (permitted === undefined) {
      return false;
    }
    return permitted === 'write' || level === 'read';
  });
}
