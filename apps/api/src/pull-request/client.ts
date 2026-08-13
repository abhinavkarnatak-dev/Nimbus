export interface OpenPullRequest {
  number: number;
  url: string;
  headSha: string;
}

export interface CreatePullRequestInput {
  branch: string;
  baseBranch: string;
  title: string;
  body: string;
}

export class PullRequestExistsError extends Error {
  constructor(message = 'a pull request already exists for that branch') {
    super(message);
    this.name = 'PullRequestExistsError';
  }
}

export interface PullRequestClient {
  findByBranch(branch: string): Promise<OpenPullRequest | null>;
  create(input: CreatePullRequestInput): Promise<OpenPullRequest>;
}

export interface PullRequestAccess {
  owner: string;
  name: string;
  token: string;
}

export interface PullRequestClientFactory {
  forRepository(access: PullRequestAccess): PullRequestClient;
}
