import { z } from 'zod';

export const CodexAuthStatusSchema = z.strictObject({ connected: z.boolean() });
export const CodexDeviceChallengeSchema = z.strictObject({
  url: z.url(),
  code: z.string().min(1).max(100),
  expiresAt: z.iso.datetime().nullable(),
});

export type CodexAuthStatus = z.infer<typeof CodexAuthStatusSchema>;
export type CodexDeviceChallenge = z.infer<typeof CodexDeviceChallengeSchema>;
