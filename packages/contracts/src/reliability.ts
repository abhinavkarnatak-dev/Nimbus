import { z } from 'zod';

import { ActionHashSchema, IsoTimestampSchema } from './ids.js';
import { LIMITS } from './limits.js';
import { CheckKindSchema, WorkspacePathSchema } from './tools.js';

export const AGENT_PHASES_V1_1 = [
  'scoping',
  'investigating',
  'planning',
  'implementing',
  'verifying',
  'reviewing',
  'packaging',
  'awaiting_clarification',
  'awaiting_approval',
  'completed',
  'failed',
  'cancelled',
] as const;

export const ReliableAgentPhaseSchema = z.enum(AGENT_PHASES_V1_1);

export const TASK_MODES = ['informational', 'code_change'] as const;
export const TaskModeSchema = z.enum(TASK_MODES);

export const CRITERION_VERIFICATION_TYPES = [
  'repository_evidence',
  'diff',
  'test',
  'lint',
  'typecheck',
  'build',
  'review',
  'user_confirmation',
] as const;
export const CriterionVerificationTypeSchema = z.enum(CRITERION_VERIFICATION_TYPES);
export const CriterionStatusSchema = z.enum(['pending', 'satisfied', 'blocked', 'failed']);

export const AcceptanceCriterionSchema = z.strictObject({
  criterionId: z.string().regex(/^ac_[a-z0-9_-]{1,48}$/),
  description: z.string().min(1).max(LIMITS.reasonMaxChars),
  verificationType: CriterionVerificationTypeSchema,
  material: z.boolean(),
  status: CriterionStatusSchema,
  evidenceIds: z.array(z.string().min(1).max(80)).max(40),
});

export const TaskSpecSchema = z.strictObject({
  mode: TaskModeSchema,
  objective: z.string().min(1).max(LIMITS.taskMaxChars),
  acceptanceCriteria: z.array(AcceptanceCriterionSchema).min(1).max(40),
  constraints: z.array(z.string().min(1).max(LIMITS.reasonMaxChars)).max(40),
  requestedPaths: z.array(WorkspacePathSchema).max(LIMITS.maxFilesListed),
  prohibitedEffects: z.array(z.string().min(1).max(LIMITS.reasonMaxChars)).max(40),
  blockingAmbiguity: z.string().max(LIMITS.messageMaxChars).nullable(),
});

export const WorkspaceRevisionSchema = z.strictObject({
  number: z.int().nonnegative(),
  treeHash: z.string().regex(/^[0-9a-f]{64}$/),
});

export const EVIDENCE_KINDS = [
  'repository_tree',
  'search',
  'file_content',
  'symbol',
  'dependency',
  'edit',
  'check',
  'diff',
  'user_answer',
  'approval',
  'review',
  'capability',
] as const;
export const EvidenceKindSchema = z.enum(EVIDENCE_KINDS);

export const EvidenceRecordSchema = z.strictObject({
  evidenceId: z.string().regex(/^ev_[a-zA-Z0-9_-]{1,64}$/),
  kind: EvidenceKindSchema,
  title: z.string().min(1).max(LIMITS.summaryMaxChars),
  summary: z.string().max(LIMITS.reasonMaxChars),
  paths: z.array(WorkspacePathSchema).max(LIMITS.maxFilesListed),
  revision: WorkspaceRevisionSchema,
  contentHash: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
  createdAt: IsoTimestampSchema,
  current: z.boolean(),
});

export const ChangePlanSchema = z.strictObject({
  planId: z.string().regex(/^plan_[a-zA-Z0-9_-]{1,64}$/),
  hypothesis: z.string().min(1).max(LIMITS.reasonMaxChars),
  inspectPaths: z.array(WorkspacePathSchema).max(LIMITS.maxFilesListed),
  likelyChangedPaths: z.array(WorkspacePathSchema).max(LIMITS.maxChangedFiles),
  criterionIds: z.array(z.string().regex(/^ac_[a-z0-9_-]{1,48}$/)).min(1).max(40),
  validationPlan: z.array(z.string().min(1).max(LIMITS.reasonMaxChars)).min(1).max(20),
  risks: z.array(z.string().min(1).max(LIMITS.reasonMaxChars)).max(20),
  basedOnRevision: WorkspaceRevisionSchema,
  invalidatedByEvidenceId: z.string().min(1).max(80).nullable(),
});

export const FAILURE_CLASSES = [
  'invalid_arguments',
  'ineligible',
  'no_results',
  'no_progress',
  'stale_input',
  'transient_failure',
  'permanent_failure',
  'policy_denial',
  'cancellation',
  'timeout',
  'resource_exhaustion',
  'unknown_outcome',
] as const;
export const FailureClassSchema = z.enum(FAILURE_CLASSES);

export const ProgressKindSchema = z.enum([
  'new_path',
  'new_symbol',
  'new_content',
  'new_dependency',
  'workspace_change',
  'new_check_result',
  'diagnosed_failure',
  'resolved_assumption',
  'resolved_criterion',
  'user_answer',
  'approval',
  'none',
]);

export const ActionRecordSchema = z.strictObject({
  actionId: z.string().min(1).max(96),
  actionHash: ActionHashSchema,
  semanticId: ActionHashSchema,
  tool: z.string().min(1).max(60),
  revision: WorkspaceRevisionSchema,
  outcome: FailureClassSchema.nullable(),
  progress: ProgressKindSchema,
  evidenceIds: z.array(z.string().min(1).max(80)).max(20),
  at: IsoTimestampSchema,
});

export const PhaseBudgetSchema = z.strictObject({
  modelCalls: z.int().nonnegative(),
  maxModelCalls: z.int().positive(),
  toolCalls: z.int().nonnegative(),
  maxToolCalls: z.int().positive(),
  retries: z.int().nonnegative(),
  maxRetries: z.int().nonnegative(),
  noProgressActions: z.int().nonnegative(),
  maxNoProgressActions: z.int().positive(),
  startedAtMs: z.int().positive(),
  maxDurationMs: z.int().positive(),
});

export const REVIEW_VERDICTS = ['accepted', 'revision_requested', 'uncertain'] as const;
export const ReviewVerdictSchema = z.enum(REVIEW_VERDICTS);
export const PatchReviewSchema = z.strictObject({
  verdict: ReviewVerdictSchema,
  summary: z.string().min(1).max(LIMITS.reasonMaxChars),
  findings: z.array(z.string().min(1).max(LIMITS.reasonMaxChars)).max(40),
  evidenceIds: z.array(z.string().min(1).max(80)).max(40),
  revision: WorkspaceRevisionSchema,
  reviewedAt: IsoTimestampSchema,
});

export const DELIVERY_STAGES = [
  'not_started',
  'patch_validated',
  'branch_pushing',
  'branch_pushed',
  'pr_opening',
  'pr_created',
] as const;
export const DeliveryStageSchema = z.enum(DELIVERY_STAGES);

export const RepositoryProfileSchema = z.strictObject({
  baseCommitSha: z.string().regex(/^[0-9a-f]{40}$/),
  languages: z.array(z.string().min(1).max(40)).max(30),
  packageRoots: z.array(WorkspacePathSchema).max(100),
  sourceRoots: z.array(WorkspacePathSchema).max(100),
  testRoots: z.array(WorkspacePathSchema).max(100),
  generatedPaths: z.array(WorkspacePathSchema).max(100),
  manifests: z.array(WorkspacePathSchema).max(100),
  frameworks: z.array(z.string().min(1).max(80)).max(40),
  workspaceBoundaries: z.array(WorkspacePathSchema).max(100),
  checkIds: z.array(z.string().min(1).max(80)).max(100),
  digest: z.string().regex(/^[0-9a-f]{64}$/),
});

export const SandboxCapabilitySchema = z.strictObject({
  imageVersion: z.string().min(1).max(120),
  executables: z.record(z.string(), z.string().max(120).nullable()),
  readableRoots: z.array(z.string().min(1).max(500)).max(20),
  writableRoots: z.array(z.string().min(1).max(500)).max(20),
  network: z.literal('denied'),
  commandTimeoutMs: z.int().positive(),
  outputLimitChars: z.int().positive(),
  digest: z.string().regex(/^[0-9a-f]{64}$/),
});

export const ClarificationRequestSchema = z.strictObject({
  clarificationId: z.string().regex(/^clr_[a-zA-Z0-9_-]{1,64}$/),
  question: z.string().min(1).max(LIMITS.messageMaxChars),
  context: z.string().max(LIMITS.reasonMaxChars),
  options: z.array(z.string().min(1).max(300)).max(8),
  allowFreeText: z.boolean(),
  blockingCriterionIds: z.array(z.string().regex(/^ac_[a-z0-9_-]{1,48}$/)).max(40),
  requestedAt: IsoTimestampSchema,
  expiresAt: IsoTimestampSchema,
  answer: z.string().max(LIMITS.clarificationAnswerMaxChars).nullable(),
  answeredAt: IsoTimestampSchema.nullable(),
});

export type ReliableAgentPhase = z.infer<typeof ReliableAgentPhaseSchema>;
export type TaskMode = z.infer<typeof TaskModeSchema>;
export type AcceptanceCriterion = z.infer<typeof AcceptanceCriterionSchema>;
export type TaskSpec = z.infer<typeof TaskSpecSchema>;
export type WorkspaceRevision = z.infer<typeof WorkspaceRevisionSchema>;
export type EvidenceRecord = z.infer<typeof EvidenceRecordSchema>;
export type ChangePlan = z.infer<typeof ChangePlanSchema>;
export type FailureClass = z.infer<typeof FailureClassSchema>;
export type ProgressKind = z.infer<typeof ProgressKindSchema>;
export type ActionRecord = z.infer<typeof ActionRecordSchema>;
export type PhaseBudget = z.infer<typeof PhaseBudgetSchema>;
export type PatchReview = z.infer<typeof PatchReviewSchema>;
export type DeliveryStage = z.infer<typeof DeliveryStageSchema>;
export type RepositoryProfile = z.infer<typeof RepositoryProfileSchema>;
export type SandboxCapability = z.infer<typeof SandboxCapabilitySchema>;
export type ClarificationRequest = z.infer<typeof ClarificationRequestSchema>;
