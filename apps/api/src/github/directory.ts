import { Octokit } from '@octokit/rest';

import type { GitHubConfig } from '../config/load.js';
import type { Logger } from '../logging/logger.js';
import { redactValue } from '../logging/redact.js';
import { createAppJwt } from './app-jwt.js';
import {
  MAX_REPOSITORY_PAGES,
  REPOSITORY_PAGE_SIZE,
  type GitHubRepositoryPayload,
} from './repositories.js';
import { REQUEST_TIMEOUT_MS } from './token-provider.js';
import type {
  GitHubDirectory,
  InstallationDetails,
  InstallerIdentity,
} from './installation-service.js';

export const GITHUB_USER_TOKEN_URL = 'https://github.com/login/oauth/access_token';

function accountTypeOf(value: unknown): InstallationDetails['accountType'] {
  return value === 'Organization' ? 'Organization' : 'User';
}

function statusOf(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null || !('status' in error)) {
    return undefined;
  }
  const status = (error as { status?: unknown }).status;
  return typeof status === 'number' ? status : undefined;
}

export interface GitHubDirectoryOptions {
  github: GitHubConfig;
  logger: Logger;
  timeoutMs?: number;
}

export class OctokitGitHubDirectory implements GitHubDirectory {
  private readonly github: GitHubConfig;
  private readonly logger: Logger;
  private readonly timeoutMs: number;

  constructor(options: GitHubDirectoryOptions) {
    this.github = options.github;
    this.logger = options.logger;
    this.timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  }

  async getInstallation(installationId: number): Promise<InstallationDetails | null> {
    try {
      const response = await new Octokit({
        auth: createAppJwt(this.github.appId, this.github.privateKeyPem),
        request: { timeout: this.timeoutMs },
      }).rest.apps.getInstallation({ installation_id: installationId });

      const account = response.data.account as {
        id?: unknown;
        login?: unknown;
        type?: unknown;
      } | null;

      if (account === null || typeof account.id !== 'number' || typeof account.login !== 'string') {
        return null;
      }

      return {
        installationId,
        accountId: account.id,
        accountLogin: account.login,
        accountType: accountTypeOf(account.type),
        suspended: typeof response.data.suspended_at === 'string',
      };
    } catch (error) {
      if (statusOf(error) === 404) {
        return null;
      }
      this.logger.error(
        { installationId, status: statusOf(error), err: redactValue(error) },
        'Could not read a GitHub installation',
      );
      throw error;
    }
  }

  async deleteInstallation(installationId: number): Promise<boolean> {
    try {
      await new Octokit({
        auth: createAppJwt(this.github.appId, this.github.privateKeyPem),
        request: { timeout: this.timeoutMs },
      }).rest.apps.deleteInstallation({ installation_id: installationId });

      return true;
    } catch (error) {
      if (statusOf(error) === 404) {
        return true;
      }

      this.logger.error(
        { installationId, status: statusOf(error), err: redactValue(error) },
        'Could not uninstall a GitHub installation',
      );
      return false;
    }
  }

  async identifyInstaller(code: string): Promise<InstallerIdentity | null> {
    let userToken: string;

    try {
      const response = await fetch(GITHUB_USER_TOKEN_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body: new URLSearchParams({
          client_id: this.github.clientId,
          client_secret: this.github.clientSecret,
          code,
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });

      const payload = (await response.json()) as { access_token?: unknown };

      if (!response.ok || typeof payload.access_token !== 'string') {
        this.logger.warn(
          { status: response.status },
          'GitHub would not confirm who performed the installation',
        );
        return null;
      }
      userToken = payload.access_token;
    } catch (error) {
      this.logger.error(
        { err: redactValue(error) },
        'Could not reach GitHub to confirm who performed the installation',
      );
      return null;
    }

    const client = new Octokit({ auth: userToken, request: { timeout: this.timeoutMs } });

    try {
      const [user, installations] = await Promise.all([
        client.rest.users.getAuthenticated(),
        client.rest.apps.listInstallationsForAuthenticatedUser({ per_page: 100 }),
      ]);

      return {
        githubUserId: user.data.id,
        reachableInstallationIds: installations.data.installations.map(
          (installation) => installation.id,
        ),
      };
    } catch (error) {
      this.logger.error(
        { err: redactValue(error) },
        'Could not read the installing GitHub account',
      );
      return null;
    }
  }

  async listRepositories(token: string): Promise<GitHubRepositoryPayload[]> {
    const client = new Octokit({ auth: token, request: { timeout: this.timeoutMs } });
    const collected: GitHubRepositoryPayload[] = [];

    for (let page = 1; page <= MAX_REPOSITORY_PAGES; page += 1) {
      const response = await client.rest.apps.listReposAccessibleToInstallation({
        per_page: REPOSITORY_PAGE_SIZE,
        page,
      });

      const repositories = response.data.repositories as GitHubRepositoryPayload[];
      collected.push(...repositories);

      if (repositories.length < REPOSITORY_PAGE_SIZE) {
        break;
      }
    }

    return collected;
  }
}
