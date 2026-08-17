import { describe, expect, it } from 'vitest';

import { LlmError } from './errors.js';
import { FakeTextProvider } from './fake-text.js';
import { FakeVisionProvider } from './fake-vision.js';
import { GeminiVisionProvider } from './gemini.js';
import { GeminiTextProvider } from './gemini-text.js';
import { LLM_LIMITS } from './limits.js';
import { AnswerSchema, GOOD_ANSWER, capturingLogger } from './llm.fixtures.js';
import { DEFAULT_TEXT_MODEL, DEFAULT_VISION_MODEL } from './models.js';

const PNG = Buffer.from('a pretend png body');
const ASK = [{ role: 'user' as const, content: 'where is the router' }];

describe('FakeTextProvider', () => {
  it('says plainly that it is not real', () => {
    expect(new FakeTextProvider().real).toBe(false);
    expect(
      new GeminiTextProvider({ apiKey: 'AIzax'.repeat(8), logger: capturingLogger().logger }).real,
    ).toBe(true);
  });

  it('answers in the order it was given', async () => {
    const fake = new FakeTextProvider({ answers: [{ text: 'first' }, { text: 'second' }] });

    expect((await fake.complete({ messages: ASK })).text).toBe('first');
    expect((await fake.complete({ messages: ASK })).text).toBe('second');
  });

  it('falls back to its default once the script runs out', async () => {
    const fake = new FakeTextProvider({ defaultAnswer: { text: 'always this' } });

    expect((await fake.complete({ messages: ASK })).text).toBe('always this');
    expect((await fake.complete({ messages: ASK })).text).toBe('always this');
  });

  it('records what it was asked', async () => {
    const fake = new FakeTextProvider();
    await fake.complete({ messages: ASK, model: 'llama-3.1-8b-instant' });

    expect(fake.calls[0]?.model).toBe('llama-3.1-8b-instant');
    expect(fake.calls[0]?.messages[0]?.content).toBe('where is the router');
    expect(fake.callCount).toBe(1);
  });

  it('can be told to fail', async () => {
    const fake = new FakeTextProvider({
      answers: [{ fails: new LlmError('LLM_RATE_LIMITED', 'slow down') }],
    });

    await expect(fake.complete({ messages: ASK })).rejects.toThrow(
      expect.objectContaining({ code: 'LLM_RATE_LIMITED' }) as Error,
    );
  });

  it('refuses an empty conversation, exactly as the real one does', async () => {
    await expect(new FakeTextProvider().complete({ messages: [] })).rejects.toThrow(
      expect.objectContaining({ code: 'LLM_REQUEST_INVALID' }) as Error,
    );
  });

  it('redacts outgoing secrets, exactly as the real one does', async () => {
    const fake = new FakeTextProvider();
    await fake.complete({
      messages: [{ role: 'user', content: 'token ghp_abcdefghijklmnopqrstuvwxyz0123' }],
    });

    expect(fake.calls[0]?.messages[0]?.content).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123');
  });

  it('refuses a call the caller already cancelled', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      new FakeTextProvider().complete({ messages: ASK, signal: controller.signal }),
    ).rejects.toThrow(expect.objectContaining({ code: 'LLM_CANCELLED' }) as Error);
  });

  it('holds a structured answer to the same schema the real one does', async () => {
    const fake = new FakeTextProvider({ answers: [{ value: GOOD_ANSWER }] });

    const result = await fake.completeStructured({
      messages: ASK,
      schema: AnswerSchema,
      schemaName: 'answer',
    });

    expect(result.value).toEqual(GOOD_ANSWER);
  });

  it('refuses a scripted answer that does not match the schema', async () => {
    const fake = new FakeTextProvider({ answers: [{ value: { file: 'a' } }] });

    await expect(
      fake.completeStructured({ messages: ASK, schema: AnswerSchema, schemaName: 'answer' }),
    ).rejects.toThrow(expect.objectContaining({ code: 'LLM_SCHEMA_REFUSED' }) as Error);
  });

  it('reports usage and a cost like the real one', async () => {
    const fake = new FakeTextProvider({
      answers: [{ usage: { promptTokens: 100, completionTokens: 40 } }],
    });
    const result = await fake.complete({ messages: ASK });

    expect(result.report.usage.totalTokens).toBe(140);
    expect(result.report.cost.microCents).toBe(100 * 30 + 40 * 250);
    expect(result.report.model).toBe(DEFAULT_TEXT_MODEL);
  });
});

describe('FakeVisionProvider', () => {
  it('says plainly that it is not real', () => {
    expect(new FakeVisionProvider().real).toBe(false);
    expect(
      new GeminiVisionProvider({ apiKey: 'AIza'.repeat(6), logger: capturingLogger().logger }).real,
    ).toBe(true);
  });

  it('describes an image and records it', async () => {
    const fake = new FakeVisionProvider({ descriptions: [{ description: 'a red error box' }] });
    const result = await fake.describeImage({ bytes: PNG, mimeType: 'image/png' });

    expect(result.description).toBe('a red error box');
    expect(fake.calls[0]?.bytes).toBe(PNG.byteLength);
    expect(fake.calls[0]?.model).toBe(DEFAULT_VISION_MODEL);
  });

  it.each([
    ['a type it cannot read', Buffer.from('x'), 'image/gif', 'LLM_REQUEST_INVALID'],
    ['an empty image', Buffer.alloc(0), 'image/png', 'LLM_REQUEST_INVALID'],
    [
      'an image that is too large',
      Buffer.alloc(LLM_LIMITS.visionMaxBytes + 1),
      'image/png',
      'LLM_INPUT_TOO_LARGE',
    ],
  ])('refuses %s, exactly as the real one does', async (_label, bytes, mimeType, code) => {
    const fake = new FakeVisionProvider();

    await expect(fake.describeImage({ bytes, mimeType: mimeType as 'image/png' })).rejects.toThrow(
      expect.objectContaining({ code }) as Error,
    );
    expect(fake.calls).toHaveLength(0);
  });

  it('caps a long description, exactly as the real one does', async () => {
    const fake = new FakeVisionProvider({
      descriptions: [{ description: 'a'.repeat(LLM_LIMITS.visionDescriptionMaxChars + 100) }],
    });

    const result = await fake.describeImage({ bytes: PNG, mimeType: 'image/png' });

    expect(result.description).toHaveLength(LLM_LIMITS.visionDescriptionMaxChars);
    expect(result.truncated).toBe(true);
  });

  it('can be told to fail', async () => {
    const fake = new FakeVisionProvider();
    fake.queue({ fails: new LlmError('LLM_CONTENT_REFUSED', 'no') });

    await expect(fake.describeImage({ bytes: PNG, mimeType: 'image/png' })).rejects.toThrow(
      expect.objectContaining({ code: 'LLM_CONTENT_REFUSED' }) as Error,
    );
  });

  it('refuses a call the caller already cancelled', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      new FakeVisionProvider().describeImage({
        bytes: PNG,
        mimeType: 'image/png',
        signal: controller.signal,
      }),
    ).rejects.toThrow(expect.objectContaining({ code: 'LLM_CANCELLED' }) as Error);
  });
});
