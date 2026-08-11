import { LIMITS } from '@nimbus/contracts';

export const TOOL_LIMITS = {
  treeMaxEntries: LIMITS.maxFilesListed,
  treeMaxDepth: 12,

  searchMaxMatches: 100,
  searchMaxLineChars: 400,
  searchMaxFilesScanned: 2_000,
  searchQueryMaxChars: 200,

  readMaxBytes: 131_072,
  readMaxLines: 2_000,

  createMaxBytes: 131_072,

  patchMaxFiles: LIMITS.maxChangedFiles,
  patchMaxLines: LIMITS.maxDiffLines,
  patchMaxBytes: 524_288,

  linkHopsMax: 12,
  pathSegmentsMax: 40,
} as const;

export type ToolLimits = typeof TOOL_LIMITS;
