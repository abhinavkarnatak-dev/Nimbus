import { z } from 'zod';

import { LIMITS } from './limits.js';

export const TOOL_NAMES = [
  'list_tree',
  'search_code',
  'semantic_search',
  'read_file',
  'apply_patch',
  'create_file',
  'run_command',
  'run_checks',
  'git_status',
  'prepare_commit',
  'message_user',
  'finish_task',
  'wait_for_user',
] as const;

export const ToolNameSchema = z.enum(TOOL_NAMES);

export const ToolOutcomeSchema = z.enum([
  'succeeded',
  'failed',
  'denied',
  'timed_out',
  'cancelled',
]);

export const OutputStreamSchema = z.enum(['stdout', 'stderr']);

export const WorkspacePathSchema = z
  .string()
  .min(1)
  .max(LIMITS.pathMaxChars)
  .refine((value) => !value.startsWith('/') && !/^[A-Za-z]:/.test(value), {
    error: 'Path must be relative to the workspace root',
  })
  .refine((value) => !value.split('/').includes('..'), {
    error: 'Path must not traverse outside the workspace',
  })
  .refine((value) => !value.split('/').includes('.git'), {
    error: 'Path must not reference the Git directory',
  });

export const FileChangeKindSchema = z.enum(['added', 'modified', 'deleted', 'renamed']);

export const FileDiffSchema = z.string().max(LIMITS.fileDiffMaxChars);

export const FileChangeSchema = z.strictObject({
  path: WorkspacePathSchema,
  changeKind: FileChangeKindSchema,
  previousPath: WorkspacePathSchema.optional(),
  addedLines: z.int().nonnegative(),
  removedLines: z.int().nonnegative(),
  diff: FileDiffSchema,
  diffTruncated: z.boolean(),
});

export const CheckKindSchema = z.enum(['test', 'lint', 'typecheck', 'build']);

export const CheckStatusSchema = z.enum([
  'passed',
  'failed',
  'unavailable',
  'blocked',
  'timed_out',
  'errored',
  'cancelled',
  'skipped',
  // Kept on the wire while pre-V1.1 session records are migrated.
  'not_run',
]);

export const CHECK_REASONS = [
  'source_failure',
  'test_failure',
  'lint_failure',
  'typecheck_failure',
  'build_failure',
  'compiler_missing',
  'runtime_missing',
  'dependency_missing',
  'permission_denied',
  'network_denied',
  'filesystem_denied',
  'resource_limit',
  'invalid_command',
  'unsupported_language',
  'baseline_failure',
  'cancelled',
  'unknown',
] as const;

export const CheckReasonSchema = z.enum(CHECK_REASONS);
export const BaselineStatusSchema = z.enum([
  'not_compared',
  'introduced',
  'pre_existing',
  'mixed',
  'infrastructure',
  'unknown',
]);

export const CommandDescriptorSchema = z.strictObject({
  executable: z.string().min(1).max(500),
  args: z.array(z.string().max(4_096)).max(64),
  workingDirectory: z.string().min(1).max(LIMITS.pathMaxChars),
  purpose: z.string().min(1).max(LIMITS.summaryMaxChars),
  source: z.enum(['repository', 'trusted_infrastructure']),
  display: z.string().min(1).max(2_000),
});

export const CheckResultSchema = z.strictObject({
  checkId: z.string().min(1).max(120).optional(),
  name: z.string().min(1).max(120),
  kind: CheckKindSchema,
  status: CheckStatusSchema,
  reason: CheckReasonSchema.optional(),
  summary: z.string().max(LIMITS.summaryMaxChars),
  command: CommandDescriptorSchema.optional(),
  scope: z.array(WorkspacePathSchema).max(LIMITS.maxFilesListed).optional(),
  revision: z
    .strictObject({ number: z.int().nonnegative(), treeHash: z.string().regex(/^[0-9a-f]{64}$/) })
    .optional(),
  exitCode: z.int().nullable().optional(),
  durationMs: z.int().nonnegative().optional(),
  output: z.string().max(LIMITS.toolOutputChunkMaxChars).optional(),
  outputTruncated: z.boolean().optional(),
  required: z.boolean().optional(),
  fallbackAvailable: z.boolean().optional(),
  baselineStatus: BaselineStatusSchema.optional(),
});

export const ToolInvocationSchema = z.strictObject({
  toolCallId: z.string().min(1).max(64),
  tool: ToolNameSchema,
  summary: z.string().min(1).max(LIMITS.summaryMaxChars),
  paths: z.array(WorkspacePathSchema).max(LIMITS.maxFilesListed),
  startedAt: z.iso.datetime({ offset: false }),
  phase: z.string().min(1).max(40).optional(),
  command: CommandDescriptorSchema.optional(),
  workspaceRevision: z.int().nonnegative().optional(),
});

export type ToolName = z.infer<typeof ToolNameSchema>;
export type ToolOutcome = z.infer<typeof ToolOutcomeSchema>;
export type OutputStream = z.infer<typeof OutputStreamSchema>;
export type WorkspacePath = z.infer<typeof WorkspacePathSchema>;
export type FileChangeKind = z.infer<typeof FileChangeKindSchema>;
export type FileChange = z.infer<typeof FileChangeSchema>;
export type CheckKind = z.infer<typeof CheckKindSchema>;
export type CheckStatus = z.infer<typeof CheckStatusSchema>;
export type CheckResult = z.infer<typeof CheckResultSchema>;
export type CheckReason = z.infer<typeof CheckReasonSchema>;
export type BaselineStatus = z.infer<typeof BaselineStatusSchema>;
export type CommandDescriptor = z.infer<typeof CommandDescriptorSchema>;
export type ToolInvocation = z.infer<typeof ToolInvocationSchema>;
