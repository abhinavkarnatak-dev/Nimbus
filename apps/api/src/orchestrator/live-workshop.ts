import type { BaseCheckpointSaver } from '@langchain/langgraph-checkpoint';
import type { ModelPlan } from '@nimbus/contracts';

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
import type { InstallationService } from '../github/installation-service.js';
import type { GitHubTokenProvider, InstallationToken } from '../github/token-provider.js';
import { OctokitGitDataClient } from '../push/octokit-git-data.js';
import type { Logger } from '../logging/logger.js';
import { SessionRouter } from '../routing/router.js';
import { planFor } from '../routing/selection.js';
import type { TextProvider } from '../llm/provider.js';
import { buildSandboxSpec, type Sandbox, type SandboxProvider } from '../sandbox/index.js';
import { ORCHESTRATOR_LIMITS } from './limits.js';
import { WorkshopError, type PreparedRun, type SessionWorkshop } from './workshop.js';

export interface LiveWorkshopOptions {
  db: Db;
  installations: InstallationService;
  tokens: GitHubTokenProvider;
  sandboxes: SandboxProvider;
  text: TextProvider;
  config: AppConfig;
  logger: Logger;
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

    const sandbox = await this.#rent(session);
    const registry = new ToolRegistry({
      sessionId: session.sessionId,
      sandbox,
      commands: new CommandRunner(sandbox),
      logger: this.#options.logger,
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
        budgets: { maxSteps: session.maxSteps || (this.#options.maxSteps ?? 40) },
      },
      session,
    );

    return {
      installationId,
      input: {
        state,
        sandbox,
        registry,
        router: new SessionRouter({
          text: this.#options.text,
          logger: this.#options.logger,
          plan,
        }),
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
        }),
        source: new GitHubRepositorySource({ logger: this.#options.logger }),
        reference: {
          owner: session.repository.owner,
          name: session.repository.name,
          commitSha: base,
          token: readToken.token,
        },
        logger: this.#options.logger,
        signal: options.signal,
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
    void session;
    return planFor();
  }

  async #rent(session: SessionDocument): Promise<Sandbox> {
    try {
      return await this.#options.sandboxes.create(
        buildSandboxSpec(this.#options.config.sandbox, session.sessionId),
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

  if (session.clarificationQuestion === null) {
    return fresh;
  }

  return parseState({
    ...fresh,
    clarificationQuestion: session.clarificationQuestion,
    clarificationAnswer: session.clarificationAnswer,
  });
}
