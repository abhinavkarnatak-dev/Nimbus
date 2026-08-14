export const CLONE_LIMITS = {
  maxFiles: 4_000,
  maxTotalBytes: 40 * 1024 * 1024,
  maxFileBytes: 512 * 1024,
  requestTimeoutMs: 30_000,
  blobConcurrency: 8,
} as const;

export const TREE_MODES = {
  file: '100644',
  executable: '100755',
  symlink: '120000',
  submodule: '160000',
  directory: '040000',
} as const;

export type CloneLimits = typeof CLONE_LIMITS;
