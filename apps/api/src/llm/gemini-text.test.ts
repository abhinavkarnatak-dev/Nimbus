import { afterEach, describe, expect, it } from 'vitest';

import type { LlmError } from './errors.js';
import { GeminiTextProvider, outputBudget, thinkingBudget, toGeminiParts } from './gemini-text.js';
import { LLM_LIMITS } from './limits.js';
import {
  ANSWER_JSON_SCHEMA,
  AnswerSchema,
  GOOD_ANSWER,
  PRIVATE_PROMPT,
  SECRET_PHRASE,
  capturingLogger,
  geminiReply,
  stubFetch,
  type FetchStub,
} from './llm.fixtures.js';

let stub: FetchStub | null = null;

afterEach(() => {
  stub?.restore();
  stub = null;
});

const ASK = [{ role: 'user' as const, content: 'where is the router' }];

function provider(overrides: Record<string, unknown> = {}): {
  text: GeminiTextProvider;
  logs: () => string;
} {
  const captured = capturingLogger();

  return {
    text: new GeminiTextProvider({
      apiKey: 'AIzaNotARealKeyAtAllJustForTesting123',
      logger: captured.logger,
      random: () => 0,
      ...overrides,
    }),
    logs: captured.text,
  };
}

describe('toGeminiParts', () => {
  it('lifts system messages into a system instruction', () => {
    const parts = toGeminiParts([
      { role: 'system', content: 'be brief' },
      { role: 'user', content: 'hello' },
    ]);

    expect(parts.systemInstruction?.parts[0]?.text).toBe('be brief');
    expect(parts.contents).toEqual([{ role: 'user', parts: [{ text: 'hello' }] }]);
  });

  it('joins several system messages into one', () => {
    const parts = toGeminiParts([
      { role: 'system', content: 'first' },
      { role: 'system', content: 'second' },
      { role: 'user', content: 'hello' },
    ]);

    expect(parts.systemInstruction?.parts[0]?.text).toBe('first\n\nsecond');
  });

  it('renames assistant to model, which is what Gemini calls it', () => {
    const parts = toGeminiParts([
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b' },
      { role: 'user', content: 'c' },
    ]);

    expect(parts.contents.map((one) => one.role)).toEqual(['user', 'model', 'user']);
  });

  it('merges two messages in a row from the same speaker', () => {
    const parts = toGeminiParts([
      { role: 'user', content: 'a' },
      { role: 'user', content: 'b' },
    ]);

    expect(parts.contents).toHaveLength(1);
    expect(parts.contents[0]?.parts).toEqual([{ text: 'a' }, { text: 'b' }]);
  });

  it('sends no system instruction when there is none', () => {
    expect(toGeminiParts(ASK).systemInstruction).toBeNull();
  });

  it('refuses a conversation that is only system messages', () => {
    expect(() => toGeminiParts([{ role: 'system', content: 'be brief' }])).toThrow(
      expect.objectContaining({ code: 'LLM_REQUEST_INVALID' }) as Error,
    );
  });
});

describe('outputBudget', () => {
  it('adds room for thinking, because thinking cannot be switched off', () => {
    expect(outputBudget(300, 'gemini-3.6-flash')).toBe(300 + LLM_LIMITS.geminiThinkingHeadroom);
  });

  it('adds nothing for a model that does not think', () => {
    expect(outputBudget(300, 'gemini-3.5-flash-lite')).toBe(300);
  });

  it('adds room for a model it has never heard of', () => {
    expect(outputBudget(300, 'some-new-model')).toBe(300 + LLM_LIMITS.geminiThinkingHeadroom);
  });

  it('has a default of its own', () => {
    expect(outputBudget(undefined, 'gemini-3.5-flash-lite')).toBe(LLM_LIMITS.maxOutputTokens);
  });
});

describe('thinkingBudget', () => {
  it('caps thinking at the same room the budget added for it', () => {
    expect(thinkingBudget('gemini-3.6-flash')).toBe(LLM_LIMITS.geminiThinkingHeadroom);
  });

  it('leaves the room asked for untouched, which is the whole point of capping', () => {
    const asked = 1_500;
    const total = outputBudget(asked, 'gemini-3.6-flash');

    expect(total - (thinkingBudget('gemini-3.6-flash') ?? 0)).toBe(asked);
  });

  it('caps nothing on a model that does not think', () => {
    expect(thinkingBudget('gemini-3.5-flash-lite')).toBeNull();
  });

  it('caps a model it has never heard of, because it may well think', () => {
    expect(thinkingBudget('some-new-model')).toBe(LLM_LIMITS.geminiThinkingHeadroom);
  });
});

describe('what the request asks Gemini for', () => {
  it('caps thinking so the answer always has room left', async () => {
    stub = stubFetch([{ body: geminiReply('an answer') }]);
    const { text } = provider();

    await text.complete({ messages: ASK, model: 'gemini-3.6-flash', maxOutputTokens: 1_500 });

    const sent = stub.calls[0]?.body as {
      generationConfig: { maxOutputTokens: number; thinkingConfig?: { thinkingBudget: number } };
    };

    expect(sent.generationConfig.thinkingConfig?.thinkingBudget).toBe(
      LLM_LIMITS.geminiThinkingHeadroom,
    );
    expect(sent.generationConfig.maxOutputTokens).toBe(1_500 + LLM_LIMITS.geminiThinkingHeadroom);
  });

  it('says nothing about thinking to a model that does not think', async () => {
    stub = stubFetch([{ body: geminiReply('an answer') }]);
    const { text } = provider();

    await text.complete({ messages: ASK, model: 'gemini-3.5-flash-lite' });

    const sent = stub.calls[0]?.body as { generationConfig: Record<string, unknown> };

    expect(sent.generationConfig['thinkingConfig']).toBeUndefined();
  });

  it('still asks for the shape it wanted alongside the cap', async () => {
    stub = stubFetch([{ body: geminiReply(JSON.stringify(GOOD_ANSWER)) }]);
    const { text } = provider();

    await text.completeStructured({
      messages: ASK,
      schema: AnswerSchema,
      schemaName: 'answer',
      jsonSchema: ANSWER_JSON_SCHEMA,
      model: 'gemini-3.6-flash',
    });

    const sent = stub.calls[0]?.body as { generationConfig: Record<string, unknown> };

    expect(sent.generationConfig['thinkingConfig']).toBeDefined();
    expect(sent.generationConfig['responseJsonSchema']).toBeDefined();
  });
});

describe('GeminiTextProvider', () => {
  it('refuses to be built without a key', () => {
    expect(() => provider({ apiKey: '' })).toThrow(
      expect.objectContaining({ code: 'LLM_NOT_CONFIGURED' }) as Error,
    );
  });

  it('sends the key as a header, never in the url', async () => {
    stub = stubFetch([{ body: geminiReply('it is in src/router.ts') }]);
    const { text } = provider();

    await text.complete({ messages: ASK });

    expect(stub.calls[0]?.url).not.toContain('AIza');
    expect(stub.calls[0]?.headers['x-goog-api-key']).toContain('AIza');
    expect(stub.calls[0]?.url).toContain('gemini-3.6-flash:generateContent');
  });

  it('returns the answer and counts thinking as well as speaking', async () => {
    stub = stubFetch([{ body: geminiReply('it is in src/router.ts') }]);
    const { text } = provider();

    const result = await text.complete({ messages: ASK });

    expect(result.text).toBe('it is in src/router.ts');
    expect(result.report.usage.completionTokens).toBe(30);
    expect(result.report.usage.reasoningTokens).toBe(20);
    expect(result.report.usage.totalTokens).toBe(1_050);
    expect(result.report.provider).toBe('gemini');
  });

  it('leaves room for thinking in the output budget it asks for', async () => {
    stub = stubFetch([{ body: geminiReply('done') }]);
    const { text } = provider();

    await text.complete({ messages: ASK, maxOutputTokens: 300 });

    const sent = stub.calls[0]?.body as { generationConfig?: { maxOutputTokens?: number } };
    expect(sent.generationConfig?.maxOutputTokens).toBe(300 + LLM_LIMITS.geminiThinkingHeadroom);
  });

  it('refuses an answer that ran out of room', async () => {
    stub = stubFetch([
      {
        body: {
          candidates: [{ content: { parts: [{ text: '{"sum' }] }, finishReason: 'MAX_TOKENS' }],
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
        },
      },
    ]);
    const { text } = provider();

    await expect(text.complete({ messages: ASK })).rejects.toThrow(
      expect.objectContaining({ code: 'LLM_TRUNCATED' }) as Error,
    );
  });

  it('retries a 503 and gives up on a 400', async () => {
    stub = stubFetch([{ status: 503, body: {} }, { body: geminiReply('done') }]);
    const { text } = provider();
    expect((await text.complete({ messages: ASK })).report.attempts).toBe(2);

    stub.restore();
    stub = stubFetch([{ status: 400, body: { error: { message: 'bad' } } }]);
    const second = provider();

    await expect(second.text.complete({ messages: ASK })).rejects.toThrow(
      expect.objectContaining({ code: 'LLM_REQUEST_INVALID' }) as Error,
    );
    expect(stub.calls).toHaveLength(1);
  });

  it('stops when the caller cancels', async () => {
    const controller = new AbortController();
    stub = stubFetch([{ delayMs: 5_000 }]);
    const { text } = provider();

    setTimeout(() => {
      controller.abort();
    }, 10);

    await expect(text.complete({ messages: ASK, signal: controller.signal })).rejects.toThrow(
      expect.objectContaining({ code: 'LLM_CANCELLED' }) as Error,
    );
  });
});

describe('GeminiTextProvider, structured answers', () => {
  it('asks for json and validates it locally', async () => {
    stub = stubFetch([{ body: geminiReply(JSON.stringify(GOOD_ANSWER)) }]);
    const { text } = provider();

    const result = await text.completeStructured({
      messages: ASK,
      schema: AnswerSchema,
      schemaName: 'answer',
      jsonSchema: ANSWER_JSON_SCHEMA,
    });

    expect(result.value).toEqual(GOOD_ANSWER);

    const sent = stub.calls[0]?.body as {
      generationConfig?: { responseMimeType?: string; responseJsonSchema?: unknown };
    };
    expect(sent.generationConfig?.responseMimeType).toBe('application/json');
    expect(sent.generationConfig?.responseJsonSchema).toEqual(ANSWER_JSON_SCHEMA);
  });

  it('still asks for json when no schema was supplied', async () => {
    stub = stubFetch([{ body: geminiReply(JSON.stringify(GOOD_ANSWER)) }]);
    const { text } = provider();

    await text.completeStructured({ messages: ASK, schema: AnswerSchema, schemaName: 'answer' });

    const sent = stub.calls[0]?.body as {
      generationConfig?: { responseMimeType?: string; responseJsonSchema?: unknown };
    };
    expect(sent.generationConfig?.responseMimeType).toBe('application/json');
    expect(sent.generationConfig?.responseJsonSchema).toBeUndefined();
  });

  it('tries once more when the shape is wrong', async () => {
    stub = stubFetch([
      { body: geminiReply('{"file":"a"}') },
      { body: geminiReply(JSON.stringify(GOOD_ANSWER)) },
    ]);
    const { text } = provider();

    const result = await text.completeStructured({
      messages: ASK,
      schema: AnswerSchema,
      schemaName: 'answer',
    });

    expect(result.value).toEqual(GOOD_ANSWER);
    expect(stub.calls).toHaveLength(2);
  });

  it('gives up after one repair', async () => {
    stub = stubFetch([
      { body: geminiReply('{"file":"a"}') },
      { body: geminiReply('{"file":"b"}') },
    ]);
    const { text } = provider();

    let failure: LlmError | null = null;

    try {
      await text.completeStructured({ messages: ASK, schema: AnswerSchema, schemaName: 'answer' });
    } catch (error) {
      failure = error as LlmError;
    }

    expect(failure?.code).toBe('LLM_SCHEMA_REFUSED');
    expect(failure?.detail).toContain('summary');
    expect(failure?.detail).not.toContain('"a"');
  });
});

describe('what reaches the logs', () => {
  it('never contains the prompt or the answer', async () => {
    stub = stubFetch([{ body: geminiReply(`the answer mentions ${SECRET_PHRASE}`) }]);
    const { text, logs } = provider();

    await text.complete({
      messages: [
        { role: 'system', content: 'You are a code assistant.' },
        { role: 'user', content: PRIVATE_PROMPT },
      ],
    });

    expect(logs()).not.toContain(SECRET_PHRASE);
    expect(logs()).not.toContain('chargeCard');
  });

  it('never contains the key', async () => {
    stub = stubFetch([
      { status: 500, body: {} },
      { status: 500, body: {} },
      { status: 500, body: {} },
    ]);
    const { text, logs } = provider();

    await text.complete({ messages: ASK }).catch(() => undefined);

    expect(logs()).not.toContain('AIzaNotARealKeyAtAllJustForTesting123');
  });
});
