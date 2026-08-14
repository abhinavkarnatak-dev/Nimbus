import type { AgentBudgets, AgentStopReason } from '@nimbus/contracts';

import { SessionBudget } from '../../llm/budget.js';
import { AgentStateError } from './errors.js';
import { STATE_LIMITS } from './limits.js';

export interface BudgetShortfall {
  reason: AgentStopReason;
  detail: string;
}

export interface NewBudgetOptions {
  maxSteps?: number;
  maxRetries?: number;
  maxDurationMs?: number;
  startedAtMs?: number;
  llm?: SessionBudget;
}

export function newBudgets(options: NewBudgetOptions = {}): AgentBudgets {
  return {
    steps: 0,
    maxSteps: options.maxSteps ?? STATE_LIMITS.maxSteps,
    retries: 0,
    maxRetries: options.maxRetries ?? STATE_LIMITS.maxRetries,
    startedAtMs: options.startedAtMs ?? Date.now(),
    maxDurationMs: options.maxDurationMs ?? STATE_LIMITS.maxDurationMs,
    llm: (options.llm ?? new SessionBudget()).state(),
  };
}

export function shortfall(budgets: AgentBudgets, nowMs: number): BudgetShortfall | null {
  if (budgets.steps >= budgets.maxSteps) {
    return {
      reason: 'step_budget',
      detail: `${String(budgets.steps)} of ${String(budgets.maxSteps)} steps`,
    };
  }

  if (budgets.retries >= budgets.maxRetries) {
    return {
      reason: 'retry_budget',
      detail: `${String(budgets.retries)} of ${String(budgets.maxRetries)} retries`,
    };
  }

  if (nowMs - budgets.startedAtMs >= budgets.maxDurationMs) {
    return {
      reason: 'time_budget',
      detail: `${String(Math.round((nowMs - budgets.startedAtMs) / 1000))} seconds`,
    };
  }

  if (budgets.llm.exhausted) {
    return { reason: 'token_budget', detail: `${String(budgets.llm.tokensUsed)} tokens` };
  }
  return null;
}

export function hasRoom(budgets: AgentBudgets, nowMs: number = Date.now()): boolean {
  return shortfall(budgets, nowMs) === null;
}

export function assertRoom(budgets: AgentBudgets, nowMs: number = Date.now()): void {
  const found = shortfall(budgets, nowMs);

  if (found !== null) {
    throw new AgentStateError(
      'BUDGET_EXHAUSTED',
      'This session has run out of what it was given.',
      {
        detail: `${found.reason}: ${found.detail}`,
      },
    );
  }
}

export function takeStep(budgets: AgentBudgets): AgentBudgets {
  return { ...budgets, steps: budgets.steps + 1 };
}

export function takeRetry(budgets: AgentBudgets): AgentBudgets {
  return { ...budgets, retries: budgets.retries + 1 };
}

export function clearRetries(budgets: AgentBudgets): AgentBudgets {
  return { ...budgets, retries: 0 };
}

export function remainingMs(budgets: AgentBudgets, nowMs: number = Date.now()): number {
  return Math.max(budgets.startedAtMs + budgets.maxDurationMs - nowMs, 0);
}

export function resumeLlmBudget(budgets: AgentBudgets): SessionBudget {
  const budget = new SessionBudget({
    tokenLimit: budgets.llm.tokenLimit,
    microCentLimit: budgets.llm.microCentLimit,
    callLimit: budgets.llm.callLimit,
  });

  budget.restore(budgets.llm);
  return budget;
}
