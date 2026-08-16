import { z } from 'zod';

import { LlmProviderSchema, ModelIdSchema } from './llm.js';

export const SelectableModelSchema = z.strictObject({
  id: ModelIdSchema,
  provider: LlmProviderSchema,
  vision: z.boolean(),
  reasoning: z.boolean(),
});

export const ModelCatalogueResponseSchema = z.strictObject({
  models: z.array(SelectableModelSchema),
});

export type SelectableModel = z.infer<typeof SelectableModelSchema>;
export type ModelCatalogueResponse = z.infer<typeof ModelCatalogueResponseSchema>;
