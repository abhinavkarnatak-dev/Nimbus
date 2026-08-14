import { redactSecrets } from '../logging/redact.js';
import { LlmError } from './errors.js';
import { LLM_LIMITS } from './limits.js';
import type { Message } from './provider.js';

export const TRUNCATION_NOTE = '\n[trimmed by Nimbus]';

export interface PreparedMessages {
  messages: Message[];
  droppedMessages: number;
  droppedChars: number;
  redactedMessages: number;
  truncated: boolean;
}

export function charsIn(messages: readonly Message[]): number {
  return messages.reduce((total, message) => total + message.content.length, 0);
}

function clip(content: string, maxChars: number): string {
  if (content.length <= maxChars) {
    return content;
  }
  return content.slice(0, Math.max(maxChars - TRUNCATION_NOTE.length, 0)) + TRUNCATION_NOTE;
}

export function prepareMessages(
  messages: readonly Message[],
  maxChars: number = LLM_LIMITS.maxPromptChars,
): PreparedMessages {
  if (messages.length === 0) {
    throw new LlmError('LLM_REQUEST_INVALID', 'There was nothing to send.');
  }

  let redactedMessages = 0;
  let truncated = false;

  const redacted = messages.map((message) => {
    const safe = redactSecrets(message.content);

    if (safe !== message.content) {
      redactedMessages += 1;
    }

    if (message.role !== 'system') {
      return { role: message.role, content: safe };
    }

    const capped = clip(safe, LLM_LIMITS.maxSystemChars);

    if (capped !== safe) {
      truncated = true;
    }
    return { role: message.role, content: capped };
  });

  const system = redacted.filter((message) => message.role === 'system');
  const rest = redacted.filter((message) => message.role !== 'system');

  let droppedMessages = 0;
  let droppedChars = 0;

  while (rest.length > LLM_LIMITS.maxMessages) {
    const removed = rest.shift();
    droppedMessages += 1;
    droppedChars += removed?.content.length ?? 0;
  }

  while (rest.length > 1 && charsIn(system) + charsIn(rest) > maxChars) {
    const removed = rest.shift();
    droppedMessages += 1;
    droppedChars += removed?.content.length ?? 0;
  }

  const last = rest[rest.length - 1];

  if (last !== undefined) {
    const room = Math.max(maxChars - charsIn(system) - charsIn(rest) + last.content.length, 0);

    if (last.content.length > room) {
      droppedChars += last.content.length - room;
      last.content = clip(last.content, room);
      truncated = true;
    }
  }

  const output = [...system, ...rest];

  if (charsIn(output) === 0) {
    throw new LlmError('LLM_REQUEST_INVALID', 'There was nothing left to send.');
  }

  return { messages: output, droppedMessages, droppedChars, redactedMessages, truncated };
}
