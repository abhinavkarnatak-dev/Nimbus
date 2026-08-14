import { z } from 'zod';

import { PolicyDecisionSchema } from './approvals.js';
import { AttachmentIdSchema, CommitShaSchema, SessionIdSchema, UserIdSchema } from './ids.js';
import { LIMITS } from './limits.js';
import { BudgetStateSchema } from './llm.js';
import { ModelPlanSchema } from './routing.js';
import { BranchNameSchema } from './github.js';
import { CheckResultSchema } from './tools.js';

export const AGENT_STATE_VERSION = 2;

export const AGENT_PHASES = [
  'starting',
  'clarifying',
  'retrieving',
  'reasoning',
  'awaiting_approval',
  'executing',
  'validating',
  'preparing_patch',
  'finished',
  'failed',
] as const;

export const AgentPhaseSchema = z.enum(AGENT_PHASES);

export const AGENT_STOP_REASONS = [
  'completed',
  'step_budget',
  'retry_budget',
  'repeated_action',
  'token_budget',
  'time_budget',
  'cancelled',
  'failed',
] as const;

export const AgentStopReasonSchema = z.enum(AGENT_STOP_REASONS);

export const MAX_RETRIEVED_FILES = 20;
export const MAX_FILES_READ = 100;
export const MAX_TOOL_EVENTS = 60;
export const MAX_CHECK_RESULTS = 12;
export const MAX_SNIPPET_CHARS = 4_000;
export const MAX_SUMMARY_CHARS = 500;

const boundedPath = z.string().min(1).max(LIMITS.pathMaxChars);

export const AgentBudgetsSchema = z.strictObject({
  steps: z.int().nonnegative(),
  maxSteps: z.int().positive(),
  retries: z.int().nonnegative(),
  maxRetries: z.int().positive(),
  startedAtMs: z.int().positive(),
  maxDurationMs: z.int().positive(),
  llm: BudgetStateSchema,
});

export const RetrievedFileSchema = z.strictObject({
  path: boundedPath,
  startLine: z.int().positive(),
  endLine: z.int().positive(),
  snippet: z.string().max(MAX_SNIPPET_CHARS),
});

export const ProposedActionSchema = z.strictObject({
  tool: z.string().min(1).max(60),
  reason: z.string().min(1).max(LIMITS.reasonMaxChars),
  argumentsJson: z.string().max(LIMITS.toolOutputChunkMaxChars),
  actionHash: z.string().regex(/^[0-9a-f]{64}$/),
});

export const PolicyRecordSchema = z.strictObject({
  decision: PolicyDecisionSchema,
  actionHash: z.string().regex(/^[0-9a-f]{64}$/),
  reason: z.string().min(1).max(LIMITS.reasonMaxChars),
  decidedAtMs: z.int().positive(),
  approvedByUser: z.boolean(),
});

export const ToolEventSummarySchema = z.strictObject({
  step: z.int().nonnegative(),
  tool: z.string().min(1).max(60),
  outcome: z.enum(['ok', 'refused', 'paused', 'failed']),
  summary: z.string().min(1).max(MAX_SUMMARY_CHARS),
  atMs: z.int().positive(),
});

export const AgentStateSchema = z.strictObject({
  version: z.literal(AGENT_STATE_VERSION),
  sessionId: SessionIdSchema,
  userId: UserIdSchema,
  repositoryId: z.int().positive(),
  installationId: z.int().positive(),

  task: z.string().min(1).max(LIMITS.taskMaxChars),
  clarificationQuestion: z.string().max(LIMITS.messageMaxChars).nullable(),
  clarificationAnswer: z.string().max(LIMITS.clarificationAnswerMaxChars).nullable(),
  attachmentIds: z.array(AttachmentIdSchema).max(LIMITS.maxAttachmentsPerSession),
  imageDescriptions: z
    .array(z.string().max(MAX_SNIPPET_CHARS))
    .max(LIMITS.maxAttachmentsPerSession),

  baseCommitSha: CommitShaSchema,
  defaultBranch: BranchNameSchema,
  featureBranch: BranchNameSchema.nullable(),
  sandboxId: z.string().max(120).nullable(),

  phase: AgentPhaseSchema,
  stopReason: AgentStopReasonSchema.nullable(),
  budgets: AgentBudgetsSchema,
  models: ModelPlanSchema,

  retrieved: z.array(RetrievedFileSchema).max(MAX_RETRIEVED_FILES),
  filesRead: z.array(boundedPath).max(MAX_FILES_READ),
  filesChanged: z.array(boundedPath).max(LIMITS.maxChangedFiles),

  proposedAction: ProposedActionSchema.nullable(),
  policy: PolicyRecordSchema.nullable(),
  toolEvents: z.array(ToolEventSummarySchema).max(MAX_TOOL_EVENTS),
  checks: z.array(CheckResultSchema).max(MAX_CHECK_RESULTS),
});

export const CheckpointMetadataSchema = z.strictObject({
  sessionId: SessionIdSchema,
  version: z.int().positive(),
  baseCommitSha: CommitShaSchema,
  writtenAtMs: z.int().positive(),
});

export type AgentPhase = z.infer<typeof AgentPhaseSchema>;
export type AgentStopReason = z.infer<typeof AgentStopReasonSchema>;
export type AgentBudgets = z.infer<typeof AgentBudgetsSchema>;
export type RetrievedFile = z.infer<typeof RetrievedFileSchema>;
export type ProposedAction = z.infer<typeof ProposedActionSchema>;
export type PolicyRecord = z.infer<typeof PolicyRecordSchema>;
export type ToolEventSummary = z.infer<typeof ToolEventSummarySchema>;
export type AgentState = z.infer<typeof AgentStateSchema>;
export type CheckpointMetadata = z.infer<typeof CheckpointMetadataSchema>;
