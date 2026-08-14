import { z } from 'zod';

import { AttachmentIdSchema } from './ids.js';
import { ModelIdSchema } from './llm.js';

export const MODEL_ROLES = ['primary', 'light', 'reasoning', 'vision'] as const;

export const ModelRoleSchema = z.enum(MODEL_ROLES);

export const MAX_DESCRIBED_IMAGES = 5;

export const CONTEXT_PARTS = ['task', 'images', 'attachments', 'retrieval'] as const;

export const ContextPartSchema = z.enum(CONTEXT_PARTS);

export const ModelPlanSchema = z.strictObject({
  primary: ModelIdSchema,
  light: ModelIdSchema,
  reasoning: ModelIdSchema,
  vision: ModelIdSchema,
  chosenByUser: z.boolean(),
});

export const DescribedImageSchema = z.strictObject({
  attachmentId: AttachmentIdSchema,
  name: z.string().min(1).max(255),
  description: z.string().min(1).max(2_000),
  model: ModelIdSchema,
  reused: z.boolean(),
});

export const ContextSummarySchema = z.strictObject({
  characters: z.int().nonnegative(),
  parts: z.array(ContextPartSchema).max(CONTEXT_PARTS.length),
  dropped: z.array(ContextPartSchema).max(CONTEXT_PARTS.length),
  imagesDescribed: z.int().nonnegative(),
  imagesReused: z.int().nonnegative(),
  truncated: z.boolean(),
});

export type ModelRole = z.infer<typeof ModelRoleSchema>;
export type ContextPart = z.infer<typeof ContextPartSchema>;
export type ModelPlan = z.infer<typeof ModelPlanSchema>;
export type DescribedImage = z.infer<typeof DescribedImageSchema>;
export type ContextSummary = z.infer<typeof ContextSummarySchema>;
