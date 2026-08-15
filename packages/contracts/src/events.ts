import { z } from 'zod';

import { ApprovalRequestSchema } from './approvals.js';
import { IsoTimestampSchema, SessionIdSchema } from './ids.js';
import { LIMITS } from './limits.js';
import { PullRequestResultSchema } from './pull-request.js';
import {
  SessionDetailSchema,
  SessionFailureSchema,
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

export const SERVER_EVENT_TYPES = [
  'session.snapshot',
  'session.status',
  'agent.message',
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
] as const;

export const ServerEventTypeSchema = z.enum(SERVER_EVENT_TYPES);

const SessionSnapshotEventSchema = z.strictObject({
  type: z.literal('session.snapshot'),
  session: SessionDetailSchema,
});

const SessionStatusEventSchema = z.strictObject({
  type: z.literal('session.status'),
  status: SessionStatusSchema,
  progress: SessionProgressSchema,
});

const AgentMessageEventSchema = z.strictObject({
  type: z.literal('agent.message'),
  message: z.string().min(1).max(LIMITS.messageMaxChars),
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

export const ServerEventSchema = z.discriminatedUnion('type', [
  SessionSnapshotEventSchema,
  SessionStatusEventSchema,
  AgentMessageEventSchema,
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
]);

export const SessionEventEnvelopeSchema = z.strictObject({
  v: z.literal(CONTRACTS_WIRE_VERSION),
  sequence: z.int().positive(),
  sessionId: SessionIdSchema,
  emittedAt: IsoTimestampSchema,
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
