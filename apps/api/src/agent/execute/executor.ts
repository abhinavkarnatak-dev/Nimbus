import {
  PolicyRecordSchema,
  ToolEventSummarySchema,
  ToolInvocationSchema,
  type CheckResult,
  type OutputStream,
  type PolicyRecord,
  type ToolEventSummary,
  type ToolInvocation,
  type ToolName,
  type ToolOutcome,
} from '@nimbus/contracts';

import type { Logger } from '../../logging/logger.js';
import { redactSecrets } from '../../logging/redact.js';
import type { PolicyGate } from '../policy/policy.js';
import type { ToolOutput } from '../registry/definition.js';
import type { ToolRegistry } from '../registry/registry.js';
import { EXECUTE_LIMITS } from './limits.js';
import { chunkOutput, type ActionReporter } from './reporter.js';
import {
  observeApprovalPause,
  observeDenial,
  observeFailure,
  observeOutput,
  observeRefusal,
  safeUserMessage,
  shorten,
  type Observation,
} from './observation.js';

export const EXECUTION_STATUSES = ['executed', 'denied', 'approval_required', 'refused'] as const;

export type ExecutionStatus = (typeof EXECUTION_STATUSES)[number];

export interface ExecutionRequest {
  step: number;
  toolCallId: string;
  tool: string;
  toolArguments: Record<string, unknown>;
  intent: string;
  signal?: AbortSignal;
}

export interface ExecutionResult {
  status: ExecutionStatus;
  actionHash: string;
  durationMs: number;
  policy: PolicyRecord | null;
  observation: Observation;
  event: ToolEventSummary;
  invocation: ToolInvocation | null;
  check: CheckResult | null;
  paths: string[];
  approvalId: string | null;
  userMessage: string | null;
  pause: 'clarification' | 'approval' | null;
}

export interface ExecutorOptions {
  registry: ToolRegistry;
  policy: PolicyGate;
  logger: Logger;
  reporter?: ActionReporter;
  now?: () => number;
}

export const USER_FACING_TOOLS: ReadonlySet<string> = new Set(['message_user', 'wait_for_user']);

export class ActionExecutor {
  readonly #registry: ToolRegistry;

  readonly #policy: PolicyGate;

  readonly #logger: Logger;

  readonly #reporter: ActionReporter | null;

  readonly #now: () => number;

  constructor(options: ExecutorOptions) {
    this.#registry = options.registry;
    this.#policy = options.policy;
    this.#logger = options.logger;
    this.#reporter = options.reporter ?? null;
    this.#now = options.now ?? ((): number => Date.now());
  }

  toolNames(): string[] {
    return this.#registry.names();
  }

  async execute(request: ExecutionRequest): Promise<ExecutionResult> {
    const action = { tool: request.tool, input: request.toolArguments };
    const hash = this.#policy.hashOf(action);
    const checked = this.#registry.check(request.tool, request.toolArguments);

    if (!checked.ok) {
      return await this.#finish(request, hash, {
        status: 'refused',
        policy: null,
        observation: observeRefusal(request.tool, checked.detail),
      });
    }

    const decision = await this.#policy.authorize(action);

    const record = PolicyRecordSchema.parse({
      decision: decision.decision,
      actionHash: decision.actionHash,
      reason: decision.reason.slice(0, EXECUTE_LIMITS.summaryMaxChars),
      decidedAtMs: decision.decidedAtMs,
      approvedByUser: decision.approvedByUser,
    });

    if (decision.decision === 'denied') {
      return await this.#finish(request, hash, {
        status: 'denied',
        policy: record,
        observation: observeDenial(request.tool, decision.reason),
      });
    }

    if (decision.decision === 'approval_required') {
      const approval = await this.#policy.requestApproval(action);

      return await this.#finish(request, hash, {
        status: 'approval_required',
        policy: record,
        observation: observeApprovalPause(request.tool, decision.reason),
        approvalId: approval.approvalId,
        pause: 'approval',
      });
    }

    await this.#sayStarted(request);

    const invoked = await this.#registry.invoke({
      toolCallId: request.toolCallId,
      tool: request.tool,
      input: request.toolArguments,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    });

    if (invoked.output === null) {
      return await this.#finish(request, hash, {
        status: 'executed',
        policy: record,
        observation: observeFailure(
          request.tool,
          invoked.outcome,
          invoked.message ?? 'that tool did not finish',
        ),
        invocation: invoked.invocation,
        durationMs: invoked.durationMs,
        failed: true,
      });
    }

    const output = invoked.output;
    const speaks = USER_FACING_TOOLS.has(request.tool) && output.text !== undefined;

    return await this.#finish(request, hash, {
      status: 'executed',
      policy: record,
      observation: observeOutput(request.tool, output),
      invocation: invoked.invocation,
      durationMs: invoked.durationMs,
      output,
      check: output.check ?? null,
      paths: [...(output.paths ?? [])],
      userMessage: speaks ? safeUserMessage(output.text ?? '') : null,
      pause: output.pause ?? null,
      failed: invoked.outcome !== 'succeeded',
    });
  }

  async #sayStarted(request: ExecutionRequest): Promise<void> {
    if (this.#reporter === null) {
      return;
    }

    const summary = shorten(redactSecrets(request.intent));

    const invocation = ToolInvocationSchema.parse({
      toolCallId: request.toolCallId,
      tool: request.tool,
      summary: summary === '' ? `${request.tool} is running` : summary,
      paths: [],
      startedAt: new Date(this.#now()).toISOString(),
    });

    await this.#safely(async () => {
      await this.#reporter?.started(invocation);
    });
  }

  async #sayOutput(toolCallId: string, output: ToolOutput | undefined): Promise<void> {
    if (this.#reporter === null || output === undefined) {
      return;
    }

    for (const part of reportedStreams(output)) {
      for (const piece of chunkOutput(redactSecrets(part.text))) {
        await this.#safely(async () => {
          await this.#reporter?.output({
            toolCallId,
            stream: part.stream,
            chunk: piece.chunk,
            truncated: piece.truncated || output.truncated === true,
          });
        });
      }
    }
  }

  async #sayCompleted(
    request: ExecutionRequest,
    event: ToolEventSummary,
    durationMs: number,
  ): Promise<void> {
    if (this.#reporter === null || !this.#registry.has(request.tool)) {
      return;
    }

    await this.#safely(async () => {
      await this.#reporter?.completed({
        toolCallId: request.toolCallId,
        tool: request.tool as ToolName,
        outcome: REPORTED_OUTCOME[event.outcome],
        durationMs,
        summary: event.summary,
      });
    });
  }

  async #safely(work: () => Promise<void>): Promise<void> {
    try {
      await work();
    } catch (error) {
      this.#logger.warn(
        { error: String(error) },
        'a live update could not be sent, the run carries on without it',
      );
    }
  }

  async #finish(
    request: ExecutionRequest,
    actionHash: string,
    parts: {
      status: ExecutionStatus;
      policy: PolicyRecord | null;
      observation: Observation;
      invocation?: ToolInvocation;
      durationMs?: number;
      output?: ToolOutput;
      check?: CheckResult | null;
      paths?: string[];
      approvalId?: string;
      userMessage?: string | null;
      pause?: 'clarification' | 'approval' | null;
      failed?: boolean;
    },
  ): Promise<ExecutionResult> {
    const outcome = eventOutcome(parts.status, parts.failed === true);
    const durationMs = parts.durationMs ?? 0;

    const event = ToolEventSummarySchema.parse({
      step: request.step,
      tool: request.tool,
      outcome,
      summary: shorten(parts.observation.summary) || 'nothing was reported',
      atMs: this.#now(),
    });

    this.#logger.info(
      {
        step: request.step,
        tool: request.tool,
        status: parts.status,
        outcome,
        actionHash,
        decision: parts.policy?.decision ?? null,
        approvedByUser: parts.policy?.approvedByUser ?? false,
        flags: parts.observation.flags,
        redacted: parts.observation.redacted,
        truncated: parts.observation.truncated,
        paths: (parts.paths ?? []).length,
      },
      'an action was executed',
    );

    await this.#sayOutput(request.toolCallId, parts.output);
    await this.#sayCompleted(request, event, durationMs);

    return {
      status: parts.status,
      actionHash,
      durationMs,
      policy: parts.policy,
      observation: parts.observation,
      event,
      invocation: parts.invocation ?? null,
      check: parts.check ?? null,
      paths: parts.paths ?? [],
      approvalId: parts.approvalId ?? null,
      userMessage: parts.userMessage ?? null,
      pause: parts.pause ?? null,
    };
  }
}

export const REPORTED_OUTCOME: Readonly<Record<ToolEventSummary['outcome'], ToolOutcome>> = {
  ok: 'succeeded',
  failed: 'failed',
  refused: 'denied',
  paused: 'denied',
};

export function reportedStreams(output: ToolOutput): { stream: OutputStream; text: string }[] {
  const parts: { stream: OutputStream; text: string }[] = [];
  const known = output.stdout !== undefined || output.stderr !== undefined;

  if (!known) {
    return output.text === undefined || output.text === ''
      ? []
      : [{ stream: 'stdout', text: output.text }];
  }

  if (output.stdout !== undefined && output.stdout !== '') {
    parts.push({ stream: 'stdout', text: output.stdout });
  }

  if (output.stderr !== undefined && output.stderr !== '') {
    parts.push({ stream: 'stderr', text: output.stderr });
  }
  return parts;
}

function eventOutcome(status: ExecutionStatus, failed: boolean): ToolEventSummary['outcome'] {
  if (status === 'approval_required') {
    return 'paused';
  }

  if (status === 'denied' || status === 'refused') {
    return 'refused';
  }
  return failed ? 'failed' : 'ok';
}
