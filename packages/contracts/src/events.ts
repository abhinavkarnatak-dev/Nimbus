import { z } from 'zod';

import { ApprovalRequestSchema } from './approvals.js';
import { IsoTimestampSchema, SessionIdSchema } from './ids.js';
import { LIMITS } from './limits.js';
import { PullRequestResultSchema } from './pull-request.js';
import {
  SessionFailureSchema,
  SessionMessageSchema,
  SessionProgressSchema,
  SessionStatusSchema,
} from './sessions.js';
import {
  CheckResultSchema,
  FileChangeSchema,
  OutputStreamSchema,
  ToolInvocationSchema,
  ToolNameSchema,
  ToolOutcomeSchema,
} from './tools.js';
import { CONTRACTS_WIRE_VERSION } from './version.js';
import { DeliveryStageSchema, ProgressKindSchema, ReliableAgentPhaseSchema, WorkspaceRevisionSchema } from './reliability.js';

export const SERVER_EVENT_TYPES = [
  'session.status',
  'agent.message',
  'agent.message.delta',
  'agent.question',
  'agent.approval_required',
  'tool.started',
  'tool.output',
  'tool.completed',
  'files.changed',
  'checks.updated',
  'pr.created',
  'session.failed',
  'session.cancelled',
  'agent.phase',
  'agent.activity',
  'agent.progress',
  'review.updated',
  'delivery.updated',
  'clarification.required',
] as const;

export const ServerEventTypeSchema = z.enum(SERVER_EVENT_TYPES);

const SessionStatusEventSchema = z.strictObject({
  type: z.literal('session.status'),
  status: SessionStatusSchema,
  progress: SessionProgressSchema,
});

const AgentMessageEventSchema = z.strictObject({
  type: z.literal('agent.message'),
  message: SessionMessageSchema,
});

const AgentMessageDeltaEventSchema = z.strictObject({
  type: z.literal('agent.message.delta'),
  messageId: SessionMessageSchema.shape.messageId,
  text: z.string().min(1).max(LIMITS.messageMaxChars),
  sentAt: IsoTimestampSchema,
});

const AgentQuestionEventSchema = z.strictObject({
  type: z.literal('agent.question'),
  question: z.string().min(1).max(LIMITS.messageMaxChars),
  expiresAt: IsoTimestampSchema,
});

const AgentApprovalRequiredEventSchema = z.strictObject({
  type: z.literal('agent.approval_required'),
  approval: ApprovalRequestSchema,
});

const ToolStartedEventSchema = z.strictObject({
  type: z.literal('tool.started'),
  invocation: ToolInvocationSchema,
});

const ToolOutputEventSchema = z.strictObject({
  type: z.literal('tool.output'),
  toolCallId: z.string().min(1).max(64),
  stream: OutputStreamSchema,
  chunk: z.string().max(LIMITS.toolOutputChunkMaxChars),
  truncated: z.boolean(),
});

const ToolCompletedEventSchema = z.strictObject({
  type: z.literal('tool.completed'),
  toolCallId: z.string().min(1).max(64),
  tool: ToolNameSchema,
  outcome: ToolOutcomeSchema,
  durationMs: z.int().nonnegative(),
  summary: z.string().max(LIMITS.summaryMaxChars),
});

const FilesChangedEventSchema = z.strictObject({
  type: z.literal('files.changed'),
  files: z.array(FileChangeSchema).max(LIMITS.maxChangedFiles),
});

const ChecksUpdatedEventSchema = z.strictObject({
  type: z.literal('checks.updated'),
  checks: z.array(CheckResultSchema).max(LIMITS.maxChecksPerSession),
});

const PullRequestCreatedEventSchema = z.strictObject({
  type: z.literal('pr.created'),
  pullRequest: PullRequestResultSchema,
});

const SessionFailedEventSchema = z.strictObject({
  type: z.literal('session.failed'),
  failure: SessionFailureSchema,
});

const SessionCancelledEventSchema = z.strictObject({
  type: z.literal('session.cancelled'),
  cancelledAt: IsoTimestampSchema,
});

const AgentPhaseEventSchema = z.strictObject({
  type: z.literal('agent.phase'),
  phase: ReliableAgentPhaseSchema,
  activity: z.string().max(LIMITS.summaryMaxChars).nullable(),
  completedPhases: z.array(ReliableAgentPhaseSchema).max(12),
  remainingPhases: z.array(ReliableAgentPhaseSchema).max(12),
});

const AgentActivityEventSchema = z.strictObject({
  type: z.literal('agent.activity'),
  activity: z.string().min(1).max(LIMITS.summaryMaxChars),
  level: z.enum(['primary', 'secondary']),
});

const AgentProgressEventSchema = z.strictObject({
  type: z.literal('agent.progress'),
  progress: ProgressKindSchema,
  summary: z.string().max(LIMITS.summaryMaxChars),
  evidenceIds: z.array(z.string().min(1).max(80)).max(40),
});

const ReviewUpdatedEventSchema = z.strictObject({
  type: z.literal('review.updated'),
  verdict: z.enum(['accepted', 'revision_requested', 'uncertain']),
  summary: z.string().max(LIMITS.summaryMaxChars),
});

const DeliveryUpdatedEventSchema = z.strictObject({
  type: z.literal('delivery.updated'),
  stage: DeliveryStageSchema,
  summary: z.string().max(LIMITS.summaryMaxChars),
});

const ClarificationRequiredEventSchema = z.strictObject({
  type: z.literal('clarification.required'),
  clarificationId: z.string().min(1).max(80),
  question: z.string().min(1).max(LIMITS.messageMaxChars),
  context: z.string().max(LIMITS.reasonMaxChars),
  options: z.array(z.string().min(1).max(300)).max(8),
  allowFreeText: z.boolean(),
  blockingCriterionIds: z.array(z.string().min(1).max(80)).max(40),
  expiresAt: IsoTimestampSchema,
});

export const ServerEventSchema = z.discriminatedUnion('type', [
  SessionStatusEventSchema,
  AgentMessageEventSchema,
  AgentMessageDeltaEventSchema,
  AgentQuestionEventSchema,
  AgentApprovalRequiredEventSchema,
  ToolStartedEventSchema,
  ToolOutputEventSchema,
  ToolCompletedEventSchema,
  FilesChangedEventSchema,
  ChecksUpdatedEventSchema,
  PullRequestCreatedEventSchema,
  SessionFailedEventSchema,
  SessionCancelledEventSchema,
  AgentPhaseEventSchema,
  AgentActivityEventSchema,
  AgentProgressEventSchema,
  ReviewUpdatedEventSchema,
  DeliveryUpdatedEventSchema,
  ClarificationRequiredEventSchema,
]);

export const SessionEventEnvelopeSchema = z.strictObject({
  v: z.literal(CONTRACTS_WIRE_VERSION),
  sequence: z.int().positive(),
  sessionId: SessionIdSchema,
  emittedAt: IsoTimestampSchema,
  eventId: z.string().min(1).max(96),
  runId: z.string().min(1).max(120),
  phase: ReliableAgentPhaseSchema.nullable(),
  step: z.int().nonnegative(),
  title: z.string().min(1).max(LIMITS.summaryMaxChars),
  detail: z.string().max(LIMITS.summaryMaxChars),
  relatedObjectIds: z.array(z.string().min(1).max(120)).max(20),
  workspaceRevision: WorkspaceRevisionSchema.nullable(),
  event: ServerEventSchema,
});

export const SubscribeSessionPayloadSchema = z.strictObject({
  v: z.literal(CONTRACTS_WIRE_VERSION),
  sessionId: SessionIdSchema,
  lastEventSequence: z.int().nonnegative(),
});

export const UnsubscribeSessionPayloadSchema = z.strictObject({
  v: z.literal(CONTRACTS_WIRE_VERSION),
  sessionId: SessionIdSchema,
});

export const CLIENT_EVENT_TYPES = ['session.subscribe', 'session.unsubscribe'] as const;

export const ClientEventTypeSchema = z.enum(CLIENT_EVENT_TYPES);

export const ClientMessageSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('session.subscribe'),
    payload: SubscribeSessionPayloadSchema,
  }),
  z.strictObject({
    type: z.literal('session.unsubscribe'),
    payload: UnsubscribeSessionPayloadSchema,
  }),
]);

export type ServerEventType = z.infer<typeof ServerEventTypeSchema>;
export type ServerEvent = z.infer<typeof ServerEventSchema>;
export type SessionEventEnvelope = z.infer<typeof SessionEventEnvelopeSchema>;
export type SubscribeSessionPayload = z.infer<typeof SubscribeSessionPayloadSchema>;
export type UnsubscribeSessionPayload = z.infer<typeof UnsubscribeSessionPayloadSchema>;
export type ClientEventType = z.infer<typeof ClientEventTypeSchema>;
export type ClientMessage = z.infer<typeof ClientMessageSchema>;
