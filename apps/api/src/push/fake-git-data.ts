import { createHash } from 'node:crypto';

import type {
  CommitFacts,
  GitDataClient,
  GitDataFactory,
  RefTarget,
  RepositoryAccess,
  RepositoryFacts,
  TreeEntryInput,
} from './git-data.js';

export const FAKE_STEPS = [
  'getRepository',
  'getRef',
  'getCommit',
  'getFile',
  'createBlob',
  'createTree',
  'createCommit',
  'createRef',
] as const;

export type FakeStep = (typeof FAKE_STEPS)[number];

function sha1(value: string): string {
  return createHash('sha1').update(value, 'utf8').digest('hex');
}

export interface FakeRepositoryState {
  defaultBranch: string;
  files: Map<string, string>;
  refs: Map<string, string>;
  commits: Map<string, string>;
  trees: Map<string, string[]>;
}

export function newRepository(
  files: Readonly<Record<string, string>> = {},
  defaultBranch = 'main',
): FakeRepositoryState {
  return {
    defaultBranch,
    files: new Map(Object.entries(files)),
    refs: new Map(),
    commits: new Map(),
    trees: new Map(),
  };
}

export interface FakeGitDataOptions {
  failAt?: FakeStep;
  failWith?: Error;
}

export class FakeGitDataClient implements GitDataClient {
  readonly calls: FakeStep[] = [];
  readonly blobs = new Map<string, string>();
  readonly access: RepositoryAccess;

  private readonly state: FakeRepositoryState;
  private readonly options: FakeGitDataOptions;

  constructor(
    state: FakeRepositoryState,
    access: RepositoryAccess,
    options: FakeGitDataOptions = {},
  ) {
    this.state = state;
    this.access = access;
    this.options = options;
  }

  private record(step: FakeStep): void {
    this.calls.push(step);

    if (this.options.failAt === step) {
      throw this.options.failWith ?? new Error(`the network broke at ${step}`);
    }
  }

  async getRepository(): Promise<RepositoryFacts> {
    this.record('getRepository');
    return Promise.resolve({ defaultBranch: this.state.defaultBranch });
  }

  async getRef(branch: string): Promise<RefTarget | null> {
    this.record('getRef');
    const commitSha = this.state.refs.get(branch);
    return Promise.resolve(commitSha === undefined ? null : { commitSha });
  }

  async getCommit(commitSha: string): Promise<CommitFacts> {
    this.record('getCommit');
    const treeSha = this.state.commits.get(commitSha) ?? sha1(`base-tree:${commitSha}`);
    return Promise.resolve({ treeSha });
  }

  async getFile(path: string, commitSha: string): Promise<string | null> {
    this.record('getFile');
    void commitSha;
    return Promise.resolve(this.state.files.get(path) ?? null);
  }

  async createBlob(contents: string): Promise<string> {
    this.record('createBlob');
    const sha = sha1(`blob:${contents}`);
    this.blobs.set(sha, contents);
    return Promise.resolve(sha);
  }

  async createTree(baseTreeSha: string, entries: readonly TreeEntryInput[]): Promise<string> {
    this.record('createTree');

    const described = entries
      .map((entry) => `${entry.path}:${entry.mode}:${entry.blobSha ?? 'removed'}`)
      .sort((left, right) => left.localeCompare(right));

    const sha = sha1(`tree:${baseTreeSha}:${described.join('|')}`);
    this.state.trees.set(sha, described);
    return Promise.resolve(sha);
  }

  async createCommit(input: {
    message: string;
    treeSha: string;
    parentSha: string;
  }): Promise<string> {
    this.record('createCommit');
    const sha = sha1(
      `commit:${input.treeSha}:${input.parentSha}:${String(this.state.commits.size)}`,
    );
    this.state.commits.set(sha, input.treeSha);
    return Promise.resolve(sha);
  }

  async createRef(branch: string, commitSha: string): Promise<void> {
    this.record('createRef');

    if (this.state.refs.has(branch)) {
      throw new Error('that branch already exists');
    }

    this.state.refs.set(branch, commitSha);
    return Promise.resolve();
  }
}

export class FakeGitDataFactory implements GitDataFactory {
  readonly clients: FakeGitDataClient[] = [];

  private readonly state: FakeRepositoryState;
  private readonly options: FakeGitDataOptions;

  constructor(state: FakeRepositoryState, options: FakeGitDataOptions = {}) {
    this.state = state;
    this.options = options;
  }

  forRepository(access: RepositoryAccess): FakeGitDataClient {
    const client = new FakeGitDataClient(this.state, access, this.options);
    this.clients.push(client);
    return client;
  }
}
