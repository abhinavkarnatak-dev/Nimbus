import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { FakeTextProvider } from './fake-text.js';
import { LlmError } from './errors.js';
import { RoutedTextProvider } from './routed-text.js';

const GEMINI_MODEL = 'gemini-3.6-flash';
const GEMINI_LIGHT = 'gemini-3.5-flash-lite';
const GROQ_MODEL = 'openai/gpt-oss-120b';

function pair(): { gemini: FakeTextProvider; groq: FakeTextProvider; routed: RoutedTextProvider } {
  const gemini = new FakeTextProvider({ defaultModel: GEMINI_MODEL });
  const groq = new FakeTextProvider({ defaultModel: GROQ_MODEL });

  return { gemini, groq, routed: new RoutedTextProvider({ providers: [gemini, groq] }) };
}

describe('RoutedTextProvider', () => {
  it('sends a model to the provider that serves it', async () => {
    const { gemini, groq, routed } = pair();

    await routed.complete({ model: GROQ_MODEL, messages: [{ role: 'user', content: 'hello' }] });

    expect(groq.callCount).toBe(1);
    expect(gemini.callCount).toBe(0);
  });

  it('splits one session across two providers, which is why it exists', async () => {
    const { gemini, groq, routed } = pair();

    await routed.complete({ model: GROQ_MODEL, messages: [{ role: 'user', content: 'a' }] });
    await routed.complete({ model: GEMINI_LIGHT, messages: [{ role: 'user', content: 'b' }] });

    expect(groq.calls[0]?.model).toBe(GROQ_MODEL);
    expect(gemini.calls[0]?.model).toBe(GEMINI_LIGHT);
  });

  it('routes a structured call the same way as a plain one', async () => {
    const gemini = new FakeTextProvider({ defaultModel: GEMINI_MODEL });
    const groq = new FakeTextProvider({
      defaultModel: GROQ_MODEL,
      answers: [{ value: { ok: true } }],
    });
    const routed = new RoutedTextProvider({ providers: [gemini, groq] });

    const result = await routed.completeStructured({
      model: GROQ_MODEL,
      schema: z.strictObject({ ok: z.boolean() }),
      schemaName: 'answer',
      messages: [{ role: 'user', content: 'a' }],
    });

    expect(result.value.ok).toBe(true);
    expect(groq.callCount).toBe(1);
    expect(gemini.callCount).toBe(0);
  });

  it('falls back to its default model when a call names none', async () => {
    const { gemini, routed } = pair();

    await routed.complete({ messages: [{ role: 'user', content: 'hello' }] });

    expect(routed.defaultModel).toBe(GEMINI_MODEL);
    expect(gemini.callCount).toBe(1);
  });

  it('refuses a model this build does not know about', async () => {
    const { routed } = pair();

    await expect(
      routed.complete({ model: 'gpt-9', messages: [{ role: 'user', content: 'a' }] }),
    ).rejects.toThrow(LlmError);
  });

  it('says which provider is missing when a known model has none', async () => {
    const gemini = new FakeTextProvider({ defaultModel: GEMINI_MODEL });
    const routed = new RoutedTextProvider({ providers: [gemini] });

    await expect(
      routed.complete({ model: GROQ_MODEL, messages: [{ role: 'user', content: 'a' }] }),
    ).rejects.toMatchObject({ code: 'LLM_UNAVAILABLE', detail: `${GROQ_MODEL} needs groq` });
  });

  it('refuses to be built with no provider at all', () => {
    expect(() => new RoutedTextProvider({ providers: [] })).toThrow(LlmError);
  });

  it('is only real when every provider behind it is real', () => {
    const { routed } = pair();

    expect(routed.real).toBe(false);
  });
});
