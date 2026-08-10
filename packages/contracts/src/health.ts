import { z } from 'zod';

export const HealthResponseSchema = z.strictObject({
  status: z.literal('ok'),
  uptimeSeconds: z.int().nonnegative(),
});

export const ReadinessStatusSchema = z.enum(['ready', 'not_ready']);

export const ReadinessResponseSchema = z.strictObject({
  status: ReadinessStatusSchema,
});

export type HealthResponse = z.infer<typeof HealthResponseSchema>;
export type ReadinessStatus = z.infer<typeof ReadinessStatusSchema>;
export type ReadinessResponse = z.infer<typeof ReadinessResponseSchema>;
