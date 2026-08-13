import {
  PullRequestExistsError,
  type CreatePullRequestInput,
  type OpenPullRequest,
  type PullRequestAccess,
  type PullRequestClient,
  type PullRequestClientFactory,
} from './client.js';

export const FIRST_PULL_REQUEST_NUMBER = 41;

export interface FakePullRequestState {
  byBranch: Map<string, OpenPullRequest>;
  nextNumber: number;
  hiddenBranches: Set<string>;
}

export function newPullRequestState(): FakePullRequestState {
  return {
    byBranch: new Map(),
    nextNumber: FIRST_PULL_REQUEST_NUMBER,
    hiddenBranches: new Set(),
  };
}

export interface FakePullRequestOptions {
  failFind?: boolean;
  failCreate?: boolean;
  raceOnCreate?: boolean;
}

export class FakePullRequestClient implements PullRequestClient {
  readonly access: PullRequestAccess;
  readonly created: CreatePullRequestInput[] = [];
  readonly finds: string[] = [];

  private readonly state: FakePullRequestState;
  private readonly options: FakePullRequestOptions;

  constructor(
    state: FakePullRequestState,
    access: PullRequestAccess,
    options: FakePullRequestOptions = {},
  ) {
    this.state = state;
    this.access = access;
    this.options = options;
  }

  async findByBranch(branch: string): Promise<OpenPullRequest | null> {
    this.finds.push(branch);

    if (this.options.failFind === true) {
      throw new Error('the network broke while looking');
    }

    if (this.state.hiddenBranches.has(branch)) {
      this.state.hiddenBranches.delete(branch);
      return Promise.resolve(null);
    }

    return Promise.resolve(this.state.byBranch.get(branch) ?? null);
  }

  async create(input: CreatePullRequestInput): Promise<OpenPullRequest> {
    this.created.push(input);

    if (this.options.failCreate === true) {
      throw new Error('the network broke while creating');
    }

    if (this.options.raceOnCreate === true || this.state.byBranch.has(input.branch)) {
      throw new PullRequestExistsError();
    }

    const opened: OpenPullRequest = {
      number: this.state.nextNumber,
      url: `https://github.com/${this.access.owner}/${this.access.name}/pull/${String(this.state.nextNumber)}`,
      headSha: 'b'.repeat(40),
    };

    this.state.nextNumber += 1;
    this.state.byBranch.set(input.branch, opened);

    return Promise.resolve(opened);
  }
}

export class FakePullRequestClientFactory implements PullRequestClientFactory {
  readonly clients: FakePullRequestClient[] = [];

  private readonly state: FakePullRequestState;
  private readonly options: FakePullRequestOptions;

  constructor(state: FakePullRequestState, options: FakePullRequestOptions = {}) {
    this.state = state;
    this.options = options;
  }

  forRepository(access: PullRequestAccess): FakePullRequestClient {
    const client = new FakePullRequestClient(this.state, access, this.options);
    this.clients.push(client);
    return client;
  }
}
