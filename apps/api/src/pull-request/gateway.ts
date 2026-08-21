import {
  PullRequestResultSchema,
  type CheckResult,
  type PatchValidationReport,
  type PullRequestResult,
} from '@nimbus/contracts';

import type { GitHubTokenProvider, InstallationToken } from '../github/token-provider.js';
import type { Logger } from '../logging/logger.js';
import { buildPullRequestBody } from './body.js';
import {
  PullRequestExistsError,
  type OpenPullRequest,
  type PullRequestClientFactory,
} from './client.js';

export const PULL_REQUEST_SCOPE = 'pullRequest';
export const TITLE_MAX_CHARS = 72;
export const PR_CREATE_ATTEMPTS = 3;
export const PR_CREATE_RETRY_MS = 1_000;

export const PULL_REQUEST_ERROR_CODES = ['PULL_REQUEST_FAILED', 'PULL_REQUEST_LOST'] as const;

export type PullRequestErrorCode = (typeof PULL_REQUEST_ERROR_CODES)[number];

export class PullRequestError extends Error {
  readonly code: PullRequestErrorCode;

  constructor(code: PullRequestErrorCode, message: string, options: { cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'PullRequestError';
    this.code = code;
  }
}

export interface OpenPullRequestRequest {
  installationId: number;
  repositoryId: number;
  owner: string;
  name: string;
  defaultBranch: string;
  branch: string;
  baseCommitSha: string;
  task: string;
  summary: string;
  report: PatchValidationReport;
  checks: readonly CheckResult[];
}

export interface PullRequestGateway {
  readonly name: string;
  open(request: OpenPullRequestRequest): Promise<PullRequestResult>;
}

export interface TrustedPullRequestGatewayOptions {
  tokens: GitHubTokenProvider;
  clients: PullRequestClientFactory;
  logger?: Logger;
  now?: () => Date;
  wait?: (ms: number) => Promise<void>;
}

export function titleFor(task: string): string {
  const single = task.replace(/\s+/g, ' ').trim();
  const trimmed = single.length > TITLE_MAX_CHARS ? single.slice(0, TITLE_MAX_CHARS) : single;

  return trimmed === '' ? 'Nimbus change' : trimmed;
}

export class TrustedPullRequestGateway implements PullRequestGateway {
  readonly name = 'github';

  private readonly options: TrustedPullRequestGatewayOptions;

  private readonly now: () => Date;

  private readonly wait: (ms: number) => Promise<void>;

  constructor(options: TrustedPullRequestGatewayOptions) {
    this.options = options;
    this.now = options.now ?? ((): Date => new Date());
    this.wait = options.wait ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  private describe(pullRequest: OpenPullRequest, branch: string): PullRequestResult {
    return PullRequestResultSchema.parse({
      number: pullRequest.number,
      url: pullRequest.url,
      branch,
      headSha: pullRequest.headSha,
      createdAt: this.now().toISOString(),
    });
  }

  async open(request: OpenPullRequestRequest): Promise<PullRequestResult> {
    const token: InstallationToken = await this.options.tokens.getToken({
      installationId: request.installationId,
      repositoryId: request.repositoryId,
      scope: PULL_REQUEST_SCOPE,
    });

    try {
      const client = this.options.clients.forRepository({
        owner: request.owner,
        name: request.name,
        token: token.token,
      });

      const existing = await client.findByBranch(request.branch);

      if (existing !== null) {
        return this.describe(existing, request.branch);
      }

      const input = {
        branch: request.branch,
        baseBranch: request.defaultBranch,
        title: titleFor(request.task),
        body: buildPullRequestBody({
          task: request.task,
          summary: request.summary,
          branch: request.branch,
          baseCommitSha: request.baseCommitSha,
          report: request.report,
          checks: request.checks,
        }),
      };
      let opened: OpenPullRequest | null = null;

      for (let attempt = 1; attempt <= PR_CREATE_ATTEMPTS; attempt += 1) {
        try {
          opened = await client.create(input);
          break;
        } catch (error) {
          const winner = await client.findByBranch(request.branch).catch(() => null);

          if (winner !== null) {
            return this.describe(winner, request.branch);
          }

          if (error instanceof PullRequestExistsError) {
            throw new PullRequestError(
              'PULL_REQUEST_LOST',
              'A pull request already exists but could not be found.',
              { cause: error },
            );
          }

          if (attempt === PR_CREATE_ATTEMPTS) {
            throw error;
          }

          await this.wait(PR_CREATE_RETRY_MS);
        }
      }

      if (opened === null) {
        throw new PullRequestError('PULL_REQUEST_FAILED', 'The pull request could not be opened.');
      }

      return this.describe(opened, request.branch);
    } catch (error) {
      if (error instanceof PullRequestError) {
        throw error;
      }
      throw new PullRequestError('PULL_REQUEST_FAILED', 'The pull request could not be opened.', {
        cause: error,
      });
    } finally {
      try {
        await this.options.tokens.revoke(token);
      } catch (error) {
        this.options.logger?.warn({ err: error }, 'pull request token could not be revoked');
      }
    }
  }
}
