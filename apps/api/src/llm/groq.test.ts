import { afterEach, describe, expect, it } from 'vitest';

import type { LlmError } from './errors.js';
import {
  GroqTextProvider,
  JSON_REMINDER,
  mentionsJson,
  readGroqUsage,
  readText,
  withJsonReminder,
} from './groq.js';
import { LLM_LIMITS } from './limits.js';
import {
  ANSWER_JSON_SCHEMA,
  AnswerSchema,
  GOOD_ANSWER,
  PRIVATE_PROMPT,
  SECRET_PHRASE,
  capturingLogger,
  groqReply,
  stubFetch,
  type FetchStub,
} from './llm.fixtures.js';

let stub: FetchStub | null = null;

afterEach(() => {
  stub?.restore();
  stub = null;
});

function provider(overrides: Record<string, unknown> = {}): {
  text: GroqTextProvider;
  logs: () => string;
} {
  const captured = capturingLogger();

  return {
    text: new GroqTextProvider({
      apiKey: 'gsk_notarealkeyatallbutlongenough',
      logger: captured.logger,
      random: () => 0,
      ...overrides,
    }),
    logs: captured.text,
  };
}

const ASK = [{ role: 'user' as const, content: 'where is the router' }];

const TOOL_USE_FAILED = {
  error: {
    message: 'Tool choice is none, but model called a tool',
    type: 'invalid_request_error',
    code: 'tool_use_failed',
    failed_generation: '{"name": "repo_browser.list_files", "arguments": {"path": ""}}',
  },
};

const JSON_VALIDATE_FAILED = {
  error: {
    message: 'Failed to validate JSON. Please adjust your prompt.',
    type: 'invalid_request_error',
    code: 'json_validate_failed',
  },
};

async function failureOf(work: Promise<unknown>): Promise<LlmError> {
  try {
    await work;
    throw new Error('that was supposed to fail');
  } catch (error) {
    return error as LlmError;
  }
}

describe('readGroqUsage', () => {
  it('reads what the provider reported', () => {
    expect(readGroqUsage({ prompt_tokens: 100, completion_tokens: 40 })).toEqual({
      promptTokens: 100,
      completionTokens: 40,
      reasoningTokens: 0,
      totalTokens: 140,
    });
  });

  it('separates reasoning tokens out of the completion count', () => {
    expect(
      readGroqUsage({
        prompt_tokens: 218,
        completion_tokens: 189,
        completion_tokens_details: { reasoning_tokens: 138 },
      }),
    ).toEqual({
      promptTokens: 218,
      completionTokens: 51,
      reasoningTokens: 138,
      totalTokens: 407,
    });
  });

  it('never counts more reasoning than completion', () => {
    const usage = readGroqUsage({
      prompt_tokens: 10,
      completion_tokens: 5,
      completion_tokens_details: { reasoning_tokens: 900 },
    });
    expect(usage.reasoningTokens).toBe(5);
    expect(usage.completionTokens).toBe(0);
  });

  it('treats a missing or broken usage block as zero', () => {
    expect(readGroqUsage(undefined).totalTokens).toBe(0);
    expect(readGroqUsage({ prompt_tokens: 'lots' }).totalTokens).toBe(0);
    expect(readGroqUsage({ prompt_tokens: -5 }).totalTokens).toBe(0);
  });
});

describe('readText', () => {
  it('returns the content', () => {
    expect(readText(groqReply('hello'))).toBe('hello');
  });

  it('refuses an answer that was cut short', () => {
    expect(() =>
      readText({ choices: [{ message: { content: 'half' }, finish_reason: 'length' }] }),
    ).toThrow(expect.objectContaining({ code: 'LLM_TRUNCATED' }) as Error);
  });

  it('refuses an answer the provider filtered', () => {
    expect(() =>
      readText({ choices: [{ message: { content: '' }, finish_reason: 'content_filter' }] }),
    ).toThrow(expect.objectContaining({ code: 'LLM_CONTENT_REFUSED' }) as Error);
  });

  it.each([
    ['no choices', { choices: [] }],
    ['no content', { choices: [{ message: {}, finish_reason: 'stop' }] }],
    [
      'content that is not text',
      { choices: [{ message: { content: 42 }, finish_reason: 'stop' }] },
    ],
    ['nothing at all', null],
  ])('refuses %s', (_label, body) => {
    expect(() => readText(body)).toThrow(
      expect.objectContaining({ code: 'LLM_RESPONSE_MALFORMED' }) as Error,
    );
  });
});

describe('withJsonReminder', () => {
  it('adds a reminder when nothing mentions json', () => {
    const messages = withJsonReminder([{ role: 'user', content: 'answer me' }]);
    expect(messages[0]?.content).toContain(JSON_REMINDER);
  });

  it('leaves the messages alone when json is already mentioned', () => {
    const original = [{ role: 'user' as const, content: 'reply as JSON please' }];
    expect(withJsonReminder(original)[0]?.content).toBe('reply as JSON please');
    expect(mentionsJson(original)).toBe(true);
  });
});

describe('GroqTextProvider', () => {
  it('refuses to be built without a key', () => {
    expect(() => provider({ apiKey: '   ' })).toThrow(
      expect.objectContaining({ code: 'LLM_NOT_CONFIGURED' }) as Error,
    );
  });

  it('sends the key as a header and never in the url', async () => {
    stub = stubFetch([{ body: groqReply('the router is in src/router.ts') }]);
    const { text } = provider();

    await text.complete({ messages: ASK });

    expect(stub.calls[0]?.url).not.toContain('gsk_');
    expect(stub.calls[0]?.headers['authorization']).toContain('gsk_');
  });

  it('returns the answer and counts the tokens', async () => {
    stub = stubFetch([{ body: groqReply('it is in src/router.ts') }]);
    const { text } = provider();

    const result = await text.complete({ messages: ASK });

    expect(result.text).toBe('it is in src/router.ts');
    expect(result.report.usage.totalTokens).toBe(140);
    expect(result.report.cost.microCents).toBe(100 * 10 + 40 * 50);
    expect(result.report.attempts).toBe(1);
  });

  it('retries a 429 and honours retry-after', async () => {
    stub = stubFetch([
      { status: 429, body: { error: { message: 'slow down' } }, headers: { 'retry-after': '0' } },
      { body: groqReply('done') },
    ]);
    const { text } = provider();

    const result = await text.complete({ messages: ASK });

    expect(result.report.attempts).toBe(2);
    expect(stub.calls).toHaveLength(2);
  });

  it('retries a 503', async () => {
    stub = stubFetch([
      { status: 503, body: { error: { message: 'busy' } } },
      { body: groqReply('done') },
    ]);
    const { text } = provider();

    expect((await text.complete({ messages: ASK })).report.attempts).toBe(2);
  });

  it('retries a network failure', async () => {
    stub = stubFetch([{ networkError: true }, { body: groqReply('done') }]);
    const { text } = provider();

    expect((await text.complete({ messages: ASK })).report.attempts).toBe(2);
  });

  it('gives up after the last attempt', async () => {
    stub = stubFetch([
      { status: 503, body: {} },
      { status: 503, body: {} },
      { status: 503, body: {} },
    ]);
    const { text } = provider();

    await expect(text.complete({ messages: ASK })).rejects.toThrow(
      expect.objectContaining({ code: 'LLM_UNAVAILABLE' }) as Error,
    );
    expect(stub.calls).toHaveLength(LLM_LIMITS.maxAttempts);
  });

  it.each([
    ['a bad request', 400, 'LLM_REQUEST_INVALID'],
    ['a bad key', 401, 'LLM_UNAUTHENTICATED'],
    ['a forbidden request', 403, 'LLM_UNAUTHENTICATED'],
    ['an unknown model', 404, 'LLM_MODEL_UNKNOWN'],
    ['an oversized request', 413, 'LLM_INPUT_TOO_LARGE'],
    ['an unprocessable request', 422, 'LLM_REQUEST_INVALID'],
  ])('does not retry %s', async (_label, status, code) => {
    stub = stubFetch([{ status, body: { error: { message: 'no' } } }]);
    const { text } = provider();

    await expect(text.complete({ messages: ASK })).rejects.toThrow(
      expect.objectContaining({ code }) as Error,
    );
    expect(stub.calls).toHaveLength(1);
  });

  it('never puts the key in an error', async () => {
    stub = stubFetch([
      { status: 401, body: { error: { message: 'bad key gsk_notarealkeyatallbutlongenough' } } },
    ]);
    const { text } = provider();

    const failure = await failureOf(text.complete({ messages: ASK }));

    expect(failure.detail).not.toContain('gsk_notarealkeyatallbutlongenough');
    expect(JSON.stringify(failure)).not.toContain('gsk_notarealkeyatallbutlongenough');
  });

  it('stops when the caller cancels, and does not retry', async () => {
    const controller = new AbortController();
    stub = stubFetch([{ delayMs: 5_000 }, { body: groqReply('too late') }]);
    const { text } = provider();

    setTimeout(() => {
      controller.abort();
    }, 10);

    await expect(text.complete({ messages: ASK, signal: controller.signal })).rejects.toThrow(
      expect.objectContaining({ code: 'LLM_CANCELLED' }) as Error,
    );
    expect(stub.calls).toHaveLength(1);
  });

  it('times out when the provider never answers', async () => {
    stub = stubFetch([{ delayMs: 5_000 }, { delayMs: 5_000 }, { delayMs: 5_000 }]);
    const { text } = provider({ timeoutMs: 30 });

    await expect(text.complete({ messages: ASK })).rejects.toThrow(
      expect.objectContaining({ code: 'LLM_TIMED_OUT' }) as Error,
    );
  });
});

describe('GroqTextProvider, structured answers', () => {
  it('validates the answer against the schema', async () => {
    stub = stubFetch([{ body: groqReply(JSON.stringify(GOOD_ANSWER)) }]);
    const { text } = provider();

    const result = await text.completeStructured({
      messages: ASK,
      schema: AnswerSchema,
      schemaName: 'answer',
    });

    expect(result.value).toEqual(GOOD_ANSWER);
  });

  it('asks for json_object on a model that cannot do json_schema', async () => {
    stub = stubFetch([{ body: groqReply(JSON.stringify(GOOD_ANSWER)) }]);
    const { text } = provider();

    await text.completeStructured({
      messages: ASK,
      schema: AnswerSchema,
      schemaName: 'answer',
      jsonSchema: ANSWER_JSON_SCHEMA,
      model: 'llama-3.3-70b-versatile',
    });

    const sent = stub.calls[0]?.body as { response_format?: { type?: string } };
    expect(sent.response_format?.type).toBe('json_object');
  });

  it('asks for json_schema on a model that can', async () => {
    stub = stubFetch([{ body: groqReply(JSON.stringify(GOOD_ANSWER)) }]);
    const { text } = provider();

    await text.completeStructured({
      messages: ASK,
      schema: AnswerSchema,
      schemaName: 'answer',
      jsonSchema: ANSWER_JSON_SCHEMA,
      model: 'openai/gpt-oss-120b',
    });

    const sent = stub.calls[0]?.body as { response_format?: { type?: string } };
    expect(sent.response_format?.type).toBe('json_schema');
  });

  it('tries once more when the shape is wrong, and succeeds', async () => {
    stub = stubFetch([
      { body: groqReply(JSON.stringify({ file: 'src/router.ts' })) },
      { body: groqReply(JSON.stringify(GOOD_ANSWER)) },
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

  it('gives up after one repair rather than spending forever', async () => {
    stub = stubFetch([
      { body: groqReply('{"file":"a"}') },
      { body: groqReply('{"file":"b"}') },
      { body: groqReply(JSON.stringify(GOOD_ANSWER)) },
    ]);
    const { text } = provider();

    await expect(
      text.completeStructured({ messages: ASK, schema: AnswerSchema, schemaName: 'answer' }),
    ).rejects.toThrow(expect.objectContaining({ code: 'LLM_SCHEMA_REFUSED' }) as Error);

    expect(stub.calls).toHaveLength(LLM_LIMITS.schemaRepairAttempts + 1);
  });

  it('refuses an answer that is not json at all', async () => {
    stub = stubFetch([
      { body: groqReply('sure, it is in the router') },
      { body: groqReply('still prose') },
    ]);
    const { text } = provider();

    await expect(
      text.completeStructured({ messages: ASK, schema: AnswerSchema, schemaName: 'answer' }),
    ).rejects.toThrow(expect.objectContaining({ code: 'LLM_SCHEMA_REFUSED' }) as Error);
  });

  it('tries again when the model called a tool instead of answering', async () => {
    stub = stubFetch([
      { status: 400, body: TOOL_USE_FAILED },
      { body: groqReply(JSON.stringify(GOOD_ANSWER)) },
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

  it('tells the model there is no tool to call, so it stops reaching for one', async () => {
    stub = stubFetch([
      { status: 400, body: TOOL_USE_FAILED },
      { body: groqReply(JSON.stringify(GOOD_ANSWER)) },
    ]);
    const { text } = provider();

    await text.completeStructured({ messages: ASK, schema: AnswerSchema, schemaName: 'answer' });

    const sent = stub.calls[1]?.body as { messages: { content: string }[] };
    const last = sent.messages[sent.messages.length - 1]?.content ?? '';

    expect(last).toContain('There are no tools attached to this request');
    expect(last).toContain('call nothing');
  });

  it('tries again when the provider could not validate the answer', async () => {
    stub = stubFetch([
      { status: 400, body: JSON_VALIDATE_FAILED },
      { body: groqReply(JSON.stringify(GOOD_ANSWER)) },
    ]);
    const { text } = provider();

    const result = await text.completeStructured({
      messages: ASK,
      schema: AnswerSchema,
      schemaName: 'answer',
    });

    expect(result.value).toEqual(GOOD_ANSWER);
  });

  it('gives up on an unusable answer the same way as on a wrong shape', async () => {
    stub = stubFetch([
      { status: 400, body: TOOL_USE_FAILED },
      { status: 400, body: TOOL_USE_FAILED },
    ]);
    const { text } = provider();

    const failure = await failureOf(
      text.completeStructured({ messages: ASK, schema: AnswerSchema, schemaName: 'answer' }),
    );

    expect(failure.code).toBe('LLM_SCHEMA_REFUSED');
    expect(failure.detail).toBe('tool_use_failed');
  });

  it('still fails outright on a request the provider genuinely refused', async () => {
    stub = stubFetch([
      {
        status: 400,
        body: { error: { message: 'model is decommissioned', code: 'model_decommissioned' } },
      },
      { body: groqReply(JSON.stringify(GOOD_ANSWER)) },
    ]);
    const { text } = provider();

    const failure = await failureOf(
      text.completeStructured({ messages: ASK, schema: AnswerSchema, schemaName: 'answer' }),
    );

    expect(failure.code).toBe('LLM_REQUEST_INVALID');
    expect(stub.calls).toHaveLength(1);
  });

  it('leaves a plain answer alone, because there is nothing there to repair', async () => {
    stub = stubFetch([{ status: 400, body: TOOL_USE_FAILED }]);
    const { text } = provider();

    const failure = await failureOf(text.complete({ messages: ASK }));

    expect(failure.code).toBe('LLM_REQUEST_INVALID');
  });

  it('names the failing fields without quoting the answer', async () => {
    stub = stubFetch([{ body: groqReply('{"file":"a"}') }, { body: groqReply('{"file":"a"}') }]);
    const { text } = provider();

    const failure = await failureOf(
      text.completeStructured({ messages: ASK, schema: AnswerSchema, schemaName: 'answer' }),
    );

    expect(failure.detail).toContain('summary');
    expect(failure.detail).not.toContain('"a"');
  });
});

describe('what reaches the logs', () => {
  it('never contains the prompt', async () => {
    stub = stubFetch([{ body: groqReply('an answer about the code') }]);
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

  it('never contains the answer', async () => {
    stub = stubFetch([{ body: groqReply(`the answer mentions ${SECRET_PHRASE}`) }]);
    const { text, logs } = provider();

    await text.complete({ messages: ASK });

    expect(logs()).not.toContain(SECRET_PHRASE);
  });

  it('never contains the prompt when a repair round runs', async () => {
    stub = stubFetch([
      { body: groqReply('{"file":"a"}') },
      { body: groqReply(JSON.stringify(GOOD_ANSWER)) },
    ]);
    const { text, logs } = provider();

    await text.completeStructured({
      messages: [{ role: 'user', content: PRIVATE_PROMPT }],
      schema: AnswerSchema,
      schemaName: 'answer',
    });

    expect(logs()).not.toContain(SECRET_PHRASE);
    expect(logs()).not.toContain('"a"');
  });

  it('never contains the key', async () => {
    stub = stubFetch([
      { status: 500, body: {} },
      { status: 500, body: {} },
      { status: 500, body: {} },
    ]);
    const { text, logs } = provider();

    await text.complete({ messages: ASK }).catch(() => undefined);

    expect(logs()).not.toContain('gsk_notarealkeyatallbutlongenough');
  });

  it('does record what is safe to record', async () => {
    stub = stubFetch([{ status: 503, body: {} }, { body: groqReply('done') }]);
    const { text, logs } = provider();

    await text.complete({ messages: ASK });

    expect(logs()).toContain('openai/gpt-oss-20b');
    expect(logs()).toContain('LLM_UNAVAILABLE');
  });
});
