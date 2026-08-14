import type { BudgetState, CallReport } from '@nimbus/contracts';

import { LlmError } from './errors.js';
import { LLM_LIMITS } from './limits.js';

export interface BudgetLimits {
  tokenLimit: number;
  microCentLimit: number;
  callLimit: number;
}

export function defaultBudgetLimits(): BudgetLimits {
  return {
    tokenLimit: LLM_LIMITS.sessionTokenLimit,
    microCentLimit: LLM_LIMITS.sessionMicroCentLimit,
    callLimit: LLM_LIMITS.sessionCallLimit,
  };
}

export class SessionBudget {
  private readonly limits: BudgetLimits;

  private tokensUsed = 0;

  private microCentsUsed = 0;

  private calls = 0;

  constructor(limits: Partial<BudgetLimits> = {}) {
    const defaults = defaultBudgetLimits();
    this.limits = {
      tokenLimit: limits.tokenLimit ?? defaults.tokenLimit,
      microCentLimit: limits.microCentLimit ?? defaults.microCentLimit,
      callLimit: limits.callLimit ?? defaults.callLimit,
    };

    for (const [name, value] of Object.entries(this.limits)) {
      if (!Number.isInteger(value) || value < 1) {
        throw new LlmError('LLM_REQUEST_INVALID', `That ${name} is not usable.`);
      }
    }
  }

  state(): BudgetState {
    return {
      tokensUsed: this.tokensUsed,
      tokenLimit: this.limits.tokenLimit,
      microCentsUsed: this.microCentsUsed,
      microCentLimit: this.limits.microCentLimit,
      calls: this.calls,
      callLimit: this.limits.callLimit,
      exhausted: this.exhausted(),
    };
  }

  exhausted(): boolean {
    return (
      this.tokensUsed >= this.limits.tokenLimit ||
      this.microCentsUsed >= this.limits.microCentLimit ||
      this.calls >= this.limits.callLimit
    );
  }

  remainingTokens(): number {
    return Math.max(this.limits.tokenLimit - this.tokensUsed, 0);
  }

  assertCanSpend(estimatedTokens = 0): void {
    if (this.calls >= this.limits.callLimit) {
      throw new LlmError(
        'LLM_BUDGET_EXCEEDED',
        'This session has made as many model calls as it is allowed.',
      );
    }

    if (this.microCentsUsed >= this.limits.microCentLimit) {
      throw new LlmError('LLM_BUDGET_EXCEEDED', 'This session has spent what it is allowed.');
    }

    if (this.tokensUsed + Math.max(estimatedTokens, 0) >= this.limits.tokenLimit) {
      throw new LlmError(
        'LLM_BUDGET_EXCEEDED',
        'This session has used all the words it is allowed.',
      );
    }
  }

  charge(report: CallReport): BudgetState {
    this.tokensUsed += report.usage.totalTokens;
    this.microCentsUsed += report.cost.microCents;
    this.calls += 1;
    return this.state();
  }
}
