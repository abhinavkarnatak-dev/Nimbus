import { describe, expect, it } from 'vitest';

import { SessionBudget } from '../../llm/budget.js';
import { buildReport } from '../../llm/provider.js';
import {
  assertRoom,
  clearRetries,
  hasRoom,
  newBudgets,
  remainingMs,
  resumeLlmBudget,
  shortfall,
  takeRetry,
  takeStep,
} from './budgets.js';
import { STATE_LIMITS } from './limits.js';

const START = 1_755_180_000_000;

function budgets(overrides: Parameters<typeof newBudgets>[0] = {}) {
  return newBudgets({ startedAtMs: START, ...overrides });
}

function spend(tokens: number): SessionBudget {
  const budget = new SessionBudget();
  budget.charge(
    buildReport({
      provider: 'groq',
      model: 'openai/gpt-oss-120b',
      usage: {
        promptTokens: tokens,
        completionTokens: 0,
        reasoningTokens: 0,
        totalTokens: tokens,
      },
      attempts: 1,
      durationMs: 1,
    }),
  );
  return budget;
}

describe('newBudgets', () => {
  it('starts with nothing spent', () => {
    const fresh = budgets();

    expect(fresh.steps).toBe(0);
    expect(fresh.retries).toBe(0);
    expect(fresh.maxSteps).toBe(STATE_LIMITS.maxSteps);
    expect(fresh.llm.tokensUsed).toBe(0);
  });

  it('takes limits it is given', () => {
    const fresh = budgets({ maxSteps: 5, maxRetries: 2, maxDurationMs: 1_000 });

    expect(fresh.maxSteps).toBe(5);
    expect(fresh.maxRetries).toBe(2);
    expect(fresh.maxDurationMs).toBe(1_000);
  });
});

describe('shortfall', () => {
  it('finds nothing wrong with a fresh session', () => {
    expect(shortfall(budgets(), START)).toBeNull();
    expect(hasRoom(budgets(), START)).toBe(true);
  });

  it('names the step budget', () => {
    const spent = { ...budgets({ maxSteps: 2 }), steps: 2 };

    expect(shortfall(spent, START)?.reason).toBe('step_budget');
    expect(shortfall(spent, START)?.detail).toContain('2 of 2');
  });

  it('names the retry budget', () => {
    const spent = { ...budgets({ maxRetries: 3 }), retries: 3 };
    expect(shortfall(spent, START)?.reason).toBe('retry_budget');
  });

  it('names the time budget', () => {
    const spent = budgets({ maxDurationMs: 1_000 });
    expect(shortfall(spent, START + 1_000)?.reason).toBe('time_budget');
    expect(shortfall(spent, START + 999)).toBeNull();
  });

  it('names the token budget', () => {
    const spent = budgets({ llm: spend(400_000) });
    expect(shortfall(spent, START)?.reason).toBe('token_budget');
  });

  it('reports the first budget to run out, so the message is definite', () => {
    const spent = { ...budgets({ maxSteps: 1, maxRetries: 1 }), steps: 1, retries: 1 };
    expect(shortfall(spent, START)?.reason).toBe('step_budget');
  });
});

describe('assertRoom', () => {
  it('says nothing when there is room', () => {
    expect(() => {
      assertRoom(budgets(), START);
    }).not.toThrow();
  });

  it('stops and says which budget it was', () => {
    const spent = { ...budgets({ maxSteps: 1 }), steps: 1 };
    let detail = '';

    try {
      assertRoom(spent, START);
    } catch (error) {
      detail = (error as { detail: string }).detail;
    }

    expect(detail).toContain('step_budget');
  });

  it('raises the same named failure whichever budget ran out', () => {
    const spent = { ...budgets({ maxRetries: 1 }), retries: 1 };

    expect(() => {
      assertRoom(spent, START);
    }).toThrow(expect.objectContaining({ code: 'BUDGET_EXHAUSTED' }) as Error);
  });
});

describe('spending', () => {
  it('counts a step', () => {
    expect(takeStep(budgets()).steps).toBe(1);
  });

  it('counts a retry', () => {
    expect(takeRetry(budgets()).retries).toBe(1);
  });

  it('forgets retries once something worked', () => {
    expect(clearRetries(takeRetry(takeRetry(budgets()))).retries).toBe(0);
  });

  it('never changes the budget it was given', () => {
    const before = budgets();
    takeStep(before);
    expect(before.steps).toBe(0);
  });

  it('reports the time left', () => {
    expect(remainingMs(budgets({ maxDurationMs: 1_000 }), START + 400)).toBe(600);
  });

  it('never reports negative time left', () => {
    expect(remainingMs(budgets({ maxDurationMs: 1_000 }), START + 5_000)).toBe(0);
  });
});

describe('resumeLlmBudget', () => {
  it('brings back what was already spent, rather than starting over', () => {
    const spent = budgets({ llm: spend(1_000) });
    const resumed = resumeLlmBudget(spent);

    expect(resumed.state().tokensUsed).toBe(1_000);
    expect(resumed.state().calls).toBe(1);
  });

  it('keeps the limits the session began with', () => {
    const resumed = resumeLlmBudget(budgets({ llm: new SessionBudget({ tokenLimit: 5_000 }) }));
    expect(resumed.state().tokenLimit).toBe(5_000);
  });

  it('stays exhausted across a resume', () => {
    const spent = budgets({ llm: spend(400_000) });
    expect(resumeLlmBudget(spent).state().exhausted).toBe(true);
  });

  it('carries the stored limits through, so they cannot drift', () => {
    const spent = budgets({ llm: new SessionBudget({ tokenLimit: 5_000, callLimit: 9 }) });
    const resumed = resumeLlmBudget(spent);

    expect(resumed.state().tokenLimit).toBe(spent.llm.tokenLimit);
    expect(resumed.state().callLimit).toBe(spent.llm.callLimit);
  });
});

describe('SessionBudget.restore', () => {
  it('refuses a record kept under different limits', () => {
    const budget = new SessionBudget({ tokenLimit: 1_000 });
    const foreign = new SessionBudget({ tokenLimit: 9_999 }).state();

    expect(() => {
      budget.restore(foreign);
    }).toThrow(expect.objectContaining({ code: 'LLM_REQUEST_INVALID' }) as Error);
  });

  it('brings back spending under matching limits', () => {
    const original = spend(1_000);
    const budget = new SessionBudget();
    budget.restore(original.state());

    expect(budget.state().tokensUsed).toBe(1_000);
  });
});
