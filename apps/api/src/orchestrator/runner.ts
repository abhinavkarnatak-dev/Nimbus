import { ApprovalRequestSchema, SessionMessageSchema } from '@nimbus/contracts';
import type {
  ApprovalRequest,
  FileChange,
  PatchValidationReport,
  PullRequestResult,
  PushResult,
  ServerEvent,
} from '@nimbus/contracts';

import { describeFailure, runAgent } from '../agent/graph/run.js';
import type { EventPublisher } from '../events/publisher.js';
import type { SessionDocument } from '../db/models/session.js';
import type { Logger } from '../logging/logger.js';
import type { MailService } from '../email/mail-service.js';
import type { PullRequestGateway } from '../pull-request/gateway.js';
import type { PushGateway } from '../push/gateway.js';
import type { ApprovalStore } from '../agent/policy/approvals.js';
import type { RunOutcome, SessionRecords } from '../sessions/repository.js';
import { WAIT_LIMITS } from './limits.js';
import { ALWAYS_LIVE, type LivenessVerdict, type RunLiveness } from './liveness.js';
import { failureOf, failureForRun, isPaused } from './outcome.js';
import { WorkshopError, type SessionWorkshop } from './workshop.js';
import { newPrefixedId } from '../lib/id.js';

export const PAUSE_EXPIRY_MS = WAIT_LIMITS.clarificationMs;

export function changedFiles(report: PatchValidationReport | null): FileChange[] {
  if (report === null) {
    return [];
  }

  return report.files.map((file) => ({
    path: file.path,
    changeKind: file.changeKind,
    addedLines: file.addedLines,
    removedLines: file.removedLines,
    diff: file.diff,
    diffTruncated: file.diffTruncated,
    ...(file.previousPath === undefined ? {} : { previousPath: file.previousPath }),
  }));
}

export const CANCELLING_VERDICTS: readonly LivenessVerdict[] = ['aborted', 'cancelled'];

export function stopHere(
  verdict: LivenessVerdict,
  progress: Omit<RunOutcome, 'status'>,
): RunOutcome | null {
  if (!CANCELLING_VERDICTS.includes(verdict)) {
    return null;
  }

  return { status: 'cancelled', ...progress, currentActivity: null };
}

export interface SessionRunnerOptions {
  workshop: SessionWorkshop;
  push: PushGateway;
  pullRequests: PullRequestGateway;
  logger: Logger;
  notifyEmailFor: (session: SessionDocument) => Promise<string>;
  events?: EventPublisher;
  records?: SessionRecords;
  approvalsFor?: (sessionId: string) => ApprovalStore;
  mail?: MailService;
}

export class SessionRunner {
  readonly #workshop: SessionWorkshop;

  readonly #push: PushGateway;

  readonly #pullRequests: PullRequestGateway;

  readonly #logger: Logger;

  readonly #notifyEmailFor: (session: SessionDocument) => Promise<string>;

  readonly #events: EventPublisher | null;

  readonly #records: SessionRecords | null;

  readonly #approvalsFor: ((sessionId: string) => ApprovalStore) | null;

  readonly #mail: MailService | null;

  constructor(options: SessionRunnerOptions) {
    this.#workshop = options.workshop;
    this.#push = options.push;
    this.#pullRequests = options.pullRequests;
    this.#logger = options.logger;
    this.#notifyEmailFor = options.notifyEmailFor;
    this.#events = options.events ?? null;
    this.#records = options.records ?? null;
    this.#approvalsFor = options.approvalsFor ?? null;
    this.#mail = options.mail ?? null;
  }

  async run(
    session: SessionDocument,
    signal: AbortSignal,
    liveness: RunLiveness = ALWAYS_LIVE,
  ): Promise<RunOutcome | null> {
    let prepared;
    const startedAt = Date.now();
    const resuming =
      session.clarificationAnswer !== null ||
      session.step > 0 ||
      session.messages.filter((message) => message.role === 'user').length > 1;

    const stopped = await this.#verdict(signal, liveness, 'before starting');

    if (stopped !== 'live') {
      return stopHere(stopped, {});
    }

    if (!resuming) {
      await this.#say(session, {
        type: 'session.status',
        status: 'provisioning',
        progress: { step: 0, maxSteps: session.maxSteps, currentActivity: 'starting a machine' },
      });
      await this.#narrate(
        session,
        `I'm checking ${session.repository.owner}/${session.repository.name} and working out the safest way to handle this.`,
      );
    }

    try {
      prepared = await this.#workshop.prepare(session, { signal });
    } catch (error) {
      if (error instanceof WorkshopError && error.reason === 'stopped') {
        return { status: 'cancelled', currentActivity: null };
      }
      const failed = this.#couldNotStart(session, error);
      await this.#sayFailed(session, failed);
      return failed;
    }

    try {
      await this.#say(session, {
        type: 'session.status',
        status: 'working',
        progress: {
          step: session.step,
          maxSteps: session.maxSteps,
          currentActivity: resuming ? 'continuing from your answer' : 'reading the code',
        },
      });

      const result = await runAgent(prepared.input);
      const progress = {
        step: result.state.budgets.steps,
        filesChanged: changedFiles(result.report),
        checks: [...result.state.checks],
        sandboxId: result.state.sandboxId,
        baseCommitSha: result.state.baseCommitSha,
      };

      await this.#sayProgress(session, progress);

      const afterAgent = await this.#verdict(signal, liveness, 'after the agent finished');

      if (afterAgent !== 'live') {
        return stopHere(afterAgent, progress);
      }

      if (isPaused(result.state)) {
        await this.#sayPaused(session, result);
        return { status: 'awaiting_user', currentActivity: null, ...progress };
      }

      if (
        result.state.stopReason === 'completed' &&
        result.patch === null &&
        result.report === null
      ) {
        await this.#say(session, {
          type: 'session.status',
          status: 'completed',
          progress: {
            step: result.state.budgets.steps,
            maxSteps: result.state.budgets.maxSteps,
            currentActivity: null,
          },
        });
        return { status: 'completed', currentActivity: null, ...progress };
      }

      if (result.patch === null || result.report === null) {
        const thrown = result.threw === undefined ? null : describeFailure(result.threw);
        this.#logger.error(
          {
            sessionId: session.sessionId,
            resumeAttempt: session.retryCount,
            phase: result.state.phase,
            proposedTool: result.state.proposedAction?.tool ?? null,
            currentTool: result.state.toolEvents.at(-1)?.tool ?? null,
            stopReason: result.state.stopReason,
            exceptionCode: thrown?.code ?? null,
            exceptionDetail: thrown?.detail ?? null,
            baseCommitSha: result.state.baseCommitSha,
            branch: session.pullRequest?.branch ?? session.branch,
            changedPaths: result.state.filesChanged,
            checkGeneratedPaths: result.state.checks
              .filter((check) => check.summary.includes('removed generated output:'))
              .map((check) => check.summary),
          },
          'an agent run ended without a reviewable patch',
        );
        const failed = {
          status: 'failed' as const,
          failure:
            result.state.checks.some((check) => check.status === 'failed')
              ? failureOf('CHECKS_FAILED')
              : failureForRun(result.state.stopReason, result.threw),
          currentActivity: null,
          ...progress,
        };

        await this.#sayFailed(session, failed);
        return failed;
      }

      if (result.report.decision !== 'allowed') {
        this.#logger.warn(
          {
            sessionId: session.sessionId,
            resumeAttempt: session.retryCount,
            phase: result.state.phase,
            proposedTool: result.state.proposedAction?.tool ?? null,
            stopReason: result.state.stopReason,
            baseCommitSha: result.state.baseCommitSha,
            branch: session.pullRequest?.branch ?? session.branch,
            changedPaths: result.report.files.map((file) => file.path),
            patchFindings: result.report.findings.map((finding) => ({
              code: finding.code,
              detail: finding.detail,
              paths: finding.paths,
            })),
          },
          'a patch was rejected before it could be pushed',
        );
        const failed = {
          status: 'failed' as const,
          failure: failureOf('PATCH_REJECTED'),
          currentActivity: null,
          ...progress,
        };

        await this.#sayFailed(session, failed);
        return failed;
      }

      // This is a deterministic delivery gate. A model message and a successful
      // tool invocation never outweigh a failed check recorded after an edit.
      if (result.state.checks.some((check) => check.status === 'failed')) {
        const failed = {
          status: 'failed' as const,
          failure: failureOf('CHECKS_FAILED'),
          currentActivity: null,
          ...progress,
          deliveryStatus: 'checks_failed' as const,
        };
        await this.#sayFailed(session, failed);
        return failed;
      }

      return await this.#deliver(
        session,
        prepared.installationId,
        result,
        progress,
        liveness,
        signal,
        startedAt,
      );
    } finally {
      await prepared.finish();
    }
  }

  async #deliver(
    session: SessionDocument,
    installationId: number,
    result: Awaited<ReturnType<typeof runAgent>>,
    progress: Omit<RunOutcome, 'status'>,
    liveness: RunLiveness,
    signal: AbortSignal,
    startedAt: number,
  ): Promise<RunOutcome | null> {
    const patch = result.patch;
    const report = result.report;

    if (patch === null || report === null) {
      return { status: 'failed', failure: failureOf('INTERNAL_ERROR'), ...progress };
    }

    const baseCommitSha = result.state.baseCommitSha;

    const latestRequest =
      session.messages.filter((message) => message.role === 'user').at(-1)?.text ?? session.task;
    const beforePush = await this.#verdict(signal, liveness, 'before pushing a branch');

    if (beforePush !== 'live') {
      return stopHere(beforePush, progress);
    }

    let pushed: PushResult;

    try {
      pushed = await this.#push.push({
        installationId,
        repositoryId: session.repository.repositoryId,
        owner: session.repository.owner,
        name: session.repository.name,
        sessionId: session.sessionId,
        ...(session.pullRequest === null ? {} : { branch: session.pullRequest.branch }),
        task: latestRequest,
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

    const beforePullRequest = await this.#verdict(
      signal,
      liveness,
      'before opening a pull request',
    );

    if (beforePullRequest !== 'live') {
      this.#logger.warn(
        { sessionId: session.sessionId, branch: pushed.branch, verdict: beforePullRequest },
        'a branch was pushed and no pull request was opened, because the session stopped being live in between',
      );
      return stopHere(beforePullRequest, { branch: pushed.branch, ...progress });
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
        task: latestRequest,
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
    const changed = progress.filesChanged?.length ?? 0;
    const added = progress.filesChanged?.reduce((total, file) => total + file.addedLines, 0) ?? 0;
    const removed = progress.filesChanged?.reduce((total, file) => total + file.removedLines, 0) ?? 0;
    const checks = progress.checks?.filter((check) => check.status === 'passed').length ?? 0;
    const elapsedSeconds = Math.max(1, Math.round((Date.now() - startedAt) / 1_000));
    await this.#narrate(
      session,
      `Worked for ${String(elapsedSeconds)}s. PR #${String(opened.number)} was ${session.pullRequest === null ? 'created' : 'updated'} for "${latestRequest}". ${String(changed)} ${changed === 1 ? 'file was' : 'files were'} changed, +${String(added)} −${String(removed)} lines, and ${String(checks)} ${checks === 1 ? 'check passed' : 'checks passed'}. You can continue working in this session.`,
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
      baseCommitSha: pushed.commitSha,
      deliveryStatus: session.pullRequest === null ? 'pr_created' : 'pr_updated',
    };
  }

  async #verdict(
    signal: AbortSignal,
    liveness: RunLiveness,
    where: string,
  ): Promise<LivenessVerdict> {
    if (signal.aborted) {
      this.#logger.warn(
        { where },
        'a run stopped short of an external write because it was aborted',
      );
      return 'aborted';
    }

    return await liveness(where);
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

  async #narrate(session: SessionDocument, text: string): Promise<void> {
    const sentAt = new Date().toISOString();
    const message = SessionMessageSchema.parse({
      messageId: newPrefixedId('msg'),
      role: 'agent',
      text,
      sentAt,
    });

    await this.#records?.addAgentMessage(
      session.sessionId,
      text,
      new Date(sentAt),
      message.messageId,
    );
    await this.#say(session, { type: 'agent.message', message });
  }

  async #sayProgress(
    session: SessionDocument,
    progress: Omit<RunOutcome, 'status'>,
  ): Promise<void> {
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

    if (
      question !== null &&
      (question !== session.clarificationQuestion || session.clarificationAnswer !== null)
    ) {
      await this.#records?.askQuestion(session.sessionId, question, new Date());

      await this.#say(session, {
        type: 'agent.question',
        question,
        expiresAt: new Date(Date.now() + PAUSE_EXPIRY_MS).toISOString(),
      });
      return;
    }

    const waiting = await this.#pendingApproval(session);

    if (waiting !== null) {
      await this.#say(session, { type: 'agent.approval_required', approval: waiting });
      return;
    }

    if (result.state.phase === 'clarifying' && question === null) {
      await this.#say(session, {
        type: 'session.status',
        status: 'awaiting_user',
        progress: {
          step: result.state.budgets.steps,
          maxSteps: result.state.budgets.maxSteps,
          currentActivity: null,
        },
      });
      return;
    }

    const last = result.state.toolEvents.at(-1)?.tool ?? 'the requested action';
    const fallback =
      result.state.phase === 'awaiting_approval'
        ? `Nimbus could not prepare a reviewable approval for ${last}. It has not run that action. Please retry the request, or tell Nimbus to take a different approach.`
        : `Nimbus paused after ${last} without a question. Tell Nimbus what to investigate or change next.`;

    await this.#records?.askQuestion(session.sessionId, fallback, new Date());
    await this.#say(session, {
      type: 'agent.question',
      question: fallback,
      expiresAt: new Date(Date.now() + PAUSE_EXPIRY_MS).toISOString(),
    });
  }

  async #pendingApproval(session: SessionDocument): Promise<ApprovalRequest | null> {
    if (this.#approvalsFor === null) {
      return null;
    }

    const open = (await this.#approvalsFor(session.sessionId).list()).find(
      (one) => one.status === 'pending',
    );

    if (open === undefined) {
      return null;
    }

    return ApprovalRequestSchema.parse({
      approvalId: open.approvalId,
      actionHash: open.actionHash,
      effect: open.effect,
      requestedAt: open.requestedAt,
      expiresAt: open.expiresAt,
    });
  }

  async #sayFailed(session: SessionDocument, outcome: RunOutcome): Promise<void> {
    if (outcome.failure === undefined || outcome.failure === null) {
      return;
    }

    this.#logger.error(
      {
        sessionId: session.sessionId,
        resumeAttempt: session.retryCount,
        failureCode: outcome.failure.code,
        branch: outcome.branch ?? session.branch,
        baseCommitSha: outcome.baseCommitSha ?? session.baseCommitSha,
        sandboxId: outcome.sandboxId ?? session.sandboxId,
        changedPaths: outcome.filesChanged?.map((file) => file.path) ?? [],
        checks: outcome.checks?.map((check) => ({ name: check.name, status: check.status })) ?? [],
      },
      'a session reached a terminal failure',
    );

    await this.#say(session, { type: 'session.failed', failure: outcome.failure });
    await this.#mailEnded(session, 'failed', outcome.failure.message);
  }

  async #mailEnded(
    session: SessionDocument,
    outcome: 'failed' | 'cancelled',
    reason: string,
  ): Promise<void> {
    if (this.#mail === null) {
      return;
    }

    try {
      await this.#mail.sendSessionEnded(await this.#notifyEmailFor(session), {
        repository: `${session.repository.owner}/${session.repository.name}`,
        task: session.task,
        outcome,
        reason,
      });
    } catch (error) {
      this.#logger.warn(
        { sessionId: session.sessionId, error: String(error) },
        'a session could not be reported by email, which changes nothing about the run',
      );
    }
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
    if (reason === 'no_commit') {
      return { status: 'failed', failure: failureOf('REPOSITORY_EMPTY') };
    }
    return { status: 'failed', failure: failureOf('SANDBOX_FAILED') };
  }
}
