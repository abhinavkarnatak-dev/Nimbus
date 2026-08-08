import { z } from 'zod';

import { CommitShaSchema, IsoTimestampSchema } from './ids.js';
import { BranchNameSchema } from './github.js';

export const PullRequestResultSchema = z.strictObject({
  number: z.int().positive(),
  url: z.url().max(2048),
  branch: BranchNameSchema,
  headSha: CommitShaSchema,
  createdAt: IsoTimestampSchema,
});

export type PullRequestResult = z.infer<typeof PullRequestResultSchema>;
