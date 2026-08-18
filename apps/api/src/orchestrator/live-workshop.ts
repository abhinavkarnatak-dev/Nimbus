import type { BaseCheckpointSaver } from '@langchain/langgraph-checkpoint';
import { Octokit } from '@octokit/rest';
import type { ModelPlan, SessionMessage } from '@nimbus/contracts';

import type { ConversationSource } from '../agent/graph/graph.js';

import { GitHubRepositorySource } from '../agent/clone/github.js';
import { CommandRunner } from '../agent/commands/runner.js';
import { ActionExecutor } from '../agent/execute/executor.js';
import { MongoApprovals } from '../sessions/approvals.js';
import { PolicyGate } from '../agent/policy/policy.js';
import { ToolRegistry } from '../agent/registry/registry.js';
import { createState, parseState } from '../agent/state/state.js';
import type { AppConfig } from '../config/load.js';
import type { Db } from 'mongodb';
import type { SessionDocument } from '../db/models/session.js';
import type { EventPublisher } from '../events/publisher.js';
import type { GitHubTokenProvider, InstallationToken } from '../github/token-provider.js';
import type { ActionReporter } from '../agent/execute/reporter.js';
import { DurableProgressReporter, EveryReporter, LiveActionReporter } from './reporter.js';
import type { SessionRecords } from '../sessions/repository.js';
import { OctokitGitDataClient } from '../push/octokit-git-data.js';
import type { Logger } from '../logging/logger.js';
import {
  NOTHING_ATTACHED,
  type LoadedAttachments,
  type SessionAttachments,
} from '../routing/attached.js';
import { SessionRouter } from '../routing/router.js';
import { planFor } from '../routing/selection.js';
import type { LlmProviderName } from '@nimbus/contracts';
import type { TextProvider } from '../llm/provider.js';
import type { ProviderKeyDirectory, TextProviderSource } from '../llm/sources.js';
import { NO_KEYS_FOR_RUN } from '../llm/user-providers.js';
import { buildSandboxSpec, type Sandbox, type SandboxProvider } from '../sandbox/index.js';
import { ORCHESTRATOR_LIMITS } from './limits.js';
import { WorkshopError, type PreparedRun, type SessionWorkshop } from './workshop.js';

export interface InstallationDirectory {
  activeInstallation(userId: string): Promise<{ installationId: number } | null>;
}

export interface BaseCommitResolver {
  resolve(session: SessionDocument, token: InstallationToken): Promise<string>;
}

export interface LiveWorkshopOptions {
  db: Db;
  installations: InstallationDirectory;
  tokens: GitHubTokenProvider;
  sandboxes: SandboxProvider;
  text: TextProviderSource;
  providerKeys: ProviderKeyDirectory;
  config: AppConfig;
  logger: Logger;
  attachments?: SessionAttachments;
  events?: EventPublisher;
  records?: SessionRecords;
  baseCommits?: BaseCommitResolver;
  checkpointer?: BaseCheckpointSaver;
  maxSteps?: number;
}

export class LiveSessionWorkshop implements SessionWorkshop {
  readonly name = 'live';

  readonly #options: LiveWorkshopOptions;

  constructor(options: LiveWorkshopOptions) {
    this.#options = options;
  }

  async prepare(session: SessionDocument, options: { signal: AbortSignal }): Promise<PreparedRun> {
    const installation = await this.#options.installations.activeInstallation(session.userId);

    if (installation === null) {
      throw new WorkshopError('no_installation', 'That account has no connected GitHub app.');
    }

    const installationId = installation.installationId;
    const readToken = await this.#options.tokens.getToken({
      installationId,
      repositoryId: session.repository.repositoryId,
      scope: 'read',
    });

    let base: string;

    try {
      base = await this.#baseCommit(session, readToken, options.signal);
    } catch (error) {
      await this.#revoke(session, readToken);
      throw error;
    }

    let plan: ModelPlan;
    let text: TextProvider;

    try {
      const held = await this.#options.providerKeys.providersFor(session.userId);

      if (held.length === 0) {
        throw new WorkshopError('models', NO_KEYS_FOR_RUN);
      }
      plan = this.#plan(session, held);
      text = await this.#options.text.for(session.userId);
    } catch (error) {
      await this.#revoke(session, readToken);
      throw error instanceof WorkshopError
        ? error
        : new WorkshopError('models', NO_KEYS_FOR_RUN, { cause: error });
    }

    const limits = this.#options.config.limits;

    const sandbox = await this.#rent(session);
    const registry = new ToolRegistry({
      sessionId: session.sessionId,
      sandbox,
      commands: new CommandRunner(sandbox),
      logger: this.#options.logger,
      limits,
    });

    const state = resumedState(
      {
        sessionId: session.sessionId,
        userId: session.userId,
        repositoryId: session.repository.repositoryId,
        installationId,
        task: session.task,
        attachmentIds: session.attachments.map((one) => one.attachmentId),
        baseCommitSha: base,
        defaultBranch: session.repository.defaultBranch,
        models: plan,
        budgets: { maxSteps: session.maxSteps || (this.#options.maxSteps ?? limits.maxAgentSteps) },
      },
      session,
    );

    const router = new SessionRouter({
      text,
      logger: this.#options.logger,
      plan,
    });

    const attached = await this.#attached(session, router);
    const reviewComments = await this.#reviewComments(session, readToken);

    return {
      installationId,
      input: {
        state,
        sandbox,
        registry,
        router,
        images: attached.images,
        attachments: attached.texts,
        executor: new ActionExecutor({
          registry,
          policy: new PolicyGate({
            approvals: new MongoApprovals({
              db: this.#options.db,
              sessionId: session.sessionId,
            }),
            logger: this.#options.logger,
          }),
          logger: this.#options.logger,
          ...this.#reporting(session),
        }),
        source: new GitHubRepositorySource({ logger: this.#options.logger }),
        reference: {
          owner: session.repository.owner,
          name: session.repository.name,
          commitSha: base,
          token: readToken.token,
        },
        logger: this.#options.logger,
        limits,
        signal: options.signal,
        ...(reviewComments === null ? {} : { reviewComments }),
        ...this.#conversation(session),
        ...(this.#options.checkpointer === undefined
          ? {}
          : { checkpointer: this.#options.checkpointer }),
      },
      finish: async (): Promise<void> => {
        await this.#revoke(session, readToken);
      },
    };
  }

  #conversation(session: SessionDocument): { conversation?: ConversationSource } {
    const records = this.#options.records;

    if (records === undefined) {
      return {};
    }

    return {
      conversation: {
        latest: async (): Promise<readonly SessionMessage[]> =>
          records.conversationOf(session.sessionId),
      },
    };
  }

  async #reviewComments(session: SessionDocument, token: InstallationToken): Promise<string | null> {
    if (session.pullRequest === null) return null;

    try {
      const client = new Octokit({ auth: token.token });
      const [review, discussion] = await Promise.all([
        client.pulls.listReviewComments({
          owner: session.repository.owner,
          repo: session.repository.name,
          pull_number: session.pullRequest.number,
          per_page: 100,
        }),
        client.issues.listComments({
          owner: session.repository.owner,
          repo: session.repository.name,
          issue_number: session.pullRequest.number,
          per_page: 100,
        }),
      ]);
      const comments = [
        ...review.data.map((one) =>
          `${one.path ?? 'pull request'}${one.line === null ? '' : `:${String(one.line)}`}: ${one.body}`,
        ),
        ...discussion.data.map((one) => `pull request: ${one.body}`),
      ].filter((one) => one.trim() !== '');
      return comments.length === 0 ? null : comments.join('\n\n').slice(0, 12_000);
    } catch (error) {
      this.#options.logger.warn(
        { sessionId: session.sessionId, pullRequest: session.pullRequest.number, error: String(error) },
        'pull request comments could not be read for a follow-up',
      );
      return null;
    }
  }

  #reporting(session: SessionDocument): { reporter?: ActionReporter } {
    const reporters: ActionReporter[] = [];

    if (this.#options.events !== undefined) {
      reporters.push(
        new LiveActionReporter({
          events: this.#options.events,
          sessionId: session.sessionId,
          userId: session.userId,
          logger: this.#options.logger,
        }),
      );
    }

    if (this.#options.records !== undefined) {
      reporters.push(
        new DurableProgressReporter({
          records: this.#options.records,
          sessionId: session.sessionId,
          logger: this.#options.logger,
        }),
      );
    }

    const only = reporters[0];

    if (only === undefined) {
      return {};
    }
    return { reporter: reporters.length === 1 ? only : new EveryReporter(reporters) };
  }

  async #attached(session: SessionDocument, router: SessionRouter): Promise<LoadedAttachments> {
    const loader = this.#options.attachments;

    if (loader === undefined || session.attachments.length === 0) {
      return NOTHING_ATTACHED;
    }

    let loaded: LoadedAttachments;

    try {
      loaded = await loader.load({
        userId: session.userId,
        attachmentIds: session.attachments.map((one) => one.attachmentId),
      });
    } catch (error) {
      this.#options.logger.error(
        { sessionId: session.sessionId, error: String(error) },
        'nothing a person attached could be read, the run carries on without any of it',
      );
      return NOTHING_ATTACHED;
    }

    for (const report of loaded.reports) {
      router.charge(report);
    }

    this.#options.logger.info(
      {
        sessionId: session.sessionId,
        images: loaded.images.length,
        texts: loaded.texts.length,
        described: loaded.reports.length,
        lost: loaded.lost,
      },
      'what a person attached was made readable for the run',
    );

    return loaded;
  }

  async #baseCommit(
    session: SessionDocument,
    token: InstallationToken,
    signal: AbortSignal,
  ): Promise<string> {
    if (session.baseCommitSha !== null) {
      return session.baseCommitSha;
    }

    const candidate =
      this.#options.baseCommits === undefined
        ? await this.#resolveBaseCommit(session, token)
        : await this.#options.baseCommits.resolve(session, token);

    if (signal.aborted) {
      throw new WorkshopError('stopped', 'That session stopped before its base commit was pinned.');
    }

    const pinned = await this.#options.records?.pinBaseCommitSha(
      session.sessionId,
      candidate,
      new Date(),
    );

    if (pinned === undefined) {
      throw new WorkshopError(
        'no_commit',
        'The repository base could not be persisted before the run started.',
      );
    }

    if (pinned === null) {
      throw new WorkshopError('stopped', 'That session stopped before its base commit was pinned.');
    }
    return pinned;
  }

  async #resolveBaseCommit(session: SessionDocument, token: InstallationToken): Promise<string> {
    const reader = new OctokitGitDataClient({
      owner: session.repository.owner,
      name: session.repository.name,
      token: token.token,
    });
    const head = await reader.getRef(session.repository.defaultBranch);

    if (head === null) {
      throw new WorkshopError('no_commit', 'That repository has no commits on its default branch.');
    }
    return head.commitSha;
  }

  async #revoke(session: SessionDocument, token: InstallationToken): Promise<void> {
    try {
      await this.#options.tokens.revoke(token);
    } catch (error) {
      this.#options.logger.warn(
        { sessionId: session.sessionId, error: String(error) },
        'a read token could not be revoked, it expires on its own',
      );
    }
  }

  #plan(session: SessionDocument, providers: readonly LlmProviderName[]): ModelPlan {
    const chosen = session.model ?? null;

    try {
      return planFor(chosen === null ? { providers } : { textModel: chosen.textModel, providers });
    } catch (error) {
      throw new WorkshopError(
        'models',
        'The model this session was started with is not covered by the API keys on this account, and Nimbus does not swap in another one.',
        { cause: error },
      );
    }
  }

  async #rent(session: SessionDocument): Promise<Sandbox> {
    try {
      return await this.#options.sandboxes.create(
        buildSandboxSpec(
          this.#options.config.sandbox,
          session.sessionId,
          this.#options.config.limits,
        ),
      );
    } catch (error) {
      throw new WorkshopError('sandbox', 'A sandbox could not be started.', { cause: error });
    }
  }
}

export const WORKSHOP_LEASE_SECONDS = ORCHESTRATOR_LIMITS.leaseSeconds;

export function resumedState(
  input: Parameters<typeof createState>[0],
  session: SessionDocument,
): ReturnType<typeof createState> {
  const userTurns = session.messages.filter((message) => message.role === 'user');
  const followUp = userTurns.length > 1 ? userTurns.at(-1)?.text ?? null : null;
  const fresh = createState({
    ...input,
    // A normal follow-up is the new instruction. Earlier turns are still supplied to the
    // reasoning node as conversation, so the agent does not lose the original context.
    task: session.clarificationAnswer === null && followUp !== null ? followUp : input.task,
  });
  const spent = Math.min(Math.max(session.step, 0), fresh.budgets.maxSteps);

  if (session.clarificationAnswer !== null) {
    return parseState({
      ...fresh,
      budgets: { ...fresh.budgets, steps: spent },
      clarificationAnswer: session.clarificationAnswer,
    });
  }

  if (session.clarificationQuestion === null && spent === 0) {
    return fresh;
  }

  return parseState({
    ...fresh,
    budgets: { ...fresh.budgets, steps: spent },
    clarificationQuestion: session.clarificationQuestion,
    clarificationAnswer: session.clarificationAnswer,
  });
}
