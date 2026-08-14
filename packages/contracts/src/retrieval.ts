import { z } from 'zod';

import { LIMITS } from './limits.js';

export const RETRIEVAL_FLAG_CODES = [
  'IGNORE_PREVIOUS',
  'ROLE_SWITCH',
  'SYSTEM_PROMPT_CLAIM',
  'EXFILTRATION',
  'MARKER_SPOOF',
] as const;

export const RetrievalFlagCodeSchema = z.enum(RETRIEVAL_FLAG_CODES);

export const MAX_RETRIEVAL_FLAGS = 100;
export const MAX_RETRIEVAL_FILES = 40;
export const MAX_RETRIEVAL_TERMS = 24;

const retrievedPath = z.string().min(1).max(LIMITS.pathMaxChars);

export const RetrievalFlagSchema = z.strictObject({
  code: RetrievalFlagCodeSchema,
  path: retrievedPath,
  line: z.int().positive(),
});

export const RetrievalStatsSchema = z.strictObject({
  filesSeen: z.int().nonnegative(),
  filesScanned: z.int().nonnegative(),
  skippedByPolicy: z.int().nonnegative(),
  skippedNotText: z.int().nonnegative(),
  skippedTooLarge: z.int().nonnegative(),
  skippedUnreadable: z.int().nonnegative(),
  bytesScanned: z.int().nonnegative(),
  truncated: z.boolean(),
});

export const RetrievedFileSummarySchema = z.strictObject({
  path: retrievedPath,
  score: z.number().nonnegative(),
  matchedTerms: z.array(z.string().min(1).max(64)).max(MAX_RETRIEVAL_TERMS),
  hits: z.int().nonnegative(),
  lines: z.int().nonnegative(),
  protectedPath: z.boolean(),
});

export const RetrievalSummarySchema = z.strictObject({
  terms: z.array(z.string().min(1).max(64)).max(MAX_RETRIEVAL_TERMS),
  files: z.array(RetrievedFileSummarySchema).max(MAX_RETRIEVAL_FILES),
  flags: z.array(RetrievalFlagSchema).max(MAX_RETRIEVAL_FLAGS),
  stats: RetrievalStatsSchema,
  characters: z.int().nonnegative(),
});

export type RetrievalFlagCode = z.infer<typeof RetrievalFlagCodeSchema>;
export type RetrievalFlag = z.infer<typeof RetrievalFlagSchema>;
export type RetrievalStats = z.infer<typeof RetrievalStatsSchema>;
export type RetrievedFileSummary = z.infer<typeof RetrievedFileSummarySchema>;
export type RetrievalSummary = z.infer<typeof RetrievalSummarySchema>;
