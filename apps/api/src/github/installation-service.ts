import {
  InstallationSummarySchema,
  type InstallationSummary,
  type RepositorySummary,
} from '@nimbus/contracts';
import type { Redis } from 'ioredis';
import type { Db } from 'mongodb';
import { z } from 'zod';

import { recordAuditEvent } from '../auth/audit.js';
import type { GitHubConfig } from '../config/load.js';
import {
  INSTALLATION_RECORD_ID_PREFIX,
  githubInstallationsCollection,
  toInstallationSummary,
  type GitHubInstallationDocument,
} from '../db/models/github-installation.js';
import { ApiError } from '../http/api-error.js';
import { newPrefixedId } from '../lib/id.js';
import type { Logger } from '../logging/logger.js';
import { NonceStore } from '../redis/nonce.js';
import { toRepositorySummaries, type GitHubRepositoryPayload } from './repositories.js';
import type { GitHubTokenProvider } from './token-provider.js';

export const SETUP_STATE_TTL_SECONDS = 900;
export const SETUP_STATE_PURPOSE = 'github-setup';
export const GITHUB_AUTHORIZE_URL = 'https://github.com/login/oauth/authorize';

const SetupStatePayloadSchema = z.strictObject({
  userId: z.string().min(1),
  createdAt: z.string().min(1),
});

type SetupStatePayload = z.infer<typeof SetupStatePayloadSchema>;

export interface InstallationDetails {
  installationId: number;
  accountId: number;
  accountLogin: string;
  accountType: 'User' | 'Organization';
  suspended: boolean;
}

export interface InstallerIdentity {
  githubUserId: number;
  reachableInstallationIds: number[];
}

export interface GitHubDirectory {
  getInstallation(installationId: number): Promise<InstallationDetails | null>;
  listRepositories(token: string): Promise<GitHubRepositoryPayload[]>;
  identifyInstaller(code: string): Promise<InstallerIdentity | null>;
}

export interface InstallationServiceOptions {
  redis: Redis;
  db: Db;
  tokens: GitHubTokenProvider;
  directory: GitHubDirectory;
  github: GitHubConfig;
  logger: Logger;
  stateTtlSeconds?: number;
}

export interface ConnectResult {
  redirectUrl: string;
  installUrl: string | null;
  state: string;
}

export interface CompleteSetupInput {
  userId: string;
  installationId: number;
  state: string;
  code: string;
  ip: string;
}

export interface RepositoriesResult {
  installation: InstallationSummary;
  repositories: RepositorySummary[];
}

export class InstallationService {
  private readonly db: Db;
  private readonly tokens: GitHubTokenProvider;
  private readonly directory: GitHubDirectory;
  private readonly github: GitHubConfig;
  private readonly logger: Logger;
  private readonly states: NonceStore<SetupStatePayload>;

  constructor(options: InstallationServiceOptions) {
    this.db = options.db;
    this.tokens = options.tokens;
    this.directory = options.directory;
    this.github = options.github;
    this.logger = options.logger;
    this.states = new NonceStore(options.redis, {
      purpose: SETUP_STATE_PURPOSE,
      schema: SetupStatePayloadSchema,
      ttlSeconds: options.stateTtlSeconds ?? SETUP_STATE_TTL_SECONDS,
      logger: options.logger,
    });
  }

  installUrl(state?: string): string | null {
    const slug = this.github.appSlug.trim();

    if (slug === '') {
      return null;
    }

    const url = new URL(`https://github.com/apps/${slug}/installations/new`);

    if (state !== undefined) {
      url.searchParams.set('state', state);
    }
    return url.toString();
  }

  async beginConnect(userId: string): Promise<ConnectResult> {
    const state = await this.states.issue({ userId, createdAt: new Date().toISOString() });

    const url = new URL(GITHUB_AUTHORIZE_URL);
    url.searchParams.set('client_id', this.github.clientId);
    url.searchParams.set('redirect_uri', this.github.setupCallbackUrl);
    url.searchParams.set('state', state);

    return { redirectUrl: url.toString(), installUrl: this.installUrl(state), state };
  }

  async completeSetup(input: CompleteSetupInput): Promise<InstallationSummary> {
    const payload = await this.states.consume(input.state);

    if (payload?.userId !== input.userId) {
      await this.reject(input, 'state_invalid_or_replayed');
      throw new ApiError('OAUTH_STATE_INVALID', 'That setup link is no longer valid.');
    }

    const collection = githubInstallationsCollection(this.db);
    const claimed =
      input.installationId > 0
        ? await collection.findOne({ installationId: input.installationId })
        : null;

    const installer =
      claimed !== null && claimed.userId === input.userId
        ? await this.reverifyInstaller(input, claimed.installedByGitHubUserId)
        : await this.verifyInstaller(input);

    const installationId = this.resolveInstallationId(input, installer);

    if (installationId === null) {
      await this.reject(input, 'installer_has_no_installation');
      throw new ApiError(
        'GITHUB_NOT_CONNECTED',
        'Install the Nimbus app on a repository before connecting it.',
      );
    }

    if (!installer.reachableInstallationIds.includes(installationId)) {
      await this.reject(input, 'installer_does_not_hold_installation');
      this.logger.warn(
        { installationId, githubUserId: installer.githubUserId },
        'Refused an installation the signed in GitHub account cannot reach',
      );
      throw new ApiError(
        'FORBIDDEN',
        'That GitHub installation does not belong to the account you signed in with.',
      );
    }

    const existing = await collection.findOne({ installationId });

    if (existing !== null && existing.userId !== input.userId) {
      await this.reject(input, 'installation_owned_by_another_account');
      this.logger.warn(
        { installationId },
        'Refused an installation already held by another account',
      );
      throw new ApiError(
        'FORBIDDEN',
        'That GitHub installation is already connected to another Nimbus account.',
      );
    }

    const details = await this.directory.getInstallation(installationId);
    if (details === null) {
      await this.reject(input, 'installation_not_found');
      throw new ApiError('GITHUB_NOT_CONNECTED', 'That GitHub installation could not be found.');
    }

    const now = new Date();
    const status = details.suspended ? 'suspended' : 'active';

    if (existing !== null) {
      await collection.updateOne(
        { installationId },
        {
          $set: {
            accountId: details.accountId,
            accountLogin: details.accountLogin,
            accountType: details.accountType,
            installedByGitHubUserId: installer.githubUserId,
            status,
            updatedAt: now,
          },
          $unset: { removedAt: '' },
        },
      );
    } else {
      await collection.insertOne({
        installationRecordId: newPrefixedId(INSTALLATION_RECORD_ID_PREFIX),
        userId: input.userId,
        installationId,
        accountId: details.accountId,
        accountLogin: details.accountLogin,
        accountType: details.accountType,
        installedByGitHubUserId: installer.githubUserId,
        status,
        selectedRepositories: [],
        createdAt: now,
        updatedAt: now,
      } satisfies GitHubInstallationDocument);
    }

    const saved = await collection.findOne({ installationId });
    if (saved === null) {
      throw new ApiError('INTERNAL_ERROR', 'Something went wrong. Please try again.');
    }

    await recordAuditEvent(this.db, this.logger, {
      action: 'github.installation.created',
      outcome: 'success',
      actorType: 'user',
      userId: input.userId,
      installationRecordId: saved.installationRecordId,
      ip: input.ip,
      metadata: {
        reconnected: existing !== null,
        suspended: details.suspended,
        githubUserId: installer.githubUserId,
      },
    });

    return toInstallationSummary(saved);
  }

  private resolveInstallationId(
    input: CompleteSetupInput,
    installer: InstallerIdentity,
  ): number | null {
    if (input.installationId > 0) {
      return input.installationId;
    }
    if (installer.reachableInstallationIds.length === 1) {
      return installer.reachableInstallationIds[0] ?? null;
    }
    return null;
  }

  async activeInstallation(userId: string): Promise<GitHubInstallationDocument | null> {
    return githubInstallationsCollection(this.db).findOne({ userId, status: 'active' });
  }

  async summaryFor(userId: string): Promise<InstallationSummary | null> {
    const document = await this.activeInstallation(userId);

    return document === null ? null : toInstallationSummary(document);
  }

  async listRepositories(userId: string): Promise<RepositoriesResult> {
    const installation = await this.activeInstallation(userId);

    if (installation === null) {
      throw new ApiError(
        'GITHUB_NOT_CONNECTED',
        'Connect a GitHub account before choosing a repository.',
      );
    }

    const token = await this.tokens.getListingToken(installation.installationId);
    const payloads = await this.directory.listRepositories(token.token);
    const repositories = toRepositorySummaries(payloads);

    this.logger.info(
      {
        installationId: installation.installationId,
        seen: payloads.length,
        offered: repositories.length,
      },
      'Listed repositories for an installation',
    );

    return {
      installation: InstallationSummarySchema.parse(toInstallationSummary(installation)),
      repositories,
    };
  }

  private async reverifyInstaller(
    input: CompleteSetupInput,
    alreadyProvenGitHubUserId: number,
  ): Promise<InstallerIdentity> {
    if (input.code === '') {
      return {
        githubUserId: alreadyProvenGitHubUserId,
        reachableInstallationIds: [input.installationId],
      };
    }

    return this.verifyInstaller(input);
  }

  private async verifyInstaller(input: CompleteSetupInput): Promise<InstallerIdentity> {
    if (input.code === '') {
      await this.reject(input, 'no_installer_proof');
      throw new ApiError(
        'FORBIDDEN',
        'Nimbus could not confirm that this GitHub installation is yours.',
      );
    }

    const installer = await this.directory.identifyInstaller(input.code);

    if (installer === null) {
      await this.reject(input, 'installer_proof_rejected');
      throw new ApiError(
        'FORBIDDEN',
        'Nimbus could not confirm that this GitHub installation is yours.',
      );
    }

    return installer;
  }

  private async reject(input: CompleteSetupInput, reason: string): Promise<void> {
    await recordAuditEvent(this.db, this.logger, {
      action: 'github.installation.created',
      outcome: 'denied',
      actorType: 'user',
      userId: input.userId,
      ip: input.ip,
      reason,
    });
  }
}
