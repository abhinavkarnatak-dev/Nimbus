import { createHash } from 'node:crypto';

import {
  ApprovalCategorySchema,
  ApprovalStatusSchema,
  AttachmentKindSchema,
  AttachmentMetadataSchema,
  AttachmentMimeTypeSchema,
  ApprovalRecordSchema,
  CheckKindSchema,
  CheckStatusSchema,
  FailureCodeSchema,
  FileChangeKindSchema,
  LIMITS,
  MESSAGE_ROLES,
  PullRequestResultSchema,
  RepositorySummarySchema,
  RiskLevelSchema,
  RunStatusSchema,
  DeliveryStatusSchema,
  SESSION_STATUSES,
  SessionDetailSchema,
  SessionMessageSchema,
  SessionSummarySchema,
  ToolNameSchema,
  ToolOutcomeSchema,
  type ApprovalEffect,
  type ApprovalRecord,
  type ApprovalStatus,
  type AttachmentKind,
  type AttachmentMetadata,
  type AttachmentMimeType,
  type CheckResult,
  type FileChange,
  type MessageRole,
  type ModelSelection,
  type PullRequestResult,
  type RepositorySummary,
  type SessionDetail,
  type RunStatus,
  type DeliveryStatus,
  type SessionMessage,
  type SessionFailure,
  type SessionStatus,
  type SessionSummary,
  type ToolName,
  type ToolOutcome,
} from '@nimbus/contracts';
import type { Collection, Db } from 'mongodb';

import { COLLECTIONS } from '../collections.js';
import {
  COMMIT_SHA_PATTERN,
  ACTION_HASH_PATTERN,
  OBJECT_ID_PROPERTY,
  publicIdPattern,
  toIsoTimestamp,
  toIsoTimestampOrNull,
  type ModelDefinition,
} from './shared.js';

export const SESSION_ID_PREFIX = 'ses';
export const MESSAGE_ID_PREFIX = 'msg';

export const MAX_SESSION_MESSAGES = LIMITS.maxMessagesPerSession;

export const ACTIVE_SESSION_STATUSES: readonly SessionStatus[] = SESSION_STATUSES.filter(
  (status) => ['queued', 'provisioning', 'indexing', 'working', 'awaiting_user', 'validating', 'pushing'].includes(status),
);

export interface SessionRepositoryDocument {
  repositoryId: number;
  owner: string;
  name: string;
  defaultBranch: string;
  visibility: 'public';
  htmlUrl: string;
  updatedAt: Date;
}

export interface SessionAttachmentDocument {
  attachmentId: string;
  kind: AttachmentKind;
  mimeType: AttachmentMimeType;
  byteSize: number;
  originalName: string;
  createdAt: Date;
}

export interface SessionApprovalDocument {
  approvalId: string;
  actionHash: string;
  effect: ApprovalEffect;
  status: ApprovalStatus;
  requestedAt: Date;
  expiresAt: Date;
  decidedAt?: Date;
  usedAt?: Date;
}

export interface SessionMessageDocument {
  messageId?: string;
  role?: MessageRole;
  text: string;
  sentAt: Date;
  idempotencyKey?: string;
}

export interface SessionMessageReceiptDocument {
  idempotencyKey: string;
  messageId: string;
  text: string;
  sentAt: Date;
}

export function toSessionMessage(
  sessionId: string,
  document: SessionMessageDocument,
  index: number,
): SessionMessage {
  return SessionMessageSchema.parse({
    messageId: document.messageId ?? legacyMessageId(sessionId, document, index),
    role: document.role ?? 'user',
    text: document.text,
    sentAt: document.sentAt.toISOString(),
  });
}

function legacyMessageId(
  sessionId: string,
  document: SessionMessageDocument,
  index: number,
): string {
  const body = createHash('sha256')
    .update(sessionId)
    .update('\0')
    .update(String(index))
    .update('\0')
    .update(document.role ?? 'user')
    .update('\0')
    .update(document.text)
    .update('\0')
    .update(document.sentAt.toISOString())
    .digest('base64url')
    .slice(0, 21);
  return `${MESSAGE_ID_PREFIX}_${body}`;
}

export interface SessionToolEventDocument {
  toolCallId: string;
  tool: ToolName;
  outcome: ToolOutcome;
  summary: string;
  paths: string[];
  startedAt: Date;
  durationMs?: number;
}

export interface SessionPullRequestDocument {
  number: number;
  url: string;
  branch: string;
  headSha: string;
  createdAt: Date;
}

export interface SessionDocument {
  sessionId: string;
  userId: string;
  status: SessionStatus;
  /** Status of the most recently executed turn. Conversation records remain available. */
  runStatus?: RunStatus | null;
  deliveryStatus?: DeliveryStatus | null;
  manualPrStates?: Record<string, 'open' | 'merged' | 'closed'>;
  repository: SessionRepositoryDocument;
  branch: string | null;
  baseCommitSha: string | null;
  /** Optional only while documents created before session titles are still in Mongo. */
  title?: string;
  task: string;
  model: ModelSelection | null;
  clarificationQuestion: string | null;
  clarificationAnswer: string | null;
  waitingSince: Date | null;
  messages: SessionMessageDocument[];
  messageReceipts?: SessionMessageReceiptDocument[];
  attachments: SessionAttachmentDocument[];
  idempotencyKey: string;
  checkpointId: string | null;
  sandboxId: string | null;
  step: number;
  maxSteps: number;
  currentActivity: string | null;
  retryCount: number;
  filesRead: string[];
  filesChanged: FileChange[];
  checks: CheckResult[];
  approvals: SessionApprovalDocument[];
  toolEvents: SessionToolEventDocument[];
  pullRequest: SessionPullRequestDocument | null;
  failure: SessionFailure | null;
  lastEventSequence: number;
  createdAt: Date;
  updatedAt: Date;
  lastActivityAt: Date;
  completedAt: Date | null;
}

export function sessionsCollection(db: Db): Collection<SessionDocument> {
  return db.collection<SessionDocument>(COLLECTIONS.sessions);
}

export function isActiveSessionStatus(status: SessionStatus): boolean {
  return ACTIVE_SESSION_STATUSES.includes(status);
}

export function toRepositorySummary(document: SessionRepositoryDocument): RepositorySummary {
  return RepositorySummarySchema.parse({
    repositoryId: document.repositoryId,
    owner: document.owner,
    name: document.name,
    defaultBranch: document.defaultBranch,
    visibility: document.visibility,
    htmlUrl: document.htmlUrl,
    updatedAt: toIsoTimestamp(document.updatedAt),
  });
}

export function toPullRequestResult(document: SessionPullRequestDocument): PullRequestResult {
  return PullRequestResultSchema.parse({
    number: document.number,
    url: document.url,
    branch: document.branch,
    headSha: document.headSha,
    createdAt: toIsoTimestamp(document.createdAt),
  });
}

export function toAttachmentMetadata(document: SessionAttachmentDocument): AttachmentMetadata {
  return AttachmentMetadataSchema.parse({
    attachmentId: document.attachmentId,
    kind: document.kind,
    mimeType: document.mimeType,
    byteSize: document.byteSize,
    originalName: document.originalName,
    createdAt: toIsoTimestamp(document.createdAt),
  });
}

export function toApprovalRecord(document: SessionApprovalDocument): ApprovalRecord {
  return ApprovalRecordSchema.parse({
    approvalId: document.approvalId,
    actionHash: document.actionHash,
    effect: document.effect,
    status: document.status,
    requestedAt: toIsoTimestamp(document.requestedAt),
    expiresAt: toIsoTimestamp(document.expiresAt),
    ...(document.decidedAt === undefined ? {} : { decidedAt: toIsoTimestamp(document.decidedAt) }),
  });
}

export function toSessionSummary(document: SessionDocument): SessionSummary {
  return SessionSummarySchema.parse({
    sessionId: document.sessionId,
    status: document.status,
    runStatus: document.runStatus ?? null,
    deliveryStatus: document.deliveryStatus ?? null,
    manualPrStates: document.manualPrStates ?? {},
    title: document.title ?? document.task,
    task: document.task,
    repository: toRepositorySummary(document.repository),
    branch: document.branch,
    pullRequest: document.pullRequest === null ? null : toPullRequestResult(document.pullRequest),
    createdAt: toIsoTimestamp(document.createdAt),
    lastActivityAt: toIsoTimestamp(document.lastActivityAt),
    completedAt: toIsoTimestampOrNull(document.completedAt),
  });
}

export function toSessionDetail(document: SessionDocument): SessionDetail {
  return SessionDetailSchema.parse({
    ...toSessionSummary(document),
    model: document.model ?? null,
    baseCommitSha: document.baseCommitSha,
    attachments: document.attachments.map(toAttachmentMetadata),
    messages: document.messages.map((message, index) =>
      toSessionMessage(document.sessionId, message, index),
    ),
    progress: {
      step: document.step,
      maxSteps: document.maxSteps,
      currentActivity: document.currentActivity,
    },
    filesChanged: document.filesChanged,
    checks: document.checks,
    approvals: document.approvals.map(toApprovalRecord),
    failure: document.failure,
  });
}

const approvalEffectSchema = {
  bsonType: 'object',
  additionalProperties: false,
  required: ['category', 'summary', 'paths', 'reason', 'risk'],
  properties: {
    category: { enum: [...ApprovalCategorySchema.options] },
    summary: { bsonType: 'string', minLength: 1, maxLength: LIMITS.summaryMaxChars },
    paths: {
      bsonType: 'array',
      maxItems: LIMITS.approvalPathsMax,
      items: { bsonType: 'string', maxLength: LIMITS.pathMaxChars },
    },
    commandCategory: { bsonType: 'string', minLength: 1, maxLength: 120 },
    reason: { bsonType: 'string', minLength: 1, maxLength: LIMITS.reasonMaxChars },
    risk: { enum: [...RiskLevelSchema.options] },
  },
} as const;

export const sessionModel: ModelDefinition = {
  name: COLLECTIONS.sessions,
  validator: {
    $jsonSchema: {
      bsonType: 'object',
      additionalProperties: false,
      required: [
        'sessionId',
        'userId',
        'status',
        'repository',
        'branch',
        'baseCommitSha',
        'task',
        'clarificationQuestion',
        'clarificationAnswer',
        'messages',
        'attachments',
        'idempotencyKey',
        'checkpointId',
        'sandboxId',
        'step',
        'maxSteps',
        'currentActivity',
        'retryCount',
        'filesRead',
        'filesChanged',
        'checks',
        'approvals',
        'toolEvents',
        'pullRequest',
        'failure',
        'lastEventSequence',
        'createdAt',
        'updatedAt',
        'lastActivityAt',
        'completedAt',
      ],
      properties: {
        _id: OBJECT_ID_PROPERTY,
        sessionId: { bsonType: 'string', pattern: publicIdPattern(SESSION_ID_PREFIX) },
        userId: { bsonType: 'string', pattern: publicIdPattern('usr') },
        status: { enum: [...SESSION_STATUSES] },
        runStatus: { bsonType: ['string', 'null'], enum: [...RunStatusSchema.options, null] },
        deliveryStatus: {
          bsonType: ['string', 'null'],
          enum: [...DeliveryStatusSchema.options, null],
        },
        manualPrStates: {
          bsonType: 'object',
          additionalProperties: { enum: ['open', 'merged', 'closed'] },
        },
        title: { bsonType: 'string', minLength: 1, maxLength: 120 },
        repository: {
          bsonType: 'object',
          additionalProperties: false,
          required: [
            'repositoryId',
            'owner',
            'name',
            'defaultBranch',
            'visibility',
            'htmlUrl',
            'updatedAt',
          ],
          properties: {
            repositoryId: { bsonType: 'number', minimum: 1 },
            owner: { bsonType: 'string', minLength: 1, maxLength: LIMITS.ownerNameMaxChars },
            name: { bsonType: 'string', minLength: 1, maxLength: LIMITS.repositoryNameMaxChars },
            defaultBranch: {
              bsonType: 'string',
              minLength: 1,
              maxLength: LIMITS.branchNameMaxChars,
            },
            visibility: { enum: ['public'] },
            htmlUrl: { bsonType: 'string', maxLength: 2048 },
            updatedAt: { bsonType: 'date' },
          },
        },
        branch: {
          bsonType: ['string', 'null'],
          maxLength: LIMITS.branchNameMaxChars,
        },
        baseCommitSha: { bsonType: ['string', 'null'], pattern: COMMIT_SHA_PATTERN },
        task: {
          bsonType: 'string',
          minLength: LIMITS.taskMinChars,
          maxLength: LIMITS.taskMaxChars,
        },
        model: {
          bsonType: ['object', 'null'],
          additionalProperties: false,
          required: ['textModel'],
          properties: {
            textModel: { bsonType: 'string', minLength: 1, maxLength: 120 },
          },
        },
        clarificationQuestion: {
          bsonType: ['string', 'null'],
          maxLength: LIMITS.messageMaxChars,
        },
        clarificationAnswer: {
          bsonType: ['string', 'null'],
          maxLength: LIMITS.clarificationAnswerMaxChars,
        },
        waitingSince: { bsonType: ['date', 'null'] },
        messages: {
          bsonType: 'array',
          maxItems: MAX_SESSION_MESSAGES,
          items: {
            bsonType: 'object',
            additionalProperties: false,
            required: ['text', 'sentAt'],
            properties: {
              messageId: { bsonType: 'string', pattern: publicIdPattern('msg') },
              role: { enum: [...MESSAGE_ROLES] },
              text: { bsonType: 'string', minLength: 1, maxLength: LIMITS.messageMaxChars },
              sentAt: { bsonType: 'date' },
              idempotencyKey: { bsonType: 'string', pattern: publicIdPattern('idk') },
            },
          },
        },
        messageReceipts: {
          bsonType: 'array',
          maxItems: MAX_SESSION_MESSAGES,
          items: {
            bsonType: 'object',
            additionalProperties: false,
            required: ['idempotencyKey', 'messageId', 'text', 'sentAt'],
            properties: {
              idempotencyKey: { bsonType: 'string', pattern: publicIdPattern('idk') },
              messageId: { bsonType: 'string', pattern: publicIdPattern('msg') },
              text: { bsonType: 'string', minLength: 1, maxLength: LIMITS.messageMaxChars },
              sentAt: { bsonType: 'date' },
            },
          },
        },
        attachments: {
          bsonType: 'array',
          maxItems: LIMITS.maxAttachmentsPerSession,
          items: {
            bsonType: 'object',
            additionalProperties: false,
            required: ['attachmentId', 'kind', 'mimeType', 'byteSize', 'originalName', 'createdAt'],
            properties: {
              attachmentId: { bsonType: 'string', pattern: publicIdPattern('att') },
              kind: { enum: [...AttachmentKindSchema.options] },
              mimeType: { enum: [...AttachmentMimeTypeSchema.options] },
              byteSize: { bsonType: 'number', minimum: 1, maximum: LIMITS.maxAttachmentBytes },
              originalName: { bsonType: 'string', minLength: 1, maxLength: 255 },
              createdAt: { bsonType: 'date' },
            },
          },
        },
        idempotencyKey: { bsonType: 'string', pattern: publicIdPattern('idk') },
        checkpointId: { bsonType: ['string', 'null'], maxLength: 200 },
        sandboxId: { bsonType: ['string', 'null'], maxLength: 200 },
        step: { bsonType: 'number', minimum: 0 },
        maxSteps: { bsonType: 'number', minimum: 1 },
        currentActivity: { bsonType: ['string', 'null'], maxLength: LIMITS.summaryMaxChars },
        retryCount: { bsonType: 'number', minimum: 0 },
        filesRead: {
          bsonType: 'array',
          maxItems: LIMITS.maxFilesListed,
          items: { bsonType: 'string', maxLength: LIMITS.pathMaxChars },
        },
        filesChanged: {
          bsonType: 'array',
          maxItems: LIMITS.maxChangedFiles,
          items: {
            bsonType: 'object',
            additionalProperties: false,
            required: ['path', 'changeKind', 'addedLines', 'removedLines', 'diff', 'diffTruncated'],
            properties: {
              path: { bsonType: 'string', minLength: 1, maxLength: LIMITS.pathMaxChars },
              changeKind: { enum: [...FileChangeKindSchema.options] },
              previousPath: { bsonType: 'string', minLength: 1, maxLength: LIMITS.pathMaxChars },
              addedLines: { bsonType: 'number', minimum: 0 },
              removedLines: { bsonType: 'number', minimum: 0 },
              diff: { bsonType: 'string', maxLength: LIMITS.fileDiffMaxChars },
              diffTruncated: { bsonType: 'bool' },
            },
          },
        },
        checks: {
          bsonType: 'array',
          maxItems: LIMITS.maxChecksPerSession,
          items: {
            bsonType: 'object',
            additionalProperties: false,
            required: ['name', 'kind', 'status', 'summary'],
            properties: {
              name: { bsonType: 'string', minLength: 1, maxLength: 120 },
              kind: { enum: [...CheckKindSchema.options] },
              status: { enum: [...CheckStatusSchema.options] },
              summary: { bsonType: 'string', maxLength: LIMITS.summaryMaxChars },
              durationMs: { bsonType: 'number', minimum: 0 },
            },
          },
        },
        approvals: {
          bsonType: 'array',
          maxItems: 50,
          items: {
            bsonType: 'object',
            additionalProperties: false,
            required: ['approvalId', 'actionHash', 'effect', 'status', 'requestedAt', 'expiresAt'],
            properties: {
              approvalId: { bsonType: 'string', pattern: publicIdPattern('apr') },
              actionHash: { bsonType: 'string', pattern: ACTION_HASH_PATTERN },
              effect: approvalEffectSchema,
              status: { enum: [...ApprovalStatusSchema.options] },
              requestedAt: { bsonType: 'date' },
              expiresAt: { bsonType: 'date' },
              decidedAt: { bsonType: 'date' },
              usedAt: { bsonType: 'date' },
            },
          },
        },
        toolEvents: {
          bsonType: 'array',
          items: {
            bsonType: 'object',
            additionalProperties: false,
            required: ['toolCallId', 'tool', 'outcome', 'summary', 'paths', 'startedAt'],
            properties: {
              toolCallId: { bsonType: 'string', minLength: 1, maxLength: 64 },
              tool: { enum: [...ToolNameSchema.options] },
              outcome: { enum: [...ToolOutcomeSchema.options] },
              summary: { bsonType: 'string', minLength: 1, maxLength: LIMITS.summaryMaxChars },
              paths: {
                bsonType: 'array',
                maxItems: LIMITS.maxFilesListed,
                items: { bsonType: 'string', maxLength: LIMITS.pathMaxChars },
              },
              startedAt: { bsonType: 'date' },
              durationMs: { bsonType: 'number', minimum: 0 },
            },
          },
        },
        pullRequest: {
          bsonType: ['object', 'null'],
          additionalProperties: false,
          required: ['number', 'url', 'branch', 'headSha', 'createdAt'],
          properties: {
            number: { bsonType: 'number', minimum: 1 },
            url: { bsonType: 'string', maxLength: 2048 },
            branch: { bsonType: 'string', minLength: 1, maxLength: LIMITS.branchNameMaxChars },
            headSha: { bsonType: 'string', pattern: COMMIT_SHA_PATTERN },
            createdAt: { bsonType: 'date' },
          },
        },
        failure: {
          bsonType: ['object', 'null'],
          additionalProperties: false,
          required: ['code', 'message'],
          properties: {
            code: { enum: [...FailureCodeSchema.options] },
            message: { bsonType: 'string', minLength: 1, maxLength: LIMITS.errorMessageMaxChars },
          },
        },
        lastEventSequence: { bsonType: 'number', minimum: 0 },
        createdAt: { bsonType: 'date' },
        updatedAt: { bsonType: 'date' },
        lastActivityAt: { bsonType: 'date' },
        completedAt: { bsonType: ['date', 'null'] },
      },
    },
  },
  indexes: [
    { key: { sessionId: 1 }, name: 'session_id_unique', unique: true },
    {
      key: { userId: 1 },
      name: 'session_one_active_per_user',
      unique: true,
      partialFilterExpression: { status: { $in: [...ACTIVE_SESSION_STATUSES] } },
    },
    {
      key: { userId: 1, idempotencyKey: 1 },
      name: 'session_idempotency_unique',
      unique: true,
    },
    { key: { status: 1, waitingSince: 1 }, name: 'session_waiting' },
    { key: { userId: 1, createdAt: -1 }, name: 'session_user_recent' },
    { key: { 'repository.repositoryId': 1, createdAt: -1 }, name: 'session_repository_recent' },
  ],
};
