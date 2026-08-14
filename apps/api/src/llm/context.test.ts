import { describe, expect, it } from 'vitest';

import { TRUNCATION_NOTE, charsIn, prepareMessages } from './context.js';
import { LLM_LIMITS } from './limits.js';
import type { Message } from './provider.js';

function user(content: string): Message {
  return { role: 'user', content };
}

describe('prepareMessages', () => {
  it('keeps a short conversation exactly as it was', () => {
    const messages: Message[] = [
      { role: 'system', content: 'be helpful' },
      user('where is the router'),
    ];

    const prepared = prepareMessages(messages);

    expect(prepared.messages).toEqual(messages);
    expect(prepared.droppedMessages).toBe(0);
    expect(prepared.truncated).toBe(false);
  });

  it('refuses an empty conversation', () => {
    expect(() => prepareMessages([])).toThrow(
      expect.objectContaining({ code: 'LLM_REQUEST_INVALID' }) as Error,
    );
  });

  it('drops the oldest ordinary messages first', () => {
    const messages: Message[] = [
      { role: 'system', content: 'be helpful' },
      user('a'.repeat(600)),
      user('b'.repeat(600)),
      user('c'.repeat(600)),
    ];

    const prepared = prepareMessages(messages, 1_400);

    expect(prepared.messages[0]?.content).toBe('be helpful');
    expect(prepared.messages.some((message) => message.content.startsWith('a'))).toBe(false);
    expect(prepared.messages.some((message) => message.content.startsWith('c'))).toBe(true);
    expect(prepared.droppedMessages).toBe(1);
    expect(prepared.droppedChars).toBe(600);
  });

  it('never drops the system message', () => {
    const messages: Message[] = [
      { role: 'system', content: 'the rules that matter' },
      user('x'.repeat(5_000)),
    ];

    const prepared = prepareMessages(messages, 200);

    expect(prepared.messages[0]?.content).toBe('the rules that matter');
  });

  it('never drops the newest message, it clips it instead', () => {
    const prepared = prepareMessages([user('x'.repeat(5_000))], 200);

    expect(prepared.messages).toHaveLength(1);
    expect(prepared.messages[0]?.content).toHaveLength(200);
    expect(prepared.messages[0]?.content.endsWith(TRUNCATION_NOTE)).toBe(true);
    expect(prepared.truncated).toBe(true);
  });

  it('caps how many messages it will send', () => {
    const messages = Array.from({ length: LLM_LIMITS.maxMessages + 10 }, (_value, index) =>
      user(`message ${String(index)}`),
    );

    const prepared = prepareMessages(messages);

    expect(prepared.messages).toHaveLength(LLM_LIMITS.maxMessages);
    expect(prepared.droppedMessages).toBe(10);
  });

  it('caps a very long system message', () => {
    const prepared = prepareMessages([
      { role: 'system', content: 'y'.repeat(LLM_LIMITS.maxSystemChars + 500) },
      user('hello'),
    ]);

    expect(prepared.messages[0]?.content).toHaveLength(LLM_LIMITS.maxSystemChars);
    expect(prepared.truncated).toBe(true);
  });

  it('stays inside the character budget it was given', () => {
    const messages = Array.from({ length: 30 }, (_value, index) =>
      user(`${String(index)}${'z'.repeat(400)}`),
    );

    expect(charsIn(prepareMessages(messages, 2_000).messages)).toBeLessThanOrEqual(2_000);
  });

  it('redacts a credential somebody pasted into the conversation', () => {
    const prepared = prepareMessages([
      user('the build fails, here is my token ghp_abcdefghijklmnopqrstuvwxyz0123'),
    ]);

    expect(prepared.messages[0]?.content).toContain('[redacted]');
    expect(prepared.messages[0]?.content).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123');
    expect(prepared.redactedMessages).toBe(1);
  });

  it('redacts a credential in a system message too', () => {
    const prepared = prepareMessages([
      { role: 'system', content: 'use key gsk_abcdefghijklmnopqrstuvwxyz01234' },
      user('hello'),
    ]);

    expect(prepared.messages[0]?.content).not.toContain('gsk_abcdefghijklmnopqrstuvwxyz01234');
  });

  it('leaves ordinary code alone', () => {
    const code = 'export function total(a: number, b: number): number {\n  return a + b;\n}';
    const prepared = prepareMessages([user(code)]);

    expect(prepared.messages[0]?.content).toBe(code);
    expect(prepared.redactedMessages).toBe(0);
  });

  it('counts characters across every message', () => {
    expect(charsIn([user('abc'), user('de')])).toBe(5);
  });
});
