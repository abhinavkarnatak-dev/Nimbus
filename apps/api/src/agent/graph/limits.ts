export const GRAPH_LIMITS = {
  finalCheckNames: ['typecheck', 'lint', 'test'] as const,
  historyShown: 12,
  refusalMaxChars: 400,
} as const;

export type GraphLimits = typeof GRAPH_LIMITS;
