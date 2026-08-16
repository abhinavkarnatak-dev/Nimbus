import type { PullRequestResult, PushResult, SessionMessage } from '@nimbus/contracts';

import { FakeRepositorySource } from '../agent/clone/fake.js';
import type { ActionReporter } from '../agent/execute/reporter.js';
import type { EventPublisher } from '../events/publisher.js';
import type { ConversationSource } from '../agent/graph/graph.js';
import type { SessionRecords } from '../sessions/repository.js';
import { DurableProgressReporter, EveryReporter, LiveActionReporter } from './reporter.js';
import { CommandRunner } from '../agent/commands/runner.js';
import { ActionExecutor } from '../agent/execute/executor.js';
import { InMemoryApprovals } from '../agent/policy/approvals.js';
import { PolicyGate } from '../agent/policy/policy.js';
import { ToolRegistry } from '../agent/registry/registry.js';
import { createState } from '../agent/state/state.js';
import type { SessionApprovalDocument, SessionDocument } from '../db/models/session.js';
import { FakeTextProvider } from '../llm/fake-text.js';
import { capturingLogger } from '../llm/llm.fixtures.js';
import type { Logger } from '../logging/logger.js';
import type { OpenPullRequestRequest, PullRequestGateway } from '../pull-request/gateway.js';
import type { PushGateway, PushRequest } from '../push/gateway.js';
import { SessionRouter } from '../routing/router.js';
import { planFor } from '../routing/selection.js';
import { FakeSandboxProvider, buildSandboxSpec, type Sandbox } from '../sandbox/index.js';
import { SESSION_ID_PREFIX } from '../db/models/session.js';
import { SHOPFRONT, testId } from '../sessions/sessions.fixtures.js';
import { assertSafeSegment } from '../redis/keys.js';
import type { Lease } from '../redis/lease.js';
import type { SessionLeases } from './claim.js';
import type { PreparedRun, SessionWorkshop } from './workshop.js';

export const SAMPLE_FILES: Readonly<Record<string, string>> = {
  'README.md': '# Shopfront\n',
  'src/routing/redirect.ts': [
    'const DEFAULT_DESTINATION = "/dashboard";',
    '',
    'export function redirectAfterLogin(): string {',
    '  return DEFAULT_DESTINATION;',
    '}',
    '',
  ].join('\n'),
};

export const REDIRECT_PATCH = [
  '--- a/src/routing/redirect.ts',
  '+++ b/src/routing/redirect.ts',
  '@@ -1,1 +1,1 @@',
  '-const DEFAULT_DESTINATION = "/dashboard";',
  '+const DEFAULT_DESTINATION = "/home";',
  '',
].join('\n');

export const CLEAR_SCOPE = { value: { clear: true, question: '' } };

export const BACKEND_ONLY_TOKEN = 'ghs_atokenthatnevergoesinsidethesandbox';

export function answer(
  tool: string,
  toolArguments: Record<string, unknown>,
): { value: { intent: string; tool: string; toolArgumentsJson: string } } {
  return {
    value: { intent: `do ${tool}`, tool, toolArgumentsJson: JSON.stringify(toolArguments) },
  };
}

export const UNCLEAR_SCOPE = {
  value: { clear: false, question: 'Which page should people land on after signing in?' },
};

export const NEVER_CLEAR_ANSWERS = [
  UNCLEAR_SCOPE,
  UNCLEAR_SCOPE,
  UNCLEAR_SCOPE,
  UNCLEAR_SCOPE,
  UNCLEAR_SCOPE,
  UNCLEAR_SCOPE,
];

export function pendingApproval(at: Date): SessionApprovalDocument {
  return {
    approvalId: testId('apr', 'card'),
    actionHash: 'a'.repeat(64),
    effect: {
      category: 'file_deletion',
      summary: 'delete an unused helper',
      paths: ['src/old.ts'],
      reason: 'the task says the helper is dead',
      risk: 'medium',
    },
    status: 'pending',
    requestedAt: at,
    expiresAt: new Date(at.getTime() + 900_000),
  };
}

export function waitingDocument(
  waitedMs: number,
  overrides: Partial<SessionDocument> = {},
): SessionDocument {
  const since = new Date(Date.now() - waitedMs);

  return sessionDocument({
    status: 'awaiting_user',
    waitingSince: since,
    clarificationQuestion: 'Which page should people land on after signing in?',
    ...overrides,
  });
}

export const FINISHING_ANSWERS = [
  CLEAR_SCOPE,
  answer('apply_patch', { patch: REDIRECT_PATCH }),
  answer('run_checks', { name: 'unit tests', kind: 'test', argv: ['pnpm', 'test'] }),
  answer('prepare_commit', { summary: 'send people home after signing in' }),
];

export function sessionDocument(overrides: Partial<SessionDocument> = {}): SessionDocument {
  const at = new Date('2026-08-15T10:00:00.000Z');

  return {
    sessionId: testId(SESSION_ID_PREFIX, 'w'),
    userId: testId('usr', 'owner'),
    status: 'queued',
    repository: {
      repositoryId: SHOPFRONT.repositoryId,
      owner: SHOPFRONT.owner,
      name: SHOPFRONT.name,
      defaultBranch: SHOPFRONT.defaultBranch,
      visibility: 'public',
      htmlUrl: SHOPFRONT.htmlUrl,
      updatedAt: at,
    },
    branch: null,
    baseCommitSha: 'a'.repeat(40),
    task: 'the login redirect always sends people to the dashboard',
    model: null,
    clarificationQuestion: null,
    clarificationAnswer: null,
    waitingSince: null,
    messages: [],
    attachments: [],
    idempotencyKey: testId('idk', 'a'),
    checkpointId: null,
    sandboxId: null,
    step: 0,
    maxSteps: 12,
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
    createdAt: at,
    updatedAt: at,
    lastActivityAt: at,
    completedAt: null,
    ...overrides,
  };
}

export class RecordingPushGateway implements PushGateway {
  readonly name = 'recording';

  readonly calls: PushRequest[] = [];

  #failure: Error | null = null;

  #after: (() => Promise<void>) | null = null;

  failWith(error: Error): void {
    this.#failure = error;
  }

  justAfter(work: () => Promise<void>): void {
    this.#after = work;
  }

  async push(request: PushRequest): Promise<PushResult> {
    this.calls.push(request);
    await this.#after?.();

    if (this.#failure !== null) {
      throw this.#failure;
    }

    const already = this.calls.filter((one) => one.sessionId === request.sessionId).length > 1;

    return Promise.resolve({
      branch: `nimbus/${request.sessionId.slice(4, 12)}-task`,
      commitSha: 'b'.repeat(40),
      outcome: already ? 'already_pushed' : 'created',
    } as PushResult);
  }
}

export class RecordingPullRequestGateway implements PullRequestGateway {
  readonly name = 'recording';

  readonly calls: OpenPullRequestRequest[] = [];

  #failure: Error | null = null;

  failWith(error: Error): void {
    this.#failure = error;
  }

  async open(request: OpenPullRequestRequest): Promise<PullRequestResult> {
    this.calls.push(request);

    if (this.#failure !== null) {
      throw this.#failure;
    }

    return Promise.resolve({
      number: this.calls.length,
      url: `https://github.com/${request.owner}/${request.name}/pull/${String(this.calls.length)}`,
      branch: request.branch,
      headSha: 'b'.repeat(40),
      createdAt: '2026-08-15T10:05:00.000Z',
    } as PullRequestResult);
  }
}

export interface FakeWorkshopOptions {
  logger: Logger;
  answers?: readonly { value: unknown }[];
  files?: Readonly<Record<string, string>>;
  failWith?: Error;
  events?: EventPublisher;
  reporter?: ActionReporter;
  records?: SessionRecords;
  onPrepare?: (session: SessionDocument, signal: AbortSignal) => void;
}

export class FakeWorkshop implements SessionWorkshop {
  readonly name = 'fake';

  readonly prepared: string[] = [];

  readonly finished: string[] = [];

  readonly sandboxes: Sandbox[] = [];

  readonly specs: ReturnType<typeof buildSandboxSpec>[] = [];

  readonly tokensGiven: string[] = [];

  readonly #options: FakeWorkshopOptions;

  constructor(options: FakeWorkshopOptions) {
    this.#options = options;
  }

  #reporterFor(session: SessionDocument): ActionReporter | null {
    if (this.#options.reporter !== undefined) {
      return this.#options.reporter;
    }

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
      return null;
    }
    return reporters.length === 1 ? only : new EveryReporter(reporters);
  }

  #conversationFor(session: SessionDocument): { conversation?: ConversationSource } {
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

  async prepare(session: SessionDocument, options: { signal: AbortSignal }): Promise<PreparedRun> {
    this.prepared.push(session.sessionId);
    this.#options.onPrepare?.(session, options.signal);

    if (this.#options.failWith !== undefined) {
      throw this.#options.failWith;
    }

    const logger = this.#options.logger;
    const provider = new FakeSandboxProvider({ files: {} });
    const spec = buildSandboxSpec(
      { provider: 'fake', maxSeconds: 60, allowInternet: false, templateId: 'test' },
      session.sessionId,
    );
    const sandbox = await provider.create(spec);

    this.specs.push(spec);
    this.sandboxes.push(sandbox);

    const registry = new ToolRegistry({
      sessionId: session.sessionId,
      sandbox,
      commands: new CommandRunner(sandbox),
      logger,
    });

    const text = new FakeTextProvider({ answers: [...(this.#options.answers ?? [])] });
    const reporter = this.#reporterFor(session);

    return {
      installationId: 4_242,
      input: {
        state: createState({
          sessionId: session.sessionId,
          userId: session.userId,
          repositoryId: session.repository.repositoryId,
          installationId: 4_242,
          task: session.task,
          baseCommitSha: session.baseCommitSha ?? 'a'.repeat(40),
          defaultBranch: session.repository.defaultBranch,
          models: planFor(),
          budgets: { maxSteps: session.maxSteps },
        }),
        sandbox,
        registry,
        router: new SessionRouter({ text, logger, plan: planFor() }),
        executor: new ActionExecutor({
          registry,
          policy: new PolicyGate({ approvals: new InMemoryApprovals(), logger }),
          logger,
          ...(reporter === null ? {} : { reporter }),
        }),
        source: new FakeRepositorySource({ files: this.#options.files ?? SAMPLE_FILES }),
        reference: {
          owner: session.repository.owner,
          name: session.repository.name,
          commitSha: session.baseCommitSha ?? 'a'.repeat(40),
          token: BACKEND_ONLY_TOKEN,
        },
        logger,
        signal: options.signal,
        ...this.#conversationFor(session),
      },
      finish: async (): Promise<void> => {
        this.finished.push(session.sessionId);
        await Promise.resolve();
      },
    };
  }
}

export function orchestratorLogger(): { logger: Logger; text: () => string } {
  return capturingLogger();
}

export function whenAborted(signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve();
  }

  return new Promise<void>((resolve) => {
    signal.addEventListener(
      'abort',
      () => {
        resolve();
      },
      { once: true },
    );
  });
}

export class InMemoryLeases implements SessionLeases {
  readonly holders = new Map<string, string>();

  #next = 0;

  async acquire(resource: string, ttlSeconds: number, holder?: string): Promise<Lease | null> {
    assertSafeSegment(resource);

    if (this.holders.has(resource)) {
      return Promise.resolve(null);
    }

    this.#next += 1;
    const owner = holder ?? `hld_${String(this.#next)}`;
    this.holders.set(resource, owner);

    return Promise.resolve({
      resource,
      holder: owner,
      expiresAt: new Date(Date.now() + ttlSeconds * 1_000),
    });
  }

  async renew(lease: Lease, ttlSeconds: number): Promise<boolean> {
    if (this.holders.get(lease.resource) !== lease.holder) {
      return Promise.resolve(false);
    }

    lease.expiresAt = new Date(Date.now() + ttlSeconds * 1_000);
    return Promise.resolve(true);
  }

  async release(lease: Lease): Promise<boolean> {
    if (this.holders.get(lease.resource) !== lease.holder) {
      return Promise.resolve(false);
    }

    this.holders.delete(lease.resource);
    return Promise.resolve(true);
  }

  async holderOf(resource: string): Promise<string | null> {
    return Promise.resolve(this.holders.get(resource) ?? null);
  }

  expire(resource: string): void {
    this.holders.delete(resource);
  }

  steal(resource: string, holder = 'somebody-else'): void {
    this.holders.set(resource, holder);
  }
}
