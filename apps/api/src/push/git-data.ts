export interface RepositoryFacts {
  defaultBranch: string;
}

export interface RefTarget {
  commitSha: string;
}

export interface CommitFacts {
  treeSha: string;
}

export interface TreeEntryInput {
  path: string;
  mode: string;
  blobSha: string | null;
}

export const BLOB_MODE = '100644';

export interface GitDataClient {
  getRepository(): Promise<RepositoryFacts>;
  getRef(branch: string): Promise<RefTarget | null>;
  getCommit(commitSha: string): Promise<CommitFacts>;
  getFile(path: string, commitSha: string): Promise<string | null>;
  createBlob(contents: string): Promise<string>;
  createTree(baseTreeSha: string, entries: readonly TreeEntryInput[]): Promise<string>;
  createCommit(input: { message: string; treeSha: string; parentSha: string }): Promise<string>;
  createRef(branch: string, commitSha: string): Promise<void>;
}

export interface RepositoryAccess {
  owner: string;
  name: string;
  token: string;
}

export interface GitDataFactory {
  forRepository(access: RepositoryAccess): GitDataClient;
}
