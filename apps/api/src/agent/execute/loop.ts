import type { AgentBudgets, AgentState, AgentStopReason } from '@nimbus/contracts';

import { shortfall, takeRetry, takeStep, clearRetries } from '../state/budgets.js';
import {
  parseState,
  recordCheck,
  recordFileChanged,
  recordFileRead,
  recordToolEvent,
  stopped,
} from '../state/state.js';
import type { ExecutionResult } from './executor.js';
import { EXECUTE_LIMITS } from './limits.js';

const WRITING_TOOLS: ReadonlySet<string> = new Set(['apply_patch', 'create_file']);

export interface StopVerdict {
  stop: boolean;
  reason: AgentStopReason | null;
  detail: string;
}

export function keepGoing(): StopVerdict {
  return { stop: false, reason: null, detail: '' };
}

export class RunGuard {
  private readonly failures = new Map<string, number>();

  private readonly repeats = new Map<string, number>();

  private readonly order: string[] = [];

  private readonly blocked = new Map<string, number>();

  beforeStep(state: AgentState, nowMs: number, cancelled = false): StopVerdict {
    if (cancelled) {
      return { stop: true, reason: 'cancelled', detail: 'the session was cancelled' };
    }

    const found = shortfall(state.budgets, nowMs);

    if (found !== null) {
      return { stop: true, reason: found.reason, detail: found.detail };
    }
    return keepGoing();
  }

  afterStep(result: ExecutionResult): StopVerdict {
    if (
      result.status === 'executed' &&
      result.event.outcome === 'ok' &&
      WRITING_TOOLS.has(result.event.tool)
    ) {
      this.failures.clear();
      this.repeats.clear();
      this.order.length = 0;
      this.blocked.clear();
    }

    const seen = (this.repeats.get(result.actionHash) ?? 0) + 1;
    this.remember(result.actionHash);
    this.repeats.set(result.actionHash, seen);

    if (countsAsFailure(result)) {
      const failed = (this.failures.get(result.actionHash) ?? 0) + 1;
      this.failures.set(result.actionHash, failed);

      if (failed >= EXECUTE_LIMITS.sameActionFailuresMax) {
        return {
          stop: true,
          reason: 'repeated_action',
          detail: `${result.event.tool} failed the same way ${String(failed)} times`,
        };
      }
    } else {
      this.failures.delete(result.actionHash);
    }

    if (seen >= EXECUTE_LIMITS.sameActionRepeatsMax) {
      return {
        stop: true,
        reason: 'repeated_action',
        detail: `${result.event.tool} was asked for exactly the same thing ${String(seen)} times`,
      };
    }
    return keepGoing();
  }

  failuresFor(actionHash: string): number {
    return this.failures.get(actionHash) ?? 0;
  }

  timesSeen(actionHash: string): number {
    return this.repeats.get(actionHash) ?? 0;
  }

  blockRepeat(actionHash: string): number {
    const seen = (this.blocked.get(actionHash) ?? 0) + 1;
    this.blocked.set(actionHash, seen);
    return seen;
  }

  private remember(actionHash: string): void {
    if (!this.repeats.has(actionHash)) {
      this.order.push(actionHash);
    }

    while (this.order.length > EXECUTE_LIMITS.recentActionsTracked) {
      const oldest = this.order.shift();

      if (oldest !== undefined) {
        this.failures.delete(oldest);
        this.repeats.delete(oldest);
      }
    }
  }
}

export function repeatNotice(tool: string, summary: string, seen: number): string {
  if (seen <= 1) {
    return `${tool}: ${summary}`;
  }

  return `${tool}: ${summary} (you have already asked for exactly this ${String(
    seen,
  )} times and the answer has not changed, so asking again tells you nothing. Do something else.)`;
}

export function countsAsFailure(result: ExecutionResult): boolean {
  if (result.status === 'approval_required') {
    return false;
  }
  return result.event.outcome !== 'ok';
}

export function applyExecution(state: AgentState, result: ExecutionResult): AgentState {
  let next = recordToolEvent(state, result.event);

  next = parseState({
    ...next,
    policy: result.policy,
    proposedAction: null,
    budgets: budgetsAfter(next.budgets, result),
  });

  if (result.check !== null) {
    next = recordCheck(next, result.check);
  }

  for (const path of result.paths) {
    next =
      result.status === 'executed' && WRITING_TOOLS.has(result.event.tool)
        ? recordFileChanged(next, path)
        : recordFileRead(next, path);
  }

  return parseState({ ...next, phase: phaseAfter(result) });
}

export function stopWith(state: AgentState, verdict: StopVerdict): AgentState {
  return stopped(state, verdict.reason ?? 'failed');
}

function budgetsAfter(budgets: AgentBudgets, result: ExecutionResult): AgentBudgets {
  const stepped = takeStep(budgets);

  if (countsAsFailure(result)) {
    return takeRetry(stepped);
  }

  if (result.status === 'approval_required') {
    return stepped;
  }
  return clearRetries(stepped);
}

function phaseAfter(result: ExecutionResult): AgentState['phase'] {
  if (result.status === 'approval_required') {
    return 'awaiting_approval';
  }

  if (result.pause === 'clarification' || result.pause === 'approval') {
    return 'clarifying';
  }

  if (result.check !== null) {
    return 'validating';
  }
  return 'reasoning';
}
