import { describe, expect, it } from 'vitest';

import { SessionBudget } from '../llm/budget.js';
import { LlmError } from '../llm/errors.js';
import { FakeTextProvider } from '../llm/fake-text.js';
import { AnswerSchema, GOOD_ANSWER, capturingLogger } from '../llm/llm.fixtures.js';
import { DEFAULT_LIGHT_MODEL, DEFAULT_REASONING_MODEL, DEFAULT_TEXT_MODEL } from '../llm/models.js';
import { SessionRouter, type SessionRouterOptions } from './router.js';

const ASK = [{ role: 'user' as const, content: 'where is the router' }];

type RouterOverrides = Omit<Partial<SessionRouterOptions>, 'text'> & { text?: FakeTextProvider };

function router(overrides: RouterOverrides = {}): {
  session: SessionRouter;
  text: FakeTextProvider;
  logs: () => string;
} {
  const captured = capturingLogger();
  const text = overrides.text ?? new FakeTextProvider();

  return {
    session: new SessionRouter({ text, logger: captured.logger, ...overrides }),
    text,
    logs: captured.text,
  };
}

describe('SessionRouter', () => {
  it('uses the default model when the user chose nothing', async () => {
    const { session, text } = router();

    await session.complete({ messages: ASK });

    expect(text.calls[0]?.model).toBe(DEFAULT_TEXT_MODEL);
    expect(session.plan.chosenByUser).toBe(false);
  });

  it('uses what the user chose', async () => {
    const { session, text } = router({ selection: { textModel: 'openai/gpt-oss-120b' } });

    await session.complete({ messages: ASK });

    expect(text.calls[0]?.model).toBe('openai/gpt-oss-120b');
  });

  it('takes a whole plan, so a resumed session keeps the models it started with', async () => {
    const plan = {
      primary: 'openai/gpt-oss-120b',
      light: 'openai/gpt-oss-20b',
      reasoning: DEFAULT_REASONING_MODEL,
      vision: DEFAULT_TEXT_MODEL,
      chosenByUser: true,
    };
    const { session, text } = router({ plan });

    await session.complete({ messages: ASK, role: 'light' });

    expect(session.plan).toEqual(plan);
    expect(text.calls[0]?.model).toBe('openai/gpt-oss-20b');
  });

  it('prefers the plan it was given over working one out from a choice', () => {
    const plan = {
      primary: 'openai/gpt-oss-120b',
      light: 'openai/gpt-oss-20b',
      reasoning: DEFAULT_REASONING_MODEL,
      vision: DEFAULT_TEXT_MODEL,
      chosenByUser: true,
    };
    const { session } = router({ plan, selection: { textModel: DEFAULT_TEXT_MODEL } });

    expect(session.modelFor('primary')).toBe('openai/gpt-oss-120b');
  });

  it('refuses a model the user may not choose, before anything is asked', () => {
    expect(() => router({ selection: { textModel: 'gpt-9-ultra' } })).toThrow(
      expect.objectContaining({ code: 'LLM_MODEL_UNKNOWN' }) as Error,
    );
  });

  it('sends a light job to the light model, whatever the user chose', async () => {
    const { session, text } = router({ selection: { textModel: 'openai/gpt-oss-120b' } });

    await session.complete({ messages: ASK, role: 'light' });

    expect(text.calls[0]?.model).toBe(DEFAULT_LIGHT_MODEL);
  });

  it('sends a hard job to the reasoning model', async () => {
    const { session, text } = router({ selection: { textModel: 'llama-3.3-70b-versatile' } });

    await session.complete({ messages: ASK, role: 'reasoning' });

    expect(text.calls[0]?.model).toBe(DEFAULT_REASONING_MODEL);
  });

  it('names a model for every role', () => {
    const { session } = router();

    expect(session.modelFor('primary')).toBe(DEFAULT_TEXT_MODEL);
    expect(session.modelFor('light')).toBe(DEFAULT_LIGHT_MODEL);
    expect(session.modelFor('reasoning')).toBe(DEFAULT_REASONING_MODEL);
    expect(session.modelFor()).toBe(DEFAULT_TEXT_MODEL);
  });

  it('charges the session for what it spent', async () => {
    const text = new FakeTextProvider({
      answers: [{ usage: { promptTokens: 100, completionTokens: 40 } }],
    });
    const { session } = router({ text });

    const before = session.budgetState();
    await session.complete({ messages: ASK });
    const after = session.budgetState();

    expect(before.calls).toBe(0);
    expect(after.calls).toBe(1);
    expect(after.tokensUsed).toBe(140);
    expect(after.microCentsUsed).toBeGreaterThan(0);
  });

  it('charges structured calls too', async () => {
    const text = new FakeTextProvider({ answers: [{ value: GOOD_ANSWER }] });
    const { session } = router({ text });

    const result = await session.completeStructured({
      messages: ASK,
      schema: AnswerSchema,
      schemaName: 'answer',
    });

    expect(result.value).toEqual(GOOD_ANSWER);
    expect(session.budgetState().calls).toBe(1);
  });

  it('refuses a call once the session has spent its tokens', async () => {
    const text = new FakeTextProvider({
      answers: [{ usage: { promptTokens: 100, completionTokens: 40 } }],
    });
    const { session } = router({ text, budgetLimits: { tokenLimit: 100 } });

    await session.complete({ messages: ASK });

    await expect(session.complete({ messages: ASK })).rejects.toThrow(
      expect.objectContaining({ code: 'LLM_BUDGET_EXCEEDED' }) as Error,
    );
  });

  it('refuses the call before it is sent, not after', async () => {
    const text = new FakeTextProvider({
      answers: [{ usage: { promptTokens: 100, completionTokens: 40 } }],
    });
    const { session } = router({ text, budgetLimits: { callLimit: 1 } });

    await session.complete({ messages: ASK });
    await session.complete({ messages: ASK }).catch(() => undefined);

    expect(text.callCount).toBe(1);
  });

  it('stays usable for reporting after it has stopped', async () => {
    const { session } = router({ budgetLimits: { callLimit: 1 } });

    await session.complete({ messages: ASK });
    await session.complete({ messages: ASK }).catch(() => undefined);

    expect(session.budgetState().exhausted).toBe(true);
    expect(session.budgetState().calls).toBe(1);
  });

  it('can share a budget that already has spending on it', async () => {
    const budget = new SessionBudget({ callLimit: 2 });
    const { session } = router({ budget });

    await session.complete({ messages: ASK });

    expect(budget.state().calls).toBe(1);
    expect(session.budgetState().calls).toBe(1);
  });

  it('lets a caller ask whether there is room before doing work', () => {
    const { session } = router({ budgetLimits: { tokenLimit: 1_000 } });

    expect(() => {
      session.assertCanSpend(100);
    }).not.toThrow();
    expect(() => {
      session.assertCanSpend(2_000);
    }).toThrow(expect.objectContaining({ code: 'LLM_BUDGET_EXCEEDED' }) as Error);
  });

  it('lets a caller charge for work another provider did, such as a description', () => {
    const { session } = router();

    const state = session.charge({
      provider: 'gemini',
      model: 'gemini-3.6-flash',
      usage: {
        promptTokens: 1_208,
        completionTokens: 30,
        reasoningTokens: 236,
        totalTokens: 1_474,
      },
      cost: { microCents: 102_800, estimated: true },
      attempts: 1,
      durationMs: 900,
    });

    expect(state.calls).toBe(1);
    expect(state.tokensUsed).toBe(1_474);
  });

  it('passes a failure through rather than hiding it', async () => {
    const text = new FakeTextProvider({
      answers: [{ fails: new LlmError('LLM_RATE_LIMITED', 'slow down') }],
    });
    const { session } = router({ text });

    await expect(session.complete({ messages: ASK })).rejects.toThrow(
      expect.objectContaining({ code: 'LLM_RATE_LIMITED' }) as Error,
    );
  });

  it('never puts the conversation in the logs', async () => {
    const { session, logs } = router();

    await session.complete({
      messages: [{ role: 'user', content: 'the elephant walked into the compiler' }],
    });

    expect(logs()).not.toContain('elephant');
  });

  it('does record the model and what it cost', async () => {
    const { session, logs } = router();

    await session.complete({ messages: ASK });

    expect(logs()).toContain(DEFAULT_TEXT_MODEL);
    expect(logs()).toContain('microCents');
  });
});
