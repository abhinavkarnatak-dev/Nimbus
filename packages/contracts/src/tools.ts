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

export const CheckStatusSchema = z.enum(['passed', 'failed', 'errored', 'not_run']);

export const CheckResultSchema = z.strictObject({
  name: z.string().min(1).max(120),
  kind: CheckKindSchema,
  status: CheckStatusSchema,
  summary: z.string().max(LIMITS.summaryMaxChars),
  durationMs: z.int().nonnegative().optional(),
});

export const ToolInvocationSchema = z.strictObject({
  toolCallId: z.string().min(1).max(64),
  tool: ToolNameSchema,
  summary: z.string().min(1).max(LIMITS.summaryMaxChars),
  paths: z.array(WorkspacePathSchema).max(LIMITS.maxFilesListed),
  startedAt: z.iso.datetime({ offset: false }),
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
export type ToolInvocation = z.infer<typeof ToolInvocationSchema>;
