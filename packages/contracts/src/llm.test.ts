import { describe, expect, it } from 'vitest';

import {
  BudgetStateSchema,
  CallReportSchema,
  LLM_PROVIDERS,
  ModelIdSchema,
  TokenUsageSchema,
} from './llm.js';

const usage = { promptTokens: 100, completionTokens: 40, reasoningTokens: 5, totalTokens: 145 };

const report = {
  provider: 'groq',
  model: 'openai/gpt-oss-120b',
  usage,
  cost: { microCents: 9_058, estimated: true },
  attempts: 1,
  durationMs: 412,
};

describe('ModelIdSchema', () => {
  it.each([
    ['a plain name, from a provider this build does not ship', 'mistral-large'],
    ['a namespaced name', 'openai/gpt-oss-120b'],
    ['a dotted name', 'gemini-3.5-flash'],
  ])('accepts %s', (_label, id) => {
    expect(ModelIdSchema.safeParse(id).success).toBe(true);
  });

  it.each([
    ['an empty name', ''],
    ['a name with a space', 'gpt 4'],
    ['a name with a quote', "model'; drop"],
    ['a name that is far too long', 'x'.repeat(200)],
  ])('refuses %s', (_label, id) => {
    expect(ModelIdSchema.safeParse(id).success).toBe(false);
  });
});

describe('TokenUsageSchema', () => {
  it('accepts a full count', () => {
    expect(TokenUsageSchema.safeParse(usage).success).toBe(true);
  });

  it('refuses a negative count', () => {
    expect(TokenUsageSchema.safeParse({ ...usage, promptTokens: -1 }).success).toBe(false);
  });

  it('refuses a fractional count', () => {
    expect(TokenUsageSchema.safeParse({ ...usage, promptTokens: 1.5 }).success).toBe(false);
  });

  it('refuses an extra field', () => {
    expect(TokenUsageSchema.safeParse({ ...usage, cached: 3 }).success).toBe(false);
  });

  it('requires reasoning tokens to be counted, not left out', () => {
    const { reasoningTokens: _dropped, ...rest } = usage;
    expect(TokenUsageSchema.safeParse(rest).success).toBe(false);
  });
});

describe('CallReportSchema', () => {
  it('accepts a report', () => {
    expect(CallReportSchema.safeParse(report).success).toBe(true);
  });

  it('knows both providers and nothing else', () => {
    expect([...LLM_PROVIDERS].sort()).toEqual(['gemini', 'groq']);
    expect(CallReportSchema.safeParse({ ...report, provider: 'openai' }).success).toBe(false);
  });

  it('refuses a report with no attempt', () => {
    expect(CallReportSchema.safeParse({ ...report, attempts: 0 }).success).toBe(false);
  });
});

describe('BudgetStateSchema', () => {
  const state = {
    tokensUsed: 2_000,
    tokenLimit: 400_000,
    microCentsUsed: 1_000,
    microCentLimit: 50_000_000,
    calls: 3,
    callLimit: 60,
    exhausted: false,
  };

  it('accepts a state', () => {
    expect(BudgetStateSchema.safeParse(state).success).toBe(true);
  });

  it('refuses a limit of nothing', () => {
    expect(BudgetStateSchema.safeParse({ ...state, tokenLimit: 0 }).success).toBe(false);
  });

  it('refuses an extra field', () => {
    expect(BudgetStateSchema.safeParse({ ...state, remaining: 5 }).success).toBe(false);
  });
});
