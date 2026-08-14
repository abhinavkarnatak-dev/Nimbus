import {
  LIMITS,
  MAX_RETRIEVAL_FILES,
  MAX_RETRIEVAL_FLAGS,
  MAX_RETRIEVAL_TERMS,
} from '@nimbus/contracts';

export const RETRIEVAL_LIMITS = {
  taskMaxChars: LIMITS.taskMaxChars,
  termsMax: MAX_RETRIEVAL_TERMS,
  termMinChars: 2,
  termMaxChars: 64,
  phraseMaxChars: 60,

  treeMaxDepth: 6,
  treeMaxLines: 120,
  treeExpandMaxFiles: 8,
  treeExtensionsShown: 3,

  scanMaxFiles: 1_500,
  scanMaxFileBytes: 262_144,
  scanMaxTotalBytes: 33_554_432,
  scanMaxLinesPerFile: 20_000,
  scanMaxHitsPerFile: 200,

  filesReturnedMax: MAX_RETRIEVAL_FILES,
  filesReturnedDefault: 10,

  excerptContextLines: 3,
  excerptMaxWindows: 4,
  excerptMaxLines: 60,
  excerptMaxLineChars: 300,

  flagsMax: MAX_RETRIEVAL_FLAGS,
  bundleMaxChars: 60_000,

  nonceBytes: 12,
  nonceAttempts: 8,
} as const;

export type RetrievalLimits = typeof RETRIEVAL_LIMITS;
