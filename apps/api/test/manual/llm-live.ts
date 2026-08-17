import sharp from 'sharp';
import { z } from 'zod';

import { loadConfig } from '../../src/config/load.js';
import {
  GeminiTextProvider,
  GeminiVisionProvider,
  DEFAULT_LIGHT_MODEL,
  DEFAULT_REASONING_MODEL,
  SessionBudget,
  DEFAULT_TEXT_MODEL,
  DEFAULT_VISION_MODEL,
} from '../../src/llm/index.js';
import type { LlmError } from '../../src/llm/index.js';
import { createLogger } from '../../src/logging/logger.js';

const AnswerSchema = z.strictObject({
  summary: z.string().min(1).max(300),
  files: z.array(z.string().min(1)).max(5),
  confident: z.boolean(),
});

const ANSWER_JSON_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    files: { type: 'array', items: { type: 'string' } },
    confident: { type: 'boolean' },
  },
  required: ['summary', 'files', 'confident'],
  additionalProperties: false,
};

function heading(title: string): void {
  process.stdout.write(`\n${title}\n${'-'.repeat(title.length)}\n`);
}

function line(label: string, value: unknown): void {
  process.stdout.write(`  ${label.padEnd(26)} ${String(value)}\n`);
}

function money(microCents: number): string {
  return `${(microCents / 100_000).toFixed(4)} cents`;
}

async function screenshot(): Promise<Buffer> {
  const svg = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="460" height="150"><rect width="460" height="150" fill="#b00020"/><text x="24" y="60" font-family="monospace" font-size="28" fill="white">TypeError: undefined</text><text x="24" y="100" font-family="monospace" font-size="20" fill="white">at src/auth/login.ts:42</text></svg>',
  );
  return await sharp(svg).png().toBuffer();
}

async function main(): Promise<void> {
  if (process.env['LLM_LIVE'] !== '1') {
    process.stdout.write('Set LLM_LIVE=1 to call the real providers.\n');
    return;
  }

  const config = loadConfig();
  const logger = createLogger({ level: 'warn', environment: config.env });
  const budget = new SessionBudget();

  const geminiApiKey = (process.env['GEMINI_API_KEY'] ?? '').trim();

  if (geminiApiKey === '') {
    throw new Error('GEMINI_API_KEY must be set in .env for this demo');
  }

  const text = new GeminiTextProvider({ apiKey: geminiApiKey, logger });
  const vision = new GeminiVisionProvider({ apiKey: geminiApiKey, logger });

  heading('Plain completion');
  budget.assertCanSpend();
  const plain = await text.complete({
    messages: [
      { role: 'system', content: 'You answer about code in one short sentence.' },
      { role: 'user', content: 'What does an Express CORS middleware do?' },
    ],
  });
  budget.charge(plain.report);
  line('model', plain.report.model);
  line('answer', `${plain.text.slice(0, 90)}...`);
  line(
    'tokens in and out',
    `${String(plain.report.usage.promptTokens)} / ${String(plain.report.usage.completionTokens)}`,
  );
  line('cost', money(plain.report.cost.microCents));

  heading('Structured, on the light model');
  const loose = await text.completeStructured({
    model: DEFAULT_LIGHT_MODEL,
    schema: AnswerSchema,
    schemaName: 'answer',
    messages: [
      { role: 'system', content: 'You answer about code.' },
      { role: 'user', content: 'Which one file would hold CORS middleware in an Express app?' },
    ],
  });
  budget.charge(loose.report);
  line('mode', 'json, validated locally');
  line('summary', loose.value.summary.slice(0, 70));
  line('files', loose.value.files.join(', '));
  line('cost', money(loose.report.cost.microCents));

  heading('Structured, on a model with json_schema');
  const strict = await text.completeStructured({
    model: DEFAULT_REASONING_MODEL,
    schema: AnswerSchema,
    schemaName: 'answer',
    jsonSchema: ANSWER_JSON_SCHEMA,
    messages: [
      { role: 'system', content: 'You answer about code.' },
      { role: 'user', content: 'Which one file would hold CORS middleware in an Express app?' },
    ],
  });
  budget.charge(strict.report);
  line('mode', 'json_schema, validated locally');
  line('summary', strict.value.summary.slice(0, 70));
  line('files', strict.value.files.join(', '));
  line('reasoning tokens', strict.report.usage.reasoningTokens);
  line('cost', money(strict.report.cost.microCents));

  heading('Describing a screenshot');
  const png = await screenshot();
  const described = await vision.describeImage({ bytes: png, mimeType: 'image/png' });
  budget.charge(described.report);
  line('model', described.report.model);
  line('description', described.description);
  line('image tokens', described.report.usage.promptTokens);
  line('thinking tokens', described.report.usage.reasoningTokens);
  line('cost', money(described.report.cost.microCents));

  heading('A request that must not be retried');
  const started = Date.now();
  try {
    await text.complete({
      model: 'no-such-model-at-all',
      messages: [{ role: 'user', content: 'hi' }],
    });
    line('result', 'it answered, which it should not have');
  } catch (error) {
    const failure = error as LlmError;
    line('code', failure.code);
    line('status', failure.status);
    line('detail', failure.detail);
    line('retryable', failure.retryable);
    line('took', `${String(Date.now() - started)} ms, so it did not back off`);
    line('key in message', JSON.stringify(failure.message).includes(geminiApiKey));
  }

  heading('Cancelling in flight');
  const controller = new AbortController();
  setTimeout(() => {
    controller.abort();
  }, 30);
  try {
    await text.complete({
      messages: [{ role: 'user', content: 'Write a long essay about distributed systems.' }],
      maxOutputTokens: 2000,
      signal: controller.signal,
    });
    line('result', 'it finished before the cancel landed');
  } catch (error) {
    line('code', (error as LlmError).code);
  }

  heading('What the session spent');
  const state = budget.state();
  line('calls', `${String(state.calls)} of ${String(state.callLimit)}`);
  line('tokens', `${String(state.tokensUsed)} of ${String(state.tokenLimit)}`);
  line('money', `${money(state.microCentsUsed)}, estimated`);
  line('exhausted', state.exhausted);
  line('default text model', DEFAULT_TEXT_MODEL);
  line('default vision model', DEFAULT_VISION_MODEL);
}

await main();
