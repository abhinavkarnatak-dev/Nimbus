import {
  PolicyRecordSchema,
  ToolEventSummarySchema,
  type CheckResult,
  type PolicyRecord,
  type ToolEventSummary,
  type ToolInvocation,
} from '@nimbus/contracts';

import type { Logger } from '../../logging/logger.js';
import type { PolicyGate } from '../policy/policy.js';
import type { ToolRegistry } from '../registry/registry.js';
import { EXECUTE_LIMITS } from './limits.js';
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
  now?: () => number;
}

export const USER_FACING_TOOLS: ReadonlySet<string> = new Set(['message_user', 'wait_for_user']);

export class ActionExecutor {
  readonly #registry: ToolRegistry;

  readonly #policy: PolicyGate;

  readonly #logger: Logger;

  readonly #now: () => number;

  constructor(options: ExecutorOptions) {
    this.#registry = options.registry;
    this.#policy = options.policy;
    this.#logger = options.logger;
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
      return this.#finish(request, hash, {
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
      return this.#finish(request, hash, {
        status: 'denied',
        policy: record,
        observation: observeDenial(request.tool, decision.reason),
      });
    }

    if (decision.decision === 'approval_required') {
      const approval = await this.#policy.requestApproval(action);

      return this.#finish(request, hash, {
        status: 'approval_required',
        policy: record,
        observation: observeApprovalPause(request.tool, decision.reason),
        approvalId: approval.approvalId,
        pause: 'approval',
      });
    }

    const invoked = await this.#registry.invoke({
      toolCallId: request.toolCallId,
      tool: request.tool,
      input: request.toolArguments,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    });

    if (invoked.output === null) {
      return this.#finish(request, hash, {
        status: 'executed',
        policy: record,
        observation: observeFailure(
          request.tool,
          invoked.outcome,
          invoked.message ?? 'that tool did not finish',
        ),
        invocation: invoked.invocation,
        failed: true,
      });
    }

    const output = invoked.output;
    const speaks = USER_FACING_TOOLS.has(request.tool) && output.text !== undefined;

    return this.#finish(request, hash, {
      status: 'executed',
      policy: record,
      observation: observeOutput(request.tool, output),
      invocation: invoked.invocation,
      check: output.check ?? null,
      paths: [...(output.paths ?? [])],
      userMessage: speaks ? safeUserMessage(output.text ?? '') : null,
      pause: output.pause ?? null,
      failed: invoked.outcome !== 'succeeded',
    });
  }

  #finish(
    request: ExecutionRequest,
    actionHash: string,
    parts: {
      status: ExecutionStatus;
      policy: PolicyRecord | null;
      observation: Observation;
      invocation?: ToolInvocation;
      check?: CheckResult | null;
      paths?: string[];
      approvalId?: string;
      userMessage?: string | null;
      pause?: 'clarification' | 'approval' | null;
      failed?: boolean;
    },
  ): ExecutionResult {
    const outcome = eventOutcome(parts.status, parts.failed === true);

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

    return {
      status: parts.status,
      actionHash,
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

function eventOutcome(status: ExecutionStatus, failed: boolean): ToolEventSummary['outcome'] {
  if (status === 'approval_required') {
    return 'paused';
  }

  if (status === 'denied' || status === 'refused') {
    return 'refused';
  }
  return failed ? 'failed' : 'ok';
}
