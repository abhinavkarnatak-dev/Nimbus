import { z } from 'zod';

import {
  GitHubInstallationIdSchema,
  GitHubRepositoryIdSchema,
  InstallationRecordIdSchema,
  IsoTimestampSchema,
} from './ids.js';
import { LIMITS } from './limits.js';

export const InstallationStatusSchema = z.enum(['active', 'suspended', 'removed']);

export const GitHubAccountTypeSchema = z.enum(['User', 'Organization']);

export const RepositoryOwnerSchema = z
  .string()
  .min(1)
  .max(LIMITS.ownerNameMaxChars)
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/, { error: 'Invalid repository owner' });

export const RepositoryNameSchema = z
  .string()
  .min(1)
  .max(LIMITS.repositoryNameMaxChars)
  .regex(/^[A-Za-z0-9._-]+$/, { error: 'Invalid repository name' });

export const BranchNameSchema = z
  .string()
  .min(1)
  .max(LIMITS.branchNameMaxChars)
  .regex(/^(?!\/)(?!.*\/\/)(?!.*\.\.)(?!.*[~^:?*[\\])[^\s]+(?<!\/)(?<!\.lock)$/, {
    error: 'Invalid branch name',
  });

export const RepositorySummarySchema = z.strictObject({
  repositoryId: GitHubRepositoryIdSchema,
  owner: RepositoryOwnerSchema,
  name: RepositoryNameSchema,
  defaultBranch: BranchNameSchema,
  visibility: z.literal('public'),
  htmlUrl: z.url().max(2048),
  updatedAt: IsoTimestampSchema,
});

export const InstallationSummarySchema = z.strictObject({
  installationRecordId: InstallationRecordIdSchema,
  installationId: GitHubInstallationIdSchema,
  accountLogin: RepositoryOwnerSchema,
  accountType: GitHubAccountTypeSchema,
  status: InstallationStatusSchema,
  connectedAt: IsoTimestampSchema,
});

export const RepositoriesResponseSchema = z.strictObject({
  installation: InstallationSummarySchema.nullable(),
  repositories: z.array(RepositorySummarySchema).max(500),
});

export const GitHubConnectResponseSchema = z.strictObject({
  redirectUrl: z.url().max(2048),
  installUrl: z.url().max(2048).nullable(),
});

export const GitHubDisconnectResponseSchema = z.strictObject({
  uninstalledOnGitHub: z.boolean(),
});

export type InstallationStatus = z.infer<typeof InstallationStatusSchema>;
export type GitHubAccountType = z.infer<typeof GitHubAccountTypeSchema>;
export type RepositorySummary = z.infer<typeof RepositorySummarySchema>;
export type InstallationSummary = z.infer<typeof InstallationSummarySchema>;
export type RepositoriesResponse = z.infer<typeof RepositoriesResponseSchema>;
export type GitHubConnectResponse = z.infer<typeof GitHubConnectResponseSchema>;
export type GitHubDisconnectResponse = z.infer<typeof GitHubDisconnectResponseSchema>;
