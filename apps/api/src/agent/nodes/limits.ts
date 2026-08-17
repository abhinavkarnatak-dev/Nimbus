export const NODE_LIMITS = {
  scopeMaxOutputTokens: 300,
  reasonMaxOutputTokens: 1_500,

  retrievalFilesMax: 8,
  contextMaxChars: 90_000,

  intentMaxChars: 300,
  conversationShown: 10,
} as const;

export type NodeLimits = typeof NODE_LIMITS;
