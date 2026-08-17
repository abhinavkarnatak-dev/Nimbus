import type {
  GitHubDirectory,
  InstallationDetails,
  InstallerIdentity,
} from './installation-service.js';
import type { GitHubRepositoryPayload } from './repositories.js';

export interface FakeRepositoryOptions {
  id: number;
  owner?: string;
  name?: string;
  private?: boolean;
  visibility?: string;
  defaultBranch?: string;
  updatedAt?: string;
}

export function fakeRepository(options: FakeRepositoryOptions): GitHubRepositoryPayload {
  const owner = options.owner ?? 'octocat';
  const name = options.name ?? `repo-${String(options.id)}`;
  const isPrivate = options.private ?? false;

  return {
    id: options.id,
    name,
    private: isPrivate,
    visibility: options.visibility ?? (isPrivate ? 'private' : 'public'),
    html_url: `https://github.com/${owner}/${name}`,
    default_branch: options.defaultBranch ?? 'main',
    updated_at: options.updatedAt ?? '2026-08-11T00:00:00.000Z',
    owner: { login: owner },
  };
}

export class FakeGitHubDirectory implements GitHubDirectory {
  readonly installationLookups: number[] = [];
  readonly listingTokens: string[] = [];
  readonly installerCodes: string[] = [];
  readonly deleted: number[] = [];
  refusesDelete = false;

  private installations = new Map<number, InstallationDetails>();
  private repositoriesByInstallation = new Map<number, GitHubRepositoryPayload[]>();
  private repositoriesByToken = new Map<string, GitHubRepositoryPayload[]>();
  private defaultRepositories: GitHubRepositoryPayload[] = [];
  private installers = new Map<string, InstallerIdentity>();

  knowsInstallation(
    installationId: number,
    overrides: Partial<Omit<InstallationDetails, 'installationId'>> = {},
  ): void {
    this.installations.set(installationId, {
      installationId,
      accountId: overrides.accountId ?? 900_000 + installationId,
      accountLogin: overrides.accountLogin ?? 'octocat',
      accountType: overrides.accountType ?? 'User',
      suspended: overrides.suspended ?? false,
    });
  }

  async deleteInstallation(installationId: number): Promise<boolean> {
    if (this.refusesDelete) {
      return Promise.resolve(false);
    }

    this.deleted.push(installationId);
    this.installations.delete(installationId);
    return Promise.resolve(true);
  }

  hasRepositories(repositories: readonly GitHubRepositoryPayload[]): void {
    this.defaultRepositories = [...repositories];
  }

  hasRepositoriesForToken(token: string, repositories: readonly GitHubRepositoryPayload[]): void {
    this.repositoriesByToken.set(token, [...repositories]);
  }

  hasRepositoriesForInstallation(
    installationId: number,
    repositories: readonly GitHubRepositoryPayload[],
  ): void {
    this.repositoriesByInstallation.set(installationId, [...repositories]);
  }

  knowsInstaller(code: string, identity: InstallerIdentity): void {
    this.installers.set(code, identity);
  }

  async identifyInstaller(code: string): Promise<InstallerIdentity | null> {
    this.installerCodes.push(code);
    await Promise.resolve();

    return this.installers.get(code) ?? null;
  }

  async getInstallation(installationId: number): Promise<InstallationDetails | null> {
    this.installationLookups.push(installationId);
    await Promise.resolve();

    return this.installations.get(installationId) ?? null;
  }

  async listRepositories(token: string): Promise<GitHubRepositoryPayload[]> {
    this.listingTokens.push(token);
    await Promise.resolve();

    return this.repositoriesByToken.get(token) ?? this.defaultRepositories;
  }

  repositoriesFor(installationId: number): GitHubRepositoryPayload[] {
    return this.repositoriesByInstallation.get(installationId) ?? this.defaultRepositories;
  }

  reset(): void {
    this.installations = new Map();
    this.repositoriesByInstallation = new Map();
    this.repositoriesByToken = new Map();
    this.defaultRepositories = [];
    this.installers = new Map();
    this.installationLookups.length = 0;
    this.installerCodes.length = 0;
    this.listingTokens.length = 0;
  }
}
