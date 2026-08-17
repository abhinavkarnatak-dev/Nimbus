import { z } from 'zod';

export const LLM_PROVIDERS = ['gemini'] as const;

export const LlmProviderSchema = z.enum(LLM_PROVIDERS);

export const MODEL_ID_MAX_CHARS = 100;

export const ModelIdSchema = z
  .string()
  .min(1)
  .max(MODEL_ID_MAX_CHARS)
  .regex(/^[a-zA-Z0-9._/-]+$/);

export const TokenUsageSchema = z.strictObject({
  promptTokens: z.int().nonnegative(),
  completionTokens: z.int().nonnegative(),
  reasoningTokens: z.int().nonnegative(),
  totalTokens: z.int().nonnegative(),
});

export const CallCostSchema = z.strictObject({
  microCents: z.int().nonnegative(),
  estimated: z.boolean(),
});

export const CallReportSchema = z.strictObject({
  provider: LlmProviderSchema,
  model: ModelIdSchema,
  usage: TokenUsageSchema,
  cost: CallCostSchema,
  attempts: z.int().positive(),
  durationMs: z.int().nonnegative(),
});

export const BudgetStateSchema = z.strictObject({
  tokensUsed: z.int().nonnegative(),
  tokenLimit: z.int().positive(),
  microCentsUsed: z.int().nonnegative(),
  microCentLimit: z.int().positive(),
  calls: z.int().nonnegative(),
  callLimit: z.int().positive(),
  exhausted: z.boolean(),
});

export type LlmProviderName = z.infer<typeof LlmProviderSchema>;
export type TokenUsage = z.infer<typeof TokenUsageSchema>;
export type CallCost = z.infer<typeof CallCostSchema>;
export type CallReport = z.infer<typeof CallReportSchema>;
export type BudgetState = z.infer<typeof BudgetStateSchema>;
