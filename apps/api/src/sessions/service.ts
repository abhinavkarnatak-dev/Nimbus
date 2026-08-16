import {
  ApprovalRecordSchema,
  LIMITS,
  SessionDetailResponseSchema,
  SessionListResponseSchema,
  type ApprovalDecisionBody,
  type ApprovalRecord,
  type CreateSessionBody,
  type ErrorCode,
  type ModelSelection,
  type RepositorySummary,
  type SessionDetailResponse,
  type SessionListResponse,
  type SessionSummary,
} from '@nimbus/contracts';

import { tooThinToJudge } from '../agent/nodes/scope.js';
import { ApprovalError, InMemoryApprovals, type ApprovalStore } from '../agent/policy/approvals.js';
import type { AttachmentRecords } from '../attachments/repository.js';
import { DEFAULT_LIMITS } from '../config/limits.js';
import type { EventPublisher } from '../events/publisher.js';
import type { CancelAnnouncer } from '../orchestrator/cancellation.js';
import {
  SESSION_ID_PREFIX,
  isActiveSessionStatus,
  toSessionDetail,
  toSessionSummary,
  type SessionDocument,
} from '../db/models/session.js';
import { ApiError } from '../http/api-error.js';
import { newPrefixedId } from '../lib/id.js';
import { LlmError } from '../llm/errors.js';
import type { Logger } from '../logging/logger.js';
import { assertSelectableModel } from '../routing/selection.js';
import type { SessionRecords } from './repository.js';

export const DEFAULT_MAX_STEPS = DEFAULT_LIMITS.maxAgentSteps;

export const REPOSITORY_NOT_AVAILABLE = 'We could not find that repository.';

export interface RepositoryDirectory {
  listRepositories(userId: string): Promise<{ repositories: RepositorySummary[] }>;
}

export interface AgentSessionServiceOptions {
  records: SessionRecords;
  attachments: AttachmentRecords;
  repositories: RepositoryDirectory;
  logger: Logger;
  approvalsFor?: (sessionId: string) => ApprovalStore;
  cancellations?: CancelAnnouncer;
  events?: EventPublisher;
  notifyCancelled?: (session: SessionDocument) => Promise<void>;
  maxSteps?: number;
  now?: () => Date;
}

export const APPROVAL_ERROR_TO_API: Readonly<Record<string, ErrorCode>> = {
  APPROVAL_NOT_FOUND: 'APPROVAL_NOT_FOUND',
  APPROVAL_EXPIRED: 'APPROVAL_EXPIRED',
  APPROVAL_MISMATCH: 'APPROVAL_MISMATCH',
  APPROVAL_REJECTED: 'APPROVAL_MISMATCH',
  APPROVAL_ALREADY_USED: 'APPROVAL_EXPIRED',
  APPROVAL_LIMIT_REACHED: 'CONFLICT',
};

export function chosenModel(selection: ModelSelection | undefined): ModelSelection | null {
  if (selection === undefined || selection.textModel.trim() === '') {
    return null;
  }

  try {
    return { textModel: assertSelectableModel(selection.textModel) };
  } catch (error) {
    throw new ApiError(
      'VALIDATION_FAILED',
      error instanceof LlmError ? error.message : 'That model cannot be chosen for a session.',
      { details: { field: 'model.textModel' } },
    );
  }
}

export function asApiError(error: unknown): ApiError {
  if (!(error instanceof ApprovalError)) {
    return error instanceof ApiError
      ? error
      : new ApiError('INTERNAL_ERROR', 'That approval could not be decided.');
  }

  return new ApiError(APPROVAL_ERROR_TO_API[error.code] ?? 'CONFLICT', error.message);
}

export interface CreatedSession {
  session: SessionSummary;
  created: boolean;
}

export class AgentSessionService {
  readonly #records: SessionRecords;

  readonly #attachments: AttachmentRecords;

  readonly #repositories: RepositoryDirectory;

  readonly #logger: Logger;

  readonly #maxSteps: number;

  readonly #approvalsFor: (sessionId: string) => ApprovalStore;

  readonly #cancellations: CancelAnnouncer | null;

  readonly #events: EventPublisher | null;

  readonly #notifyCancelled: ((session: SessionDocument) => Promise<void>) | null;

  readonly #now: () => Date;

  constructor(options: AgentSessionServiceOptions) {
    this.#records = options.records;
    this.#attachments = options.attachments;
    this.#repositories = options.repositories;
    this.#logger = options.logger;
    this.#maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
    this.#approvalsFor = options.approvalsFor ?? ((): ApprovalStore => new InMemoryApprovals());
    this.#cancellations = options.cancellations ?? null;
    this.#events = options.events ?? null;
    this.#notifyCancelled = options.notifyCancelled ?? null;
    this.#now = options.now ?? ((): Date => new Date());
  }

  async create(userId: string, body: CreateSessionBody): Promise<CreatedSession> {
    const repository = await this.#repositoryFor(userId, body.repositoryId);

    const thin = tooThinToJudge(body.task);

    if (thin !== null) {
      throw new ApiError(
        'TASK_TOO_BROAD',
        'Describe what you would like changed, and roughly where in the repository it lives.',
      );
    }

    const model = chosenModel(body.model);
    const attachments = await this.#attachmentsFor(userId, body.attachmentIds);
    const at = this.#now();
    const document = this.#newDocument({ userId, body, repository, attachments, model, at });

    const outcome = await this.#records.insert(document);

    if (outcome === 'created') {
      await this.#claim(document);

      this.#logger.info(
        {
          sessionId: document.sessionId,
          repositoryId: repository.repositoryId,
          attachments: document.attachments.length,
        },
        'a session was created',
      );
      return { session: toSessionSummary(document), created: true };
    }

    if (outcome === 'same_request') {
      return { session: await this.#sameRequest(userId, body.idempotencyKey), created: false };
    }
    throw await this.#activeAlready(userId);
  }

  async list(userId: string): Promise<SessionListResponse> {
    const documents = await this.#records.listRecent(userId, LIMITS.sessionHistoryPageSize);
    const active = documents.find((one) => isActiveSessionStatus(one.status));

    return SessionListResponseSchema.parse({
      sessions: documents.map(toSessionSummary),
      activeSessionId: active?.sessionId ?? null,
    });
  }

  async detail(userId: string, sessionId: string): Promise<SessionDetailResponse> {
    const document = await this.#owned(userId, sessionId);

    return SessionDetailResponseSchema.parse({
      session: toSessionDetail(document),
      lastEventSequence: document.lastEventSequence,
    });
  }

  async cancel(userId: string, sessionId: string): Promise<SessionSummary> {
    const document = await this.#owned(userId, sessionId);
    const at = this.#now();
    const stopped = await this.#records.finish(userId, sessionId, 'cancelled', at);

    if (stopped === null) {
      throw new ApiError('SESSION_NOT_ACTIVE', `That session has already ${ended(document)}.`);
    }

    this.#logger.info({ sessionId, was: document.status }, 'a session was cancelled');
    await this.#announceCancelled(stopped, at);
    return toSessionSummary(stopped);
  }

  async #announceCancelled(session: SessionDocument, at: Date): Promise<void> {
    await this.#safely(session, 'tell the worker', async () => {
      await this.#cancellations?.announce(session.sessionId, at);
    });

    await this.#safely(session, 'record the event', async () => {
      await this.#events?.publish(session.sessionId, session.userId, {
        type: 'session.cancelled',
        cancelledAt: at.toISOString(),
      });
    });

    await this.#safely(session, 'send the email', async () => {
      await this.#notifyCancelled?.(session);
    });
  }

  async #safely(session: SessionDocument, what: string, work: () => Promise<void>): Promise<void> {
    try {
      await work();
    } catch (error) {
      this.#logger.warn(
        { sessionId: session.sessionId, what, error: String(error) },
        'a cancellation was recorded but one thing that follows it did not happen',
      );
    }
  }

  async answer(userId: string, sessionId: string, text: string): Promise<SessionSummary> {
    const document = await this.#owned(userId, sessionId);

    if (document.clarificationQuestion === null) {
      throw new ApiError('SESSION_NOT_ACTIVE', 'That session has not asked you anything.');
    }

    const written = await this.#records.answerOnce(userId, sessionId, text, this.#now());

    if (!written) {
      throw new ApiError(
        'CONFLICT',
        document.clarificationAnswer === null
          ? 'That session is no longer waiting for an answer.'
          : 'That question has already been answered.',
      );
    }

    this.#logger.info({ sessionId }, 'a question was answered');
    return toSessionSummary(await this.#owned(userId, sessionId));
  }

  async say(userId: string, sessionId: string, text: string): Promise<SessionSummary> {
    await this.#owned(userId, sessionId);
    const written = await this.#records.addMessage(userId, sessionId, text, this.#now());

    if (!written) {
      throw new ApiError('SESSION_NOT_ACTIVE', 'That session has already finished.');
    }

    return toSessionSummary(await this.#owned(userId, sessionId));
  }

  async decide(
    userId: string,
    sessionId: string,
    body: ApprovalDecisionBody,
  ): Promise<ApprovalRecord> {
    const document = await this.#owned(userId, sessionId);

    if (!isActiveSessionStatus(document.status)) {
      throw new ApiError('SESSION_NOT_ACTIVE', 'That session has already finished.');
    }

    const approvals = this.#approvalsFor(sessionId);

    try {
      const decided = await approvals.decide(
        body.approvalId,
        body.actionHash,
        body.decision === 'approved',
      );

      this.#logger.info(
        { sessionId, approvalId: body.approvalId, decision: body.decision },
        'an approval was decided by a person',
      );

      return ApprovalRecordSchema.parse({
        approvalId: decided.approvalId,
        actionHash: decided.actionHash,
        effect: decided.effect,
        status: decided.status,
        requestedAt: decided.requestedAt,
        expiresAt: decided.expiresAt,
        ...(decided.decidedAt === undefined ? {} : { decidedAt: decided.decidedAt }),
      });
    } catch (error) {
      throw asApiError(error);
    }
  }

  async #owned(userId: string, sessionId: string): Promise<SessionDocument> {
    const document = await this.#records.findOwned(userId, sessionId);

    if (document === null) {
      throw new ApiError('NOT_FOUND', 'We could not find that session.');
    }
    return document;
  }

  async #repositoryFor(userId: string, repositoryId: number): Promise<RepositorySummary> {
    const { repositories } = await this.#repositories.listRepositories(userId);
    const found = repositories.find((one) => one.repositoryId === repositoryId);

    if (found === undefined) {
      throw new ApiError('REPOSITORY_NOT_AVAILABLE', REPOSITORY_NOT_AVAILABLE);
    }
    return found;
  }

  async #attachmentsFor(
    userId: string,
    attachmentIds: readonly string[],
  ): Promise<SessionDocument['attachments']> {
    const claimed: SessionDocument['attachments'] = [];

    for (const attachmentId of attachmentIds) {
      const document = await this.#attachments.findOwned(userId, attachmentId);

      if (document === null) {
        throw new ApiError('ATTACHMENT_REJECTED', 'We could not find one of those attachments.');
      }

      if (document.sessionId !== null) {
        throw new ApiError(
          'ATTACHMENT_REJECTED',
          'One of those attachments is already part of another session.',
        );
      }

      claimed.push({
        attachmentId: document.attachmentId,
        kind: document.kind,
        mimeType: document.mimeType,
        byteSize: document.byteSize,
        originalName: document.originalName,
        createdAt: document.createdAt,
      });
    }
    return claimed;
  }

  async #claim(document: SessionDocument): Promise<void> {
    for (const attachment of document.attachments) {
      const taken = await this.#attachments.claim(attachment.attachmentId, document.sessionId);

      if (!taken) {
        this.#logger.warn(
          { sessionId: document.sessionId, attachmentId: attachment.attachmentId },
          'an attachment was claimed by something else first',
        );
      }
    }
  }

  async #sameRequest(userId: string, idempotencyKey: string): Promise<SessionSummary> {
    const existing = await this.#records.findByIdempotencyKey(userId, idempotencyKey);

    if (existing === null) {
      throw new ApiError('CONFLICT', 'That session could not be started. Please try again.');
    }
    return toSessionSummary(existing);
  }

  async #activeAlready(userId: string): Promise<ApiError> {
    const active = await this.#records.findActive(userId);

    return new ApiError(
      'ACTIVE_SESSION_EXISTS',
      'You already have a session running. Wait for it to finish or cancel it first.',
      active === null ? {} : { details: { activeSessionId: active.sessionId } },
    );
  }

  #newDocument(input: {
    userId: string;
    body: CreateSessionBody;
    repository: RepositorySummary;
    attachments: SessionDocument['attachments'];
    model: ModelSelection | null;
    at: Date;
  }): SessionDocument {
    return {
      sessionId: newPrefixedId(SESSION_ID_PREFIX),
      userId: input.userId,
      status: 'queued',
      repository: {
        repositoryId: input.repository.repositoryId,
        owner: input.repository.owner,
        name: input.repository.name,
        defaultBranch: input.repository.defaultBranch,
        visibility: 'public',
        htmlUrl: input.repository.htmlUrl,
        updatedAt: new Date(input.repository.updatedAt),
      },
      branch: null,
      baseCommitSha: null,
      task: input.body.task,
      model: input.model,
      clarificationQuestion: null,
      clarificationAnswer: null,
      waitingSince: null,
      messages: [],
      attachments: input.attachments,
      idempotencyKey: input.body.idempotencyKey,
      checkpointId: null,
      sandboxId: null,
      step: 0,
      maxSteps: this.#maxSteps,
      currentActivity: null,
      retryCount: 0,
      filesRead: [],
      filesChanged: [],
      checks: [],
      approvals: [],
      toolEvents: [],
      pullRequest: null,
      failure: null,
      lastEventSequence: 0,
      createdAt: input.at,
      updatedAt: input.at,
      lastActivityAt: input.at,
      completedAt: null,
    };
  }
}

function ended(document: SessionDocument): string {
  return document.status === 'cancelled' ? 'been cancelled' : 'finished';
}
