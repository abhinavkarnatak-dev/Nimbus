import { afterEach, describe, expect, it } from 'vitest';

import {
  GeminiVisionProvider,
  VISION_SYSTEM_INSTRUCTION,
  readGeminiText,
  readGeminiUsage,
} from './gemini.js';
import { LLM_LIMITS } from './limits.js';
import {
  SECRET_PHRASE,
  capturingLogger,
  geminiReply,
  stubFetch,
  type FetchStub,
} from './llm.fixtures.js';
import type { LlmError } from './errors.js';

let stub: FetchStub | null = null;

afterEach(() => {
  stub?.restore();
  stub = null;
});

const PNG = Buffer.from('a pretend png body');

function provider(overrides: Record<string, unknown> = {}): {
  vision: GeminiVisionProvider;
  logs: () => string;
} {
  const captured = capturingLogger();

  return {
    vision: new GeminiVisionProvider({
      apiKey: 'AIzaNotARealKeyAtAllJustForTesting123',
      logger: captured.logger,
      random: () => 0,
      ...overrides,
    }),
    logs: captured.text,
  };
}

describe('readGeminiUsage', () => {
  it('counts thinking tokens, which the visible count leaves out', () => {
    expect(
      readGeminiUsage({
        promptTokenCount: 1_106,
        candidatesTokenCount: 29,
        thoughtsTokenCount: 207,
      }),
    ).toEqual({
      promptTokens: 1_106,
      completionTokens: 29,
      reasoningTokens: 207,
      totalTokens: 1_342,
    });
  });

  it('treats a missing usage block as zero', () => {
    expect(readGeminiUsage(undefined).totalTokens).toBe(0);
  });
});

describe('readGeminiText', () => {
  it('joins the text parts', () => {
    const body = {
      candidates: [{ content: { parts: [{ text: 'a red ' }, { text: 'error box' }] } }],
    };
    expect(readGeminiText(body).text).toBe('a red error box');
  });

  it('notices the answer was cut short', () => {
    const body = {
      candidates: [{ content: { parts: [{ text: 'half a' }] }, finishReason: 'MAX_TOKENS' }],
    };
    expect(readGeminiText(body).hitLimit).toBe(true);
  });

  it.each([['SAFETY'], ['PROHIBITED_CONTENT'], ['BLOCKLIST'], ['RECITATION']])(
    'refuses a %s finish',
    (reason) => {
      const body = { candidates: [{ content: { parts: [{ text: 'x' }] }, finishReason: reason }] };
      expect(() => readGeminiText(body)).toThrow(
        expect.objectContaining({ code: 'LLM_CONTENT_REFUSED' }) as Error,
      );
    },
  );

  it('refuses a blocked prompt', () => {
    expect(() => readGeminiText({ promptFeedback: { blockReason: 'SAFETY' } })).toThrow(
      expect.objectContaining({ code: 'LLM_CONTENT_REFUSED' }) as Error,
    );
  });

  it.each([
    ['no candidates', { candidates: [] }],
    ['no parts', { candidates: [{ content: {} }] }],
    ['empty text', { candidates: [{ content: { parts: [{ text: '   ' }] } }] }],
  ])('refuses %s', (_label, body) => {
    expect(() => readGeminiText(body)).toThrow(
      expect.objectContaining({ code: 'LLM_RESPONSE_MALFORMED' }) as Error,
    );
  });
});

describe('GeminiVisionProvider', () => {
  it('refuses to be built without a key', () => {
    expect(() => provider({ apiKey: '' })).toThrow(
      expect.objectContaining({ code: 'LLM_NOT_CONFIGURED' }) as Error,
    );
  });

  it('sends the key as a header, never in the url', async () => {
    stub = stubFetch([{ body: geminiReply('a red error box') }]);
    const { vision } = provider();

    await vision.describeImage({ bytes: PNG, mimeType: 'image/png' });

    expect(stub.calls[0]?.url).not.toContain('AIza');
    expect(stub.calls[0]?.headers['x-goog-api-key']).toContain('AIza');
  });

  it('tells the model that an image is untrusted material', async () => {
    stub = stubFetch([{ body: geminiReply('a red error box') }]);
    const { vision } = provider();

    await vision.describeImage({ bytes: PNG, mimeType: 'image/png' });

    const sent = stub.calls[0]?.body as { systemInstruction?: { parts?: { text?: string }[] } };
    const instruction = sent.systemInstruction?.parts?.[0]?.text ?? '';

    expect(instruction).toBe(VISION_SYSTEM_INSTRUCTION);
    expect(instruction).toContain('untrusted');
    expect(instruction).toContain('never carry them out');
  });

  it('describes an image and counts the tokens', async () => {
    stub = stubFetch([{ body: geminiReply('a red box saying Error 500') }]);
    const { vision } = provider();

    const result = await vision.describeImage({ bytes: PNG, mimeType: 'image/png' });

    expect(result.description).toBe('a red box saying Error 500');
    expect(result.truncated).toBe(false);
    expect(result.report.usage.reasoningTokens).toBe(20);
    expect(result.report.usage.totalTokens).toBe(1_050);
  });

  it('caps a description that runs long', async () => {
    const long = 'a'.repeat(LLM_LIMITS.visionDescriptionMaxChars + 500);
    stub = stubFetch([{ body: geminiReply(long) }]);
    const { vision } = provider();

    const result = await vision.describeImage({ bytes: PNG, mimeType: 'image/png' });

    expect(result.description).toHaveLength(LLM_LIMITS.visionDescriptionMaxChars);
    expect(result.truncated).toBe(true);
  });

  it.each([
    ['a type it cannot read', 'image/gif', 'LLM_REQUEST_INVALID'],
    ['a document', 'application/pdf', 'LLM_REQUEST_INVALID'],
  ])('refuses %s', async (_label, mimeType, code) => {
    stub = stubFetch([{ body: geminiReply('never asked') }]);
    const { vision } = provider();

    await expect(
      vision.describeImage({ bytes: PNG, mimeType: mimeType as 'image/png' }),
    ).rejects.toThrow(expect.objectContaining({ code }) as Error);
    expect(stub.calls).toHaveLength(0);
  });

  it('refuses an empty image without calling anybody', async () => {
    stub = stubFetch([{ body: geminiReply('never asked') }]);
    const { vision } = provider();

    await expect(
      vision.describeImage({ bytes: Buffer.alloc(0), mimeType: 'image/png' }),
    ).rejects.toThrow(expect.objectContaining({ code: 'LLM_REQUEST_INVALID' }) as Error);
    expect(stub.calls).toHaveLength(0);
  });

  it('refuses an image that is too large without calling anybody', async () => {
    stub = stubFetch([{ body: geminiReply('never asked') }]);
    const { vision } = provider();

    await expect(
      vision.describeImage({
        bytes: Buffer.alloc(LLM_LIMITS.visionMaxBytes + 1),
        mimeType: 'image/png',
      }),
    ).rejects.toThrow(expect.objectContaining({ code: 'LLM_INPUT_TOO_LARGE' }) as Error);
    expect(stub.calls).toHaveLength(0);
  });

  it('retries a 503, which the real provider does send', async () => {
    stub = stubFetch([
      { status: 503, body: { error: { message: 'high demand' } } },
      { body: geminiReply('a red error box') },
    ]);
    const { vision } = provider();

    const result = await vision.describeImage({ bytes: PNG, mimeType: 'image/png' });
    expect(result.report.attempts).toBe(2);
  });

  it('does not retry a bad key', async () => {
    stub = stubFetch([{ status: 400, body: { error: { message: 'API key not valid' } } }]);
    const { vision } = provider();

    await expect(vision.describeImage({ bytes: PNG, mimeType: 'image/png' })).rejects.toThrow(
      expect.objectContaining({ code: 'LLM_REQUEST_INVALID' }) as Error,
    );
    expect(stub.calls).toHaveLength(1);
  });

  it('stops when the caller cancels', async () => {
    const controller = new AbortController();
    stub = stubFetch([{ delayMs: 5_000 }]);
    const { vision } = provider();

    setTimeout(() => {
      controller.abort();
    }, 10);

    await expect(
      vision.describeImage({ bytes: PNG, mimeType: 'image/png', signal: controller.signal }),
    ).rejects.toThrow(expect.objectContaining({ code: 'LLM_CANCELLED' }) as Error);
  });

  it('never logs the image or the description', async () => {
    stub = stubFetch([{ body: geminiReply(`a screenshot saying ${SECRET_PHRASE}`) }]);
    const { vision, logs } = provider();

    await vision.describeImage({
      bytes: Buffer.from(SECRET_PHRASE),
      mimeType: 'image/png',
      prompt: SECRET_PHRASE,
    });

    expect(logs()).not.toContain(SECRET_PHRASE);
    expect(logs()).not.toContain(Buffer.from(SECRET_PHRASE).toString('base64'));
  });

  it('never puts the key in an error', async () => {
    stub = stubFetch([
      {
        status: 400,
        body: { error: { message: 'key AIzaNotARealKeyAtAllJustForTesting123 bad' } },
      },
    ]);
    const { vision } = provider();

    const failure = await vision
      .describeImage({ bytes: PNG, mimeType: 'image/png' })
      .catch((error: unknown) => error as LlmError);

    expect(JSON.stringify(failure)).not.toContain('AIzaNotARealKeyAtAllJustForTesting123');
  });
});
