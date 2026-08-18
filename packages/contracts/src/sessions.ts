import { z } from 'zod';

import { ApprovalRecordSchema } from './approvals.js';
import { AttachmentMetadataSchema } from './attachments.js';
import { BranchNameSchema, RepositorySummarySchema } from './github.js';
import {
  AttachmentIdSchema,
  CommitShaSchema,
  IdempotencyKeySchema,
  IsoTimestampSchema,
  MessageIdSchema,
  SessionIdSchema,
} from './ids.js';
import { LIMITS } from './limits.js';
import { PullRequestResultSchema } from './pull-request.js';
import { CheckResultSchema, FileChangeSchema } from './tools.js';

export const SESSION_STATUSES = [
  'ready',
  'queued',
  'provisioning',
  'indexing',
  'working',
  'awaiting_user',
  'validating',
  'pushing',
  'completed',
  'pr_created',
  'failed',
  'cancelled',
] as const;

export const SessionStatusSchema = z.enum(SESSION_STATUSES);

/** A conversation is only deleted explicitly. These are terminal *turn* states. */
export const TERMINAL_SESSION_STATUSES = ['completed', 'pr_created', 'failed', 'cancelled'] as const;

export const RUN_STATUSES = [
  'queued',
  'working',
  'awaiting_user',
  'succeeded',
  'failed',
  'cancelled',
] as const;

export const DELIVERY_STATUSES = [
  'no_changes',
  'changes_ready',
  'pr_created',
  'pr_updated',
  'validation_failed',
  'checks_failed',
] as const;

export const RunStatusSchema = z.enum(RUN_STATUSES);
export const DeliveryStatusSchema = z.enum(DELIVERY_STATUSES);
export const ManualPrStateSchema = z.enum(['open', 'merged', 'closed']);
export const ManualPrStatesSchema = z.record(z.string().regex(/^\d+$/), ManualPrStateSchema).default({});

export const FAILURE_CODES = [
  'TASK_TOO_BROAD',
  'CLARIFICATION_TIMEOUT',
  'APPROVAL_TIMEOUT',
  'POLICY_DENIED',
  'AGENT_STUCK',
  'STEP_BUDGET_EXHAUSTED',
  'TOKEN_BUDGET_EXHAUSTED',
  'TIME_BUDGET_EXHAUSTED',
  'SANDBOX_FAILED',
  'REPOSITORY_EMPTY',
  'CHECKS_FAILED',
  'PATCH_REJECTED',
  'PUSH_FAILED',
  'PULL_REQUEST_FAILED',
  'PROVIDER_UNAVAILABLE',
  'MODEL_RATE_LIMITED',
  'MODEL_KEY_REJECTED',
  'MODEL_ANSWER_UNUSABLE',
  'INTERNAL_ERROR',
] as const;

export const FailureCodeSchema = z.enum(FAILURE_CODES);

export const SessionFailureSchema = z.strictObject({
  code: FailureCodeSchema,
  message: z.string().min(1).max(LIMITS.errorMessageMaxChars),
});

export const TaskSchema = z
  .string()
  .trim()
  .min(LIMITS.taskMinChars, { error: 'Describe the task in a little more detail' })
  .max(LIMITS.taskMaxChars, { error: 'Task description is too long' });

export const UserMessageSchema = z.string().trim().min(1).max(LIMITS.messageMaxChars);

export const MESSAGE_ROLES = ['user', 'agent'] as const;

export const MessageRoleSchema = z.enum(MESSAGE_ROLES);

export const SessionMessageSchema = z.strictObject({
  messageId: MessageIdSchema,
  role: MessageRoleSchema,
  text: z.string().min(1).max(LIMITS.messageMaxChars),
  sentAt: IsoTimestampSchema,
});

export const ModelSelectionSchema = z.strictObject({
  textModel: z.string().min(1).max(120),
});

export const CreateSessionBodySchema = z.strictObject({
  repositoryId: z.int().positive(),
  task: TaskSchema,
  attachmentIds: z.array(AttachmentIdSchema).max(LIMITS.maxAttachmentsPerSession).default([]),
  model: ModelSelectionSchema.optional(),
  idempotencyKey: IdempotencyKeySchema,
});

export const SessionSummarySchema = z.strictObject({
  sessionId: SessionIdSchema,
  status: SessionStatusSchema,
  runStatus: RunStatusSchema.nullable().default(null),
  deliveryStatus: DeliveryStatusSchema.nullable().default(null),
  manualPrStates: ManualPrStatesSchema,
  title: z.string().min(1).max(120),
  task: z.string().min(1).max(LIMITS.taskMaxChars),
  repository: RepositorySummarySchema,
  branch: BranchNameSchema.nullable(),
  pullRequest: PullRequestResultSchema.nullable(),
  createdAt: IsoTimestampSchema,
  lastActivityAt: IsoTimestampSchema,
  completedAt: IsoTimestampSchema.nullable(),
});

export const RenameSessionBodySchema = z.strictObject({
  title: z.string().trim().min(1).max(120),
});
export const SetPullRequestStateBodySchema = z.strictObject({
  number: z.int().positive(),
  state: ManualPrStateSchema,
});

export const SessionProgressSchema = z.strictObject({
  step: z.int().nonnegative(),
  maxSteps: z.int().positive(),
  currentActivity: z.string().max(LIMITS.summaryMaxChars).nullable(),
});

export const SessionDetailSchema = SessionSummarySchema.extend({
  model: ModelSelectionSchema.nullable(),
  baseCommitSha: CommitShaSchema.nullable(),
  attachments: z.array(AttachmentMetadataSchema).max(LIMITS.maxAttachmentsPerSession),
  messages: z.array(SessionMessageSchema).max(LIMITS.maxMessagesPerSession),
  progress: SessionProgressSchema,
  filesChanged: z.array(FileChangeSchema).max(LIMITS.maxChangedFiles),
  checks: z.array(CheckResultSchema).max(LIMITS.maxChecksPerSession),
  approvals: z.array(ApprovalRecordSchema).max(50),
  failure: SessionFailureSchema.nullable(),
});

export const SessionListResponseSchema = z.strictObject({
  sessions: z.array(SessionSummarySchema).max(LIMITS.sessionHistoryPageSize),
  activeSessionId: SessionIdSchema.nullable(),
});

export const SessionDetailResponseSchema = z.strictObject({
  session: SessionDetailSchema,
  lastEventSequence: z.int().nonnegative(),
});

export const CreateSessionResponseSchema = z.strictObject({
  session: SessionSummarySchema,
});

export const PostMessageBodySchema = z.strictObject({
  message: UserMessageSchema,
  idempotencyKey: IdempotencyKeySchema,
});

export const AnswerSessionBodySchema = z.strictObject({
  message: UserMessageSchema,
});

export const PostMessageResponseSchema = z.strictObject({
  message: SessionMessageSchema,
});

export const CancelSessionResponseSchema = z.strictObject({
  sessionId: SessionIdSchema,
  status: SessionStatusSchema,
});

export const DeleteSessionResponseSchema = z.strictObject({ sessionId: SessionIdSchema });

export type SessionStatus = z.infer<typeof SessionStatusSchema>;
export type RunStatus = z.infer<typeof RunStatusSchema>;
export type DeliveryStatus = z.infer<typeof DeliveryStatusSchema>;
export type ManualPrState = z.infer<typeof ManualPrStateSchema>;
export type SetPullRequestStateBody = z.infer<typeof SetPullRequestStateBodySchema>;
export type FailureCode = z.infer<typeof FailureCodeSchema>;
export type SessionFailure = z.infer<typeof SessionFailureSchema>;
export type ModelSelection = z.infer<typeof ModelSelectionSchema>;
export type MessageRole = z.infer<typeof MessageRoleSchema>;
export type SessionMessage = z.infer<typeof SessionMessageSchema>;
export type CreateSessionBody = z.infer<typeof CreateSessionBodySchema>;
export type RenameSessionBody = z.infer<typeof RenameSessionBodySchema>;
export type SessionSummary = z.infer<typeof SessionSummarySchema>;
export type SessionProgress = z.infer<typeof SessionProgressSchema>;
export type SessionDetail = z.infer<typeof SessionDetailSchema>;
export type SessionListResponse = z.infer<typeof SessionListResponseSchema>;
export type SessionDetailResponse = z.infer<typeof SessionDetailResponseSchema>;
export type CreateSessionResponse = z.infer<typeof CreateSessionResponseSchema>;
export type PostMessageBody = z.infer<typeof PostMessageBodySchema>;
export type AnswerSessionBody = z.infer<typeof AnswerSessionBodySchema>;
export type PostMessageResponse = z.infer<typeof PostMessageResponseSchema>;
export type CancelSessionResponse = z.infer<typeof CancelSessionResponseSchema>;
export type DeleteSessionResponse = z.infer<typeof DeleteSessionResponseSchema>;
