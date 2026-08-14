import { z } from 'zod';

import { createLogger, type Logger } from '../logging/logger.js';

export const SECRET_PHRASE = 'the elephant walked into the compiler at midnight';

export const PRIVATE_PROMPT = [
  'export function chargeCard(amount: number): void {',
  `  audit("${SECRET_PHRASE}");`,
  '}',
].join('\n');

export const AnswerSchema = z.strictObject({
  summary: z.string().min(1).max(300),
  files: z.array(z.string().min(1)).max(5),
  confident: z.boolean(),
});

export const ANSWER_JSON_SCHEMA: Readonly<Record<string, unknown>> = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    files: { type: 'array', items: { type: 'string' } },
    confident: { type: 'boolean' },
  },
  required: ['summary', 'files', 'confident'],
  additionalProperties: false,
};

export const GOOD_ANSWER = {
  summary: 'it is in the router',
  files: ['src/router.ts'],
  confident: true,
};

export interface CapturedLogger {
  logger: Logger;
  lines: string[];
  text: () => string;
}

export function capturingLogger(): CapturedLogger {
  const lines: string[] = [];

  const logger = createLogger({
    level: 'trace',
    environment: 'test',
    destination: {
      write(chunk: string): void {
        lines.push(chunk);
      },
    },
  });

  return { logger, lines, text: () => lines.join('\n') };
}

export function groqReply(content: string, overrides: Record<string, unknown> = {}): unknown {
  return {
    choices: [{ message: { content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 100, completion_tokens: 40 },
    ...overrides,
  };
}

export function geminiReply(text: string, overrides: Record<string, unknown> = {}): unknown {
  return {
    candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }],
    usageMetadata: { promptTokenCount: 1_000, candidatesTokenCount: 30, thoughtsTokenCount: 20 },
    ...overrides,
  };
}

export interface StubbedCall {
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

export interface Stub {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
  networkError?: boolean;
  delayMs?: number;
}

export interface FetchStub {
  calls: StubbedCall[];
  restore: () => void;
}

function addressOf(input: string | URL | Request): string {
  if (typeof input === 'string') {
    return input;
  }
  return input instanceof URL ? input.href : input.url;
}

function headersOf(raw: RequestInit['headers']): Record<string, string> {
  const headers: Record<string, string> = {};

  if (raw === undefined) {
    return headers;
  }
  new Headers(raw).forEach((value, key) => {
    headers[key] = value;
  });
  return headers;
}

export function stubFetch(stubs: readonly Stub[]): FetchStub {
  const original = globalThis.fetch;
  const queue = [...stubs];
  const calls: StubbedCall[] = [];

  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const stub = queue.shift() ?? { status: 200, body: {} };

    calls.push({
      url: addressOf(input),
      headers: headersOf(init?.headers),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
    });

    const signal = init?.signal ?? undefined;

    if (stub.delayMs !== undefined) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, stub.delayMs);
        signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            reject(new DOMException('aborted', 'AbortError'));
          },
          { once: true },
        );
      });
    }

    if (signal?.aborted === true) {
      throw new DOMException('aborted', 'AbortError');
    }

    if (stub.networkError === true) {
      throw new TypeError('fetch failed');
    }

    return new Response(JSON.stringify(stub.body ?? {}), {
      status: stub.status ?? 200,
      headers: { 'Content-Type': 'application/json', ...stub.headers },
    });
  };

  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}
