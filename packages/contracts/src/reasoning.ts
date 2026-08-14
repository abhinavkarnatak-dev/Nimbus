import { z } from 'zod';

import { LIMITS } from './limits.js';
import { ToolNameSchema } from './tools.js';

export const MAX_INTENT_CHARS = 300;
export const MAX_ARGUMENTS_CHARS = 16_384;

export const ScopeVerdictSchema = z.strictObject({
  clear: z.boolean(),
  question: z.string().max(LIMITS.messageMaxChars),
});

export const ToolArgumentsSchema = z
  .record(z.string(), z.unknown())
  .refine((value) => JSON.stringify(value).length <= MAX_ARGUMENTS_CHARS, {
    message: `those arguments are longer than ${String(MAX_ARGUMENTS_CHARS)} characters`,
  });

export const NextActionSchema = z.strictObject({
  intent: z.string().min(1).max(MAX_INTENT_CHARS),
  tool: ToolNameSchema,
  toolArguments: ToolArgumentsSchema,
});

export const SCOPE_OUTCOMES = ['clear', 'needs_clarification', 'already_asked'] as const;

export const ScopeOutcomeSchema = z.enum(SCOPE_OUTCOMES);

export const ScopeResultSchema = z.strictObject({
  outcome: ScopeOutcomeSchema,
  question: z.string().max(LIMITS.messageMaxChars).nullable(),
  reason: z.string().min(1).max(LIMITS.reasonMaxChars),
  askedModel: z.boolean(),
});

export type ScopeVerdict = z.infer<typeof ScopeVerdictSchema>;
export type NextAction = z.infer<typeof NextActionSchema>;
export type ScopeOutcome = z.infer<typeof ScopeOutcomeSchema>;
export type ScopeResult = z.infer<typeof ScopeResultSchema>;
