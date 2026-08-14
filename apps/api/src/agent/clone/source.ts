import type { Sandbox } from '../../sandbox/index.js';

export const CLONE_SKIP_REASONS = [
  'ignored_path',
  'symlink',
  'submodule',
  'too_large',
  'not_text',
  'budget_spent',
] as const;

export type CloneSkipReason = (typeof CLONE_SKIP_REASONS)[number];

export interface RepositoryReference {
  owner: string;
  name: string;
  commitSha: string;
  token: string;
}

export interface CloneStats {
  filesWritten: number;
  bytesWritten: number;
  skipped: Record<CloneSkipReason, number>;
}

export interface CloneResult {
  commitSha: string;
  paths: string[];
  stats: CloneStats;
  partial: boolean;
}

export interface RepositorySource {
  readonly name: string;
  readonly real: boolean;
  cloneInto(sandbox: Sandbox, reference: RepositoryReference): Promise<CloneResult>;
}

export function emptyStats(): CloneStats {
  return {
    filesWritten: 0,
    bytesWritten: 0,
    skipped: {
      ignored_path: 0,
      symlink: 0,
      submodule: 0,
      too_large: 0,
      not_text: 0,
      budget_spent: 0,
    },
  };
}
