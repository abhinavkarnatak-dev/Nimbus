import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { FakeTextProvider } from './fake-text.js';
import { LlmError } from './errors.js';
import { RoutedTextProvider } from './routed-text.js';

const GEMINI_MODEL = 'gemini-3.6-flash';
const GEMINI_LIGHT = 'gemini-3.5-flash-lite';

function routing(): { gemini: FakeTextProvider; routed: RoutedTextProvider } {
  const gemini = new FakeTextProvider({ defaultModel: GEMINI_MODEL });

  return { gemini, routed: new RoutedTextProvider({ providers: [gemini] }) };
}

describe('RoutedTextProvider', () => {
  it('sends a model to the provider that serves it', async () => {
    const { gemini, routed } = routing();

    await routed.complete({ model: GEMINI_LIGHT, messages: [{ role: 'user', content: 'hello' }] });

    expect(gemini.callCount).toBe(1);
    expect(gemini.calls[0]?.model).toBe(GEMINI_LIGHT);
  });

  it('carries every model of one provider through the same seam', async () => {
    const { gemini, routed } = routing();

    await routed.complete({ model: GEMINI_MODEL, messages: [{ role: 'user', content: 'a' }] });
    await routed.complete({ model: GEMINI_LIGHT, messages: [{ role: 'user', content: 'b' }] });

    expect(gemini.calls[0]?.model).toBe(GEMINI_MODEL);
    expect(gemini.calls[1]?.model).toBe(GEMINI_LIGHT);
  });

  it('routes a structured call the same way as a plain one', async () => {
    const gemini = new FakeTextProvider({
      defaultModel: GEMINI_MODEL,
      answers: [{ value: { ok: true } }],
    });
    const routed = new RoutedTextProvider({ providers: [gemini] });

    const result = await routed.completeStructured({
      model: GEMINI_LIGHT,
      schema: z.strictObject({ ok: z.boolean() }),
      schemaName: 'answer',
      messages: [{ role: 'user', content: 'a' }],
    });

    expect(result.value.ok).toBe(true);
    expect(gemini.callCount).toBe(1);
  });

  it('falls back to its default model when a call names none', async () => {
    const { gemini, routed } = routing();

    await routed.complete({ messages: [{ role: 'user', content: 'hello' }] });

    expect(routed.defaultModel).toBe(GEMINI_MODEL);
    expect(gemini.callCount).toBe(1);
  });

  it('refuses a model this build does not know about', async () => {
    const { routed } = routing();

    await expect(
      routed.complete({ model: 'gpt-9', messages: [{ role: 'user', content: 'a' }] }),
    ).rejects.toThrow(LlmError);
  });

  it('refuses to be built with no provider at all', () => {
    expect(() => new RoutedTextProvider({ providers: [] })).toThrow(LlmError);
  });

  it('is only real when every provider behind it is real', () => {
    const { routed } = routing();

    expect(routed.real).toBe(false);
  });
});
