import { z } from 'zod';

import { IsoTimestampSchema } from './ids.js';
import { LLM_PROVIDERS, LlmProviderSchema, type LlmProviderName } from './llm.js';

export const PROVIDER_KEY_MIN_CHARS = 20;
export const PROVIDER_KEY_MAX_CHARS = 200;
export const PROVIDER_KEY_HINT_CHARS = 4;

export interface ProviderKeyShape {
  label: string;
  example: string;
  minChars: number;
  consoleUrl: string;
  where: string;
  models: string;
}

export const PROVIDER_KEY_SHAPES: Readonly<Record<LlmProviderName, ProviderKeyShape>> = {
  gemini: {
    label: 'Google Gemini',
    example: 'AIza... or AQ.Ab8...',
    minChars: 30,
    consoleUrl: 'https://aistudio.google.com/apikey',
    where: 'Google AI Studio',
    models: 'Gemini models, including the ones that can read images',
  },
};

export const ProviderApiKeySchema = z
  .string()
  .min(PROVIDER_KEY_MIN_CHARS)
  .max(PROVIDER_KEY_MAX_CHARS)
  .regex(/^[A-Za-z0-9._~+/=-]+$/, { error: 'Invalid API key' });

export function providerKeyProblem(provider: LlmProviderName, apiKey: string): string | null {
  const shape = PROVIDER_KEY_SHAPES[provider];
  const trimmed = apiKey.trim();

  if (trimmed === '') {
    return `Paste the ${shape.label} key you copied from ${shape.where}.`;
  }

  if (!ProviderApiKeySchema.safeParse(trimmed).success) {
    return `That does not look like a key. Copy the whole thing from ${shape.where}.`;
  }

  if (trimmed.length < shape.minChars) {
    return `That ${shape.label} key looks cut short.`;
  }
  return null;
}

export function providerKeyHint(apiKey: string): string {
  return apiKey.trim().slice(-PROVIDER_KEY_HINT_CHARS);
}

export const ProviderKeySummarySchema = z.strictObject({
  provider: LlmProviderSchema,
  hint: z.string().min(1).max(PROVIDER_KEY_HINT_CHARS),
  addedAt: IsoTimestampSchema,
  lastVerifiedAt: IsoTimestampSchema.nullable(),
});

export const ProviderKeysResponseSchema = z.strictObject({
  keys: z.array(ProviderKeySummarySchema).max(LLM_PROVIDERS.length),
});

export const SaveProviderKeyBodySchema = z.strictObject({
  provider: LlmProviderSchema,
  apiKey: ProviderApiKeySchema,
});

export type ProviderKeySummary = z.infer<typeof ProviderKeySummarySchema>;
export type ProviderKeysResponse = z.infer<typeof ProviderKeysResponseSchema>;
export type SaveProviderKeyBody = z.infer<typeof SaveProviderKeyBodySchema>;
