import type { CallReport } from '@nimbus/contracts';
import { describe, expect, it } from 'vitest';

import { SessionBudget, defaultBudgetLimits } from './budget.js';
import { LLM_LIMITS } from './limits.js';
import { highestInputRate, highestOutputRate, ratesFor } from './models.js';
import { buildReport } from './provider.js';

function report(model: string, prompt: number, completion: number, reasoning = 0): CallReport {
  return buildReport({
    provider: 'groq',
    model,
    usage: {
      promptTokens: prompt,
      completionTokens: completion,
      reasoningTokens: reasoning,
      totalTokens: prompt + completion + reasoning,
    },
    attempts: 1,
    durationMs: 10,
  });
}

describe('defaultBudgetLimits', () => {
  it('comes from the limits file', () => {
    expect(defaultBudgetLimits()).toEqual({
      tokenLimit: LLM_LIMITS.sessionTokenLimit,
      microCentLimit: LLM_LIMITS.sessionMicroCentLimit,
      callLimit: LLM_LIMITS.sessionCallLimit,
    });
  });
});

describe('SessionBudget', () => {
  it('starts with nothing spent', () => {
    const state = new SessionBudget().state();

    expect(state.tokensUsed).toBe(0);
    expect(state.microCentsUsed).toBe(0);
    expect(state.calls).toBe(0);
    expect(state.exhausted).toBe(false);
  });

  it('refuses a limit that is not usable', () => {
    expect(() => new SessionBudget({ tokenLimit: 0 })).toThrow(
      expect.objectContaining({ code: 'LLM_REQUEST_INVALID' }) as Error,
    );
    expect(() => new SessionBudget({ callLimit: -1 })).toThrow(
      expect.objectContaining({ code: 'LLM_REQUEST_INVALID' }) as Error,
    );
  });

  it('charges tokens and money together', () => {
    const budget = new SessionBudget();
    const state = budget.charge(report('openai/gpt-oss-120b', 100, 40));

    const rates = ratesFor('openai/gpt-oss-120b');

    expect(state.tokensUsed).toBe(140);
    expect(state.microCentsUsed).toBe(100 * rates.input + 40 * rates.output);
    expect(state.calls).toBe(1);
  });

  it('charges reasoning tokens at the output rate', () => {
    const budget = new SessionBudget();
    const plain = budget.charge(report('openai/gpt-oss-120b', 0, 100));

    const other = new SessionBudget();
    const thinking = other.charge(report('openai/gpt-oss-120b', 0, 50, 50));

    expect(thinking.microCentsUsed).toBe(plain.microCentsUsed);
  });

  it('stops a session that has spent its tokens', () => {
    const budget = new SessionBudget({ tokenLimit: 100 });
    budget.charge(report('openai/gpt-oss-120b', 60, 40));

    expect(budget.state().exhausted).toBe(true);
    expect(() => {
      budget.assertCanSpend();
    }).toThrow(expect.objectContaining({ code: 'LLM_BUDGET_EXCEEDED' }) as Error);
  });

  it('stops a session that has spent its money', () => {
    const budget = new SessionBudget({ microCentLimit: 1_000 });
    budget.charge(report('openai/gpt-oss-120b', 100, 40));

    expect(() => {
      budget.assertCanSpend();
    }).toThrow(expect.objectContaining({ code: 'LLM_BUDGET_EXCEEDED' }) as Error);
  });

  it('stops a session that has made too many calls', () => {
    const budget = new SessionBudget({ callLimit: 2 });
    budget.charge(report('openai/gpt-oss-120b', 1, 1));
    budget.charge(report('openai/gpt-oss-120b', 1, 1));

    expect(() => {
      budget.assertCanSpend();
    }).toThrow(expect.objectContaining({ code: 'LLM_BUDGET_EXCEEDED' }) as Error);
  });

  it('refuses a call it can see will not fit, rather than starting it', () => {
    const budget = new SessionBudget({ tokenLimit: 1_000 });
    budget.charge(report('openai/gpt-oss-120b', 400, 100));

    expect(() => {
      budget.assertCanSpend(100);
    }).not.toThrow();
    expect(() => {
      budget.assertCanSpend(600);
    }).toThrow(expect.objectContaining({ code: 'LLM_BUDGET_EXCEEDED' }) as Error);
  });

  it('never charges an unknown model nothing', () => {
    const known = new SessionBudget();
    known.charge(report('openai/gpt-oss-120b', 1_000, 1_000));

    const unknown = new SessionBudget();
    unknown.charge(report('some-model-nobody-priced', 1_000, 1_000));

    expect(unknown.state().microCentsUsed).toBeGreaterThan(known.state().microCentsUsed);
  });

  it('charges an unknown model the highest rate it knows', () => {
    const budget = new SessionBudget();
    const state = budget.charge(report('some-model-nobody-priced', 1, 1));

    expect(state.microCentsUsed).toBe(highestInputRate() + highestOutputRate());
  });

  it('reports how many tokens are left', () => {
    const budget = new SessionBudget({ tokenLimit: 1_000 });
    budget.charge(report('openai/gpt-oss-120b', 300, 100));

    expect(budget.remainingTokens()).toBe(600);
  });

  it('never reports a negative remainder', () => {
    const budget = new SessionBudget({ tokenLimit: 10 });
    budget.charge(report('openai/gpt-oss-120b', 100, 100));

    expect(budget.remainingTokens()).toBe(0);
  });

  it('always says its cost is an estimate', () => {
    expect(report('openai/gpt-oss-120b', 1, 1).cost.estimated).toBe(true);
  });
});
