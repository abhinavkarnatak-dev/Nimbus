import type { BaseCheckpointSaver } from '@langchain/langgraph-checkpoint';
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
import type { TextProvider } from '../llm/provider.js';
import { buildSandboxSpec, type Sandbox, type SandboxProvider } from '../sandbox/index.js';
import { ORCHESTRATOR_LIMITS } from './limits.js';
import { WorkshopError, type PreparedRun, type SessionWorkshop } from './workshop.js';

export interface InstallationDirectory {
  activeInstallation(userId: string): Promise<{ installationId: number } | null>;
}

export interface LiveWorkshopOptions {
  db: Db;
  installations: InstallationDirectory;
  tokens: GitHubTokenProvider;
  sandboxes: SandboxProvider;
  text: TextProvider;
  config: AppConfig;
  logger: Logger;
  attachments?: SessionAttachments;
  events?: EventPublisher;
  records?: SessionRecords;
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

    const base = await this.#baseCommit(session, readToken);
    const plan = this.#plan(session);

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
      text: this.#options.text,
      logger: this.#options.logger,
      plan,
    });

    const attached = await this.#attached(session, router);

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
        ...this.#conversation(session),
        ...(this.#options.checkpointer === undefined
          ? {}
          : { checkpointer: this.#options.checkpointer }),
      },
      finish: async (): Promise<void> => {
        try {
          await this.#options.tokens.revoke(readToken);
        } catch (error) {
          this.#options.logger.warn(
            { sessionId: session.sessionId, error: String(error) },
            'a read token could not be revoked, it expires on its own',
          );
        }
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

  async #baseCommit(session: SessionDocument, token: InstallationToken): Promise<string> {
    if (session.baseCommitSha !== null) {
      return session.baseCommitSha;
    }

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

  #plan(session: SessionDocument): ModelPlan {
    const chosen = session.model ?? null;

    if (chosen === null) {
      return planFor();
    }

    try {
      return planFor({ textModel: chosen.textModel });
    } catch (error) {
      throw new WorkshopError(
        'models',
        'The model this session was started with is no longer available, and Nimbus does not swap in another one.',
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
  const fresh = createState(input);
  const spent = Math.min(Math.max(session.step, 0), fresh.budgets.maxSteps);

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
