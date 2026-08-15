import type {
  FileChange,
  PatchValidationReport,
  PullRequestResult,
  PushResult,
} from '@nimbus/contracts';

import { runAgent } from '../agent/graph/run.js';
import type { SessionDocument } from '../db/models/session.js';
import type { Logger } from '../logging/logger.js';
import type { PullRequestGateway } from '../pull-request/gateway.js';
import type { PushGateway } from '../push/gateway.js';
import type { RunOutcome } from '../sessions/repository.js';
import { failureOf, failureForStop, isPaused } from './outcome.js';
import { WorkshopError, type SessionWorkshop } from './workshop.js';

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
}

export class SessionRunner {
  readonly #workshop: SessionWorkshop;

  readonly #push: PushGateway;

  readonly #pullRequests: PullRequestGateway;

  readonly #logger: Logger;

  readonly #notifyEmailFor: (session: SessionDocument) => Promise<string>;

  constructor(options: SessionRunnerOptions) {
    this.#workshop = options.workshop;
    this.#push = options.push;
    this.#pullRequests = options.pullRequests;
    this.#logger = options.logger;
    this.#notifyEmailFor = options.notifyEmailFor;
  }

  async run(session: SessionDocument, signal: AbortSignal): Promise<RunOutcome> {
    let prepared;

    try {
      prepared = await this.#workshop.prepare(session, { signal });
    } catch (error) {
      return this.#couldNotStart(session, error);
    }

    try {
      const result = await runAgent(prepared.input);
      const progress = {
        step: result.state.budgets.steps,
        filesChanged: changedFiles(result.report),
        checks: [...result.state.checks],
        sandboxId: result.state.sandboxId,
        baseCommitSha: result.state.baseCommitSha,
      };

      if (signal.aborted) {
        return { status: 'cancelled', currentActivity: null, ...progress };
      }

      if (isPaused(result.state)) {
        return { status: 'awaiting_user', currentActivity: null, ...progress };
      }

      if (result.patch === null || result.report === null) {
        return {
          status: 'failed',
          failure: failureForStop(result.state.stopReason),
          currentActivity: null,
          ...progress,
        };
      }

      if (result.report.decision !== 'allowed') {
        return {
          status: 'failed',
          failure: failureOf('PATCH_REJECTED'),
          currentActivity: null,
          ...progress,
        };
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
