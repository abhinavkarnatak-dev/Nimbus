import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { LlmError } from './errors.js';
import { CodexTextProvider, type CodexClient } from './codex-text.js';
import { capturingLogger } from './llm.fixtures.js';

const messages = [{ role: 'user' as const, content: 'find the port' }];

function client(finalResponse: string): { client: CodexClient; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    client: {
      startThread: () => ({
        run: async (prompt: string) => {
          calls.push(prompt);
          return {
            finalResponse,
            usage: { input_tokens: 12, output_tokens: 8, reasoning_output_tokens: 3 },
          } as never;
        },
        runStreamed: async () => ({}) as never,
      }),
    },
  };
}

describe('CodexTextProvider', () => {
  it('uses the Codex thread for ordinary completions and reports Codex usage', async () => {
    const fake = client('The port is in server.ts.');
    const { logger } = capturingLogger();
    const provider = new CodexTextProvider({ client: fake.client, logger });

    const result = await provider.complete({ messages });

    expect(result.text).toBe('The port is in server.ts.');
    expect(result.report.provider).toBe('codex');
    expect(result.report.usage).toEqual({
      promptTokens: 12,
      completionTokens: 8,
      reasoningTokens: 3,
      totalTokens: 20,
    });
    expect(fake.calls[0]).toContain('[user]\nfind the port');
  });

  it('validates structured responses before returning them', async () => {
    const fake = client('{"ok":true}');
    const { logger } = capturingLogger();
    const provider = new CodexTextProvider({ client: fake.client, logger });

    const result = await provider.completeStructured({
      messages,
      schema: z.object({ ok: z.boolean() }),
      schemaName: 'result',
      jsonSchema: { type: 'object' },
    });

    expect(result.value).toEqual({ ok: true });
  });

  it('refuses malformed structured responses', async () => {
    const fake = client('not json');
    const { logger } = capturingLogger();
    const provider = new CodexTextProvider({ client: fake.client, logger });

    await expect(
      provider.completeStructured({
        messages,
        schema: z.object({ ok: z.boolean() }),
        schemaName: 'result',
      }),
    ).rejects.toMatchObject({ code: 'LLM_SCHEMA_REFUSED' } satisfies Partial<LlmError>);
  });
});
