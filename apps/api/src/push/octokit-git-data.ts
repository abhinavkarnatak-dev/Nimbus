import { Octokit } from '@octokit/rest';

import { REQUEST_TIMEOUT_MS } from '../github/token-provider.js';
import type {
  CommitFacts,
  GitDataClient,
  GitDataFactory,
  RefTarget,
  RepositoryAccess,
  RepositoryFacts,
  TreeEntryInput,
} from './git-data.js';

const NOT_FOUND = 404;
const QUIET_LOG = {
  debug: (): void => undefined,
  info: (): void => undefined,
  warn: (): void => undefined,
  error: (): void => undefined,
};

function statusOf(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }
  const status = (error as { status?: unknown }).status;
  return typeof status === 'number' ? status : undefined;
}

export class OctokitGitDataClient implements GitDataClient {
  private readonly client: Octokit;

  private readonly owner: string;

  private readonly repo: string;

  constructor(access: RepositoryAccess, timeoutMs: number = REQUEST_TIMEOUT_MS) {
    this.owner = access.owner;
    this.repo = access.name;
    this.client = new Octokit({
      auth: access.token,
      request: { timeout: timeoutMs },
      log: QUIET_LOG,
    });
  }

  async getRepository(): Promise<RepositoryFacts> {
    const response = await this.client.repos.get({ owner: this.owner, repo: this.repo });
    return { defaultBranch: response.data.default_branch };
  }

  async getRef(branch: string): Promise<RefTarget | null> {
    try {
      const response = await this.client.git.getRef({
        owner: this.owner,
        repo: this.repo,
        ref: `heads/${branch}`,
      });
      return { commitSha: response.data.object.sha };
    } catch (error) {
      if (statusOf(error) === NOT_FOUND) {
        return null;
      }
      throw error;
    }
  }

  async getCommit(commitSha: string): Promise<CommitFacts> {
    const response = await this.client.git.getCommit({
      owner: this.owner,
      repo: this.repo,
      commit_sha: commitSha,
    });
    return { treeSha: response.data.tree.sha };
  }

  async getFile(path: string, commitSha: string): Promise<string | null> {
    try {
      const response = await this.client.repos.getContent({
        owner: this.owner,
        repo: this.repo,
        path,
        ref: commitSha,
      });

      const data = response.data;

      if (Array.isArray(data) || data.type !== 'file' || typeof data.content !== 'string') {
        return null;
      }

      return Buffer.from(data.content, 'base64').toString('utf8');
    } catch (error) {
      if (statusOf(error) === NOT_FOUND) {
        return null;
      }
      throw error;
    }
  }

  async createBlob(contents: string): Promise<string> {
    const response = await this.client.git.createBlob({
      owner: this.owner,
      repo: this.repo,
      content: Buffer.from(contents, 'utf8').toString('base64'),
      encoding: 'base64',
    });
    return response.data.sha;
  }

  async createTree(baseTreeSha: string, entries: readonly TreeEntryInput[]): Promise<string> {
    const response = await this.client.git.createTree({
      owner: this.owner,
      repo: this.repo,
      base_tree: baseTreeSha,
      tree: entries.map((entry) => ({
        path: entry.path,
        mode: entry.mode as '100644',
        type: 'blob' as const,
        sha: entry.blobSha,
      })),
    });
    return response.data.sha;
  }

  async createCommit(input: {
    message: string;
    treeSha: string;
    parentSha: string;
  }): Promise<string> {
    const response = await this.client.git.createCommit({
      owner: this.owner,
      repo: this.repo,
      message: input.message,
      tree: input.treeSha,
      parents: [input.parentSha],
    });
    return response.data.sha;
  }

  async createRef(branch: string, commitSha: string): Promise<void> {
    await this.client.git.createRef({
      owner: this.owner,
      repo: this.repo,
      ref: `refs/heads/${branch}`,
      sha: commitSha,
    });
  }
}

export class OctokitGitDataFactory implements GitDataFactory {
  private readonly timeoutMs: number;

  constructor(timeoutMs: number = REQUEST_TIMEOUT_MS) {
    this.timeoutMs = timeoutMs;
  }

  forRepository(access: RepositoryAccess): GitDataClient {
    return new OctokitGitDataClient(access, this.timeoutMs);
  }
}
