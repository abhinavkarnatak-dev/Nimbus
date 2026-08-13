import { Octokit } from '@octokit/rest';

import { REQUEST_TIMEOUT_MS } from '../github/token-provider.js';
import {
  PullRequestExistsError,
  type CreatePullRequestInput,
  type OpenPullRequest,
  type PullRequestAccess,
  type PullRequestClient,
  type PullRequestClientFactory,
} from './client.js';

const UNPROCESSABLE = 422;
const QUIET_LOG = {
  debug: (): void => undefined,
  info: (): void => undefined,
  warn: (): void => undefined,
  error: (): void => undefined,
};
const ALREADY_EXISTS = 'a pull request already exists';

function statusOf(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }
  const status = (error as { status?: unknown }).status;
  return typeof status === 'number' ? status : undefined;
}

function saysAlreadyExists(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return error.message.toLowerCase().includes(ALREADY_EXISTS);
}

export class OctokitPullRequestClient implements PullRequestClient {
  private readonly client: Octokit;

  private readonly owner: string;

  private readonly repo: string;

  constructor(access: PullRequestAccess, timeoutMs: number = REQUEST_TIMEOUT_MS) {
    this.owner = access.owner;
    this.repo = access.name;
    this.client = new Octokit({
      auth: access.token,
      request: { timeout: timeoutMs },
      log: QUIET_LOG,
    });
  }

  async findByBranch(branch: string): Promise<OpenPullRequest | null> {
    const response = await this.client.pulls.list({
      owner: this.owner,
      repo: this.repo,
      head: `${this.owner}:${branch}`,
      state: 'open',
      per_page: 1,
    });

    const found = response.data[0];

    if (found === undefined) {
      return null;
    }

    return { number: found.number, url: found.html_url, headSha: found.head.sha };
  }

  async create(input: CreatePullRequestInput): Promise<OpenPullRequest> {
    try {
      const response = await this.client.pulls.create({
        owner: this.owner,
        repo: this.repo,
        title: input.title,
        head: input.branch,
        base: input.baseBranch,
        body: input.body,
        maintainer_can_modify: false,
      });

      return {
        number: response.data.number,
        url: response.data.html_url,
        headSha: response.data.head.sha,
      };
    } catch (error) {
      if (statusOf(error) === UNPROCESSABLE && saysAlreadyExists(error)) {
        throw new PullRequestExistsError();
      }
      throw error;
    }
  }
}

export class OctokitPullRequestClientFactory implements PullRequestClientFactory {
  private readonly timeoutMs: number;

  constructor(timeoutMs: number = REQUEST_TIMEOUT_MS) {
    this.timeoutMs = timeoutMs;
  }

  forRepository(access: PullRequestAccess): PullRequestClient {
    return new OctokitPullRequestClient(access, this.timeoutMs);
  }
}
