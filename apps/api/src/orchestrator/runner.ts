import type {
  FileChange,
  PatchValidationReport,
  PullRequestResult,
  PushResult,
  ServerEvent,
  ToolEventSummary,
  ToolName,
  ToolOutcome,
} from '@nimbus/contracts';

import { runAgent } from '../agent/graph/run.js';
import type { EventPublisher } from '../events/publisher.js';
import type { SessionDocument } from '../db/models/session.js';
import type { Logger } from '../logging/logger.js';
import type { PullRequestGateway } from '../pull-request/gateway.js';
import type { PushGateway } from '../push/gateway.js';
import type { RunOutcome } from '../sessions/repository.js';
import { failureOf, failureForStop, isPaused } from './outcome.js';
import { WorkshopError, type SessionWorkshop } from './workshop.js';

export const PAUSE_EXPIRY_MS = 24 * 60 * 60 * 1_000;

export const REPORTED_OUTCOME: Readonly<Record<ToolEventSummary['outcome'], ToolOutcome>> = {
  ok: 'succeeded',
  failed: 'failed',
  refused: 'denied',
  paused: 'denied',
};

export function changedFiles(report: PatchValidationReport | null): FileChange[] {
  if (report === null) {
    return [];
  }

  return report.files.map((file) => ({
    path: file.path,
    changeKind: file.changeKind,
    addedLines: file.addedLines,
    removedLines: file.removedLines,
    ...(file.previousPath === undefined ? {} : { previousPath: file.previousPath }),
  }));
}

export interface SessionRunnerOptions {
  workshop: SessionWorkshop;
  push: PushGateway;
  pullRequests: PullRequestGateway;
  logger: Logger;
  notifyEmailFor: (session: SessionDocument) => Promise<string>;
  events?: EventPublisher;
}

export class SessionRunner {
  readonly #workshop: SessionWorkshop;

  readonly #push: PushGateway;

  readonly #pullRequests: PullRequestGateway;

  readonly #logger: Logger;

  readonly #notifyEmailFor: (session: SessionDocument) => Promise<string>;

  readonly #events: EventPublisher | null;

  constructor(options: SessionRunnerOptions) {
    this.#workshop = options.workshop;
    this.#push = options.push;
    this.#pullRequests = options.pullRequests;
    this.#logger = options.logger;
    this.#notifyEmailFor = options.notifyEmailFor;
    this.#events = options.events ?? null;
  }

  async run(session: SessionDocument, signal: AbortSignal): Promise<RunOutcome> {
    let prepared;

    await this.#say(session, {
      type: 'session.status',
      status: 'provisioning',
      progress: { step: 0, maxSteps: session.maxSteps, currentActivity: 'starting a machine' },
    });

    try {
      prepared = await this.#workshop.prepare(session, { signal });
    } catch (error) {
      const failed = this.#couldNotStart(session, error);
      await this.#sayFailed(session, failed);
      return failed;
    }

    try {
      await this.#say(session, {
        type: 'session.status',
        status: 'working',
        progress: { step: 0, maxSteps: session.maxSteps, currentActivity: 'reading the code' },
      });

      const result = await runAgent(prepared.input);
      const progress = {
        step: result.state.budgets.steps,
        filesChanged: changedFiles(result.report),
        checks: [...result.state.checks],
        sandboxId: result.state.sandboxId,
        baseCommitSha: result.state.baseCommitSha,
      };

      await this.#sayProgress(session, result, progress);

      if (signal.aborted) {
        await this.#say(session, {
          type: 'session.cancelled',
          cancelledAt: new Date().toISOString(),
        });
        return { status: 'cancelled', currentActivity: null, ...progress };
      }

      if (isPaused(result.state)) {
        await this.#sayPaused(session, result);
        return { status: 'awaiting_user', currentActivity: null, ...progress };
      }

      if (result.patch === null || result.report === null) {
        const failed = {
          status: 'failed' as const,
          failure: failureForStop(result.state.stopReason),
          currentActivity: null,
          ...progress,
        };

        await this.#sayFailed(session, failed);
        return failed;
      }

      if (result.report.decision !== 'allowed') {
        const failed = {
          status: 'failed' as const,
          failure: failureOf('PATCH_REJECTED'),
          currentActivity: null,
          ...progress,
        };

        await this.#sayFailed(session, failed);
        return failed;
      }

      return await this.#deliver(session, prepared.installationId, result, progress);
    } finally {
      await prepared.finish();
    }
  }

  async #deliver(
    session: SessionDocument,
    installationId: number,
    result: Awaited<ReturnType<typeof runAgent>>,
    progress: Omit<RunOutcome, 'status'>,
  ): Promise<RunOutcome> {
    const patch = result.patch;
    const report = result.report;

    if (patch === null || report === null) {
      return { status: 'failed', failure: failureOf('INTERNAL_ERROR'), ...progress };
    }

    const baseCommitSha = result.state.baseCommitSha;
    let pushed: PushResult;

    try {
      pushed = await this.#push.push({
        installationId,
        repositoryId: session.repository.repositoryId,
        owner: session.repository.owner,
        name: session.repository.name,
        sessionId: session.sessionId,
        task: session.task,
        baseCommitSha,
        patch: patch.patch,
        report,
      });
    } catch (error) {
      this.#logger.error(
        { sessionId: session.sessionId, error: String(error) },
        'a branch could not be pushed',
      );
      return { status: 'failed', failure: failureOf('PUSH_FAILED'), ...progress };
    }

    let opened: PullRequestResult;

    try {
      opened = await this.#pullRequests.open({
        installationId,
        repositoryId: session.repository.repositoryId,
        owner: session.repository.owner,
        name: session.repository.name,
        defaultBranch: session.repository.defaultBranch,
        branch: pushed.branch,
        baseCommitSha,
        task: session.task,
        summary: patch.summary,
        report,
        checks: result.state.checks,
        notifyEmail: await this.#notifyEmailFor(session),
      });
    } catch (error) {
      this.#logger.error(
        { sessionId: session.sessionId, branch: pushed.branch, error: String(error) },
        'a pull request could not be opened',
      );
      return {
        status: 'failed',
        failure: failureOf('PULL_REQUEST_FAILED'),
        branch: pushed.branch,
        ...progress,
      };
    }

    this.#logger.info(
      { sessionId: session.sessionId, branch: pushed.branch, pullRequest: opened.number },
      'a session finished with a pull request',
    );

    await this.#say(session, { type: 'pr.created', pullRequest: opened });

    return {
      status: 'pr_created',
      branch: pushed.branch,
      pullRequest: {
        number: opened.number,
        url: opened.url,
        branch: opened.branch,
        headSha: opened.headSha,
        createdAt: new Date(opened.createdAt),
      },
      ...progress,
    };
  }

  async #say(session: SessionDocument, event: ServerEvent): Promise<void> {
    if (this.#events === null) {
      return;
    }

    try {
      await this.#events.publish(session.sessionId, session.userId, event);
    } catch (error) {
      this.#logger.warn(
        { sessionId: session.sessionId, type: event.type, error: String(error) },
        'an event could not be published, the run carries on without it',
      );
    }
  }

  async #sayProgress(
    session: SessionDocument,
    result: Awaited<ReturnType<typeof runAgent>>,
    progress: Omit<RunOutcome, 'status'>,
  ): Promise<void> {
    for (const event of result.state.toolEvents) {
      await this.#say(session, {
        type: 'tool.completed',
        toolCallId: `call_${String(event.step)}`,
        tool: event.tool as ToolName,
        outcome: REPORTED_OUTCOME[event.outcome],
        durationMs: 0,
        summary: event.summary,
      });
    }

    if ((progress.filesChanged ?? []).length > 0) {
      await this.#say(session, { type: 'files.changed', files: progress.filesChanged ?? [] });
    }

    if ((progress.checks ?? []).length > 0) {
      await this.#say(session, { type: 'checks.updated', checks: progress.checks ?? [] });
    }
  }

  async #sayPaused(
    session: SessionDocument,
    result: Awaited<ReturnType<typeof runAgent>>,
  ): Promise<void> {
    const question = result.state.clarificationQuestion;

    if (question !== null) {
      await this.#say(session, {
        type: 'agent.question',
        question,
        expiresAt: new Date(Date.now() + PAUSE_EXPIRY_MS).toISOString(),
      });
      return;
    }

    await this.#say(session, {
      type: 'session.status',
      status: 'awaiting_user',
      progress: {
        step: result.state.budgets.steps,
        maxSteps: session.maxSteps,
        currentActivity: 'waiting for a person to approve something',
      },
    });
  }

  async #sayFailed(session: SessionDocument, outcome: RunOutcome): Promise<void> {
    if (outcome.failure === undefined || outcome.failure === null) {
      return;
    }
    await this.#say(session, { type: 'session.failed', failure: outcome.failure });
  }

  #couldNotStart(session: SessionDocument, error: unknown): RunOutcome {
    const reason = error instanceof WorkshopError ? error.reason : 'sandbox';

    this.#logger.error(
      { sessionId: session.sessionId, reason, error: String(error) },
      'a session could not be started',
    );

    if (reason === 'no_installation') {
      return { status: 'failed', failure: failureOf('PROVIDER_UNAVAILABLE') };
    }

    if (reason === 'models') {
      return { status: 'failed', failure: failureOf('PROVIDER_UNAVAILABLE') };
    }
    return { status: 'failed', failure: failureOf('SANDBOX_FAILED') };
  }
}
