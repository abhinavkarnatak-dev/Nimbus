import { z } from 'zod';

import { ApprovalEffectSchema, PolicyDecisionSchema } from './approvals.js';
import { CommitShaSchema } from './ids.js';
import { LIMITS } from './limits.js';
import { FileChangeKindSchema } from './tools.js';

export const VALIDATION_FINDING_CODES = [
  'BASE_COMMIT_MISMATCH',
  'PATCH_UNREADABLE',
  'PATCH_TOO_LARGE',
  'PATH_ABSOLUTE',
  'PATH_TRAVERSAL',
  'PATH_GIT_DIRECTORY',
  'NESTED_REPOSITORY',
  'SYMLINK_CHANGE',
  'SUBMODULE_CHANGE',
  'MODE_CHANGE',
  'BINARY_FILE',
  'SECRET_DETECTED',
  'HIGH_ENTROPY_STRING',
  'PROTECTED_PATH',
  'FILE_DELETED',
  'FILE_RENAMED',
  'TOO_MANY_FILES',
  'TOO_MANY_LINES',
] as const;

export const ValidationFindingCodeSchema = z.enum(VALIDATION_FINDING_CODES);

export const MAX_VALIDATION_FINDINGS = 200;
export const MAX_VALIDATED_FILES = 500;
export const MAX_VALIDATION_APPROVALS = 20;

const reportedPath = z.string().min(1).max(LIMITS.pathMaxChars);

export const ValidationFindingSchema = z.strictObject({
  code: ValidationFindingCodeSchema,
  decision: PolicyDecisionSchema,
  paths: z.array(reportedPath).max(LIMITS.approvalPathsMax),
  detail: z.string().min(1).max(LIMITS.reasonMaxChars),
});

export const ValidatedFileSchema = z.strictObject({
  path: reportedPath,
  previousPath: reportedPath.optional(),
  changeKind: FileChangeKindSchema,
  addedLines: z.int().nonnegative(),
  removedLines: z.int().nonnegative(),
  protectedPath: z.boolean(),
});

export const PatchValidationReportSchema = z.strictObject({
  decision: PolicyDecisionSchema,
  baseCommitSha: CommitShaSchema,
  changedFiles: z.int().nonnegative(),
  addedLines: z.int().nonnegative(),
  removedLines: z.int().nonnegative(),
  bytes: z.int().nonnegative(),
  files: z.array(ValidatedFileSchema).max(MAX_VALIDATED_FILES),
  findings: z.array(ValidationFindingSchema).max(MAX_VALIDATION_FINDINGS),
  approvals: z.array(ApprovalEffectSchema).max(MAX_VALIDATION_APPROVALS),
});

export type ValidationFindingCode = z.infer<typeof ValidationFindingCodeSchema>;
export type ValidationFinding = z.infer<typeof ValidationFindingSchema>;
export type ValidatedFile = z.infer<typeof ValidatedFileSchema>;
export type PatchValidationReport = z.infer<typeof PatchValidationReportSchema>;
