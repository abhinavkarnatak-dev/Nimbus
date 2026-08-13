import { z } from 'zod';

import { BranchNameSchema } from './github.js';
import { CommitShaSchema } from './ids.js';

export const PUSH_OUTCOMES = ['created', 'already_pushed'] as const;

export const PushOutcomeSchema = z.enum(PUSH_OUTCOMES);

export const PushResultSchema = z.strictObject({
  branch: BranchNameSchema,
  commitSha: CommitShaSchema,
  outcome: PushOutcomeSchema,
});

export type PushOutcome = z.infer<typeof PushOutcomeSchema>;
export type PushResult = z.infer<typeof PushResultSchema>;
