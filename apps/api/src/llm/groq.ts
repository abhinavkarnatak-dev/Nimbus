import type { CallReport, TokenUsage } from '@nimbus/contracts';

import type { Logger } from '../logging/logger.js';
import { prepareMessages } from './context.js';
import { LlmError, isLlmError } from './errors.js';
import { ProviderRunner } from './http.js';
import { LLM_LIMITS } from './limits.js';
import { DEFAULT_GROQ_TEXT_MODEL, findModel } from './models.js';
import {
  buildReport,
  type CompleteRequest,
  type CompleteResult,
  type Message,
  type StructuredRequest,
  type StructuredResult,
  type TextProvider,
} from './provider.js';

export const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
export const JSON_REMINDER =
  'Reply with one JSON object and nothing else. No explanation before or after it, and no markdown code fence around it.';

export interface GroqOptions {
  apiKey: string;
  logger: Logger;
  defaultModel?: string;
  timeoutMs?: number;
  url?: string;
  maxAttempts?: number;
  random?: () => number;
}

interface GroqChoice {
  message?: { content?: unknown };
  finish_reason?: unknown;
}

interface GroqBody {
  choices?: unknown;
  usage?: unknown;
}

export function readGroqUsage(raw: unknown): TokenUsage {
  const usage = (raw ?? {}) as {
    prompt_tokens?: unknown;
    completion_tokens?: unknown;
    completion_tokens_details?: { reasoning_tokens?: unknown };
  };

  const promptTokens = whole(usage.prompt_tokens);
  const completion = whole(usage.completion_tokens);
  const reasoningTokens = Math.min(
    whole(usage.completion_tokens_details?.reasoning_tokens),
    completion,
  );
  const completionTokens = completion - reasoningTokens;

  return {
    promptTokens,
    completionTokens,
    reasoningTokens,
    totalTokens: promptTokens + completionTokens + reasoningTokens,
  };
}

function whole(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

function firstChoice(body: unknown): GroqChoice {
  const choices = (body as GroqBody | null)?.choices;

  if (!Array.isArray(choices) || choices.length === 0) {
    throw new LlmError('LLM_RESPONSE_MALFORMED', 'The model sent back nothing usable.');
  }
  return choices[0] as GroqChoice;
}

export function readText(body: unknown): string {
  const choice = firstChoice(body);
  const finish = choice.finish_reason;

  if (finish === 'content_filter') {
    throw new LlmError('LLM_CONTENT_REFUSED', 'The model refused to answer that.');
  }

  const content = choice.message?.content;

  if (typeof content !== 'string' || content === '') {
    throw new LlmError('LLM_RESPONSE_MALFORMED', 'The model sent back nothing usable.');
  }

  if (finish === 'length') {
    throw new LlmError('LLM_TRUNCATED', 'The model ran out of room before it finished.');
  }
  return content;
}

export function mentionsJson(messages: readonly Message[]): boolean {
  return messages.some((message) => message.content.toLowerCase().includes('json'));
}

export function withJsonReminder(messages: readonly Message[]): Message[] {
  if (mentionsJson(messages)) {
    return [...messages];
  }

  const copy = messages.map((message) => ({ ...message }));
  const last = copy[copy.length - 1];

  if (last === undefined) {
    return copy;
  }
  last.content = `${last.content}\n\n${JSON_REMINDER}`;
  return copy;
}

export const UNUSABLE_ANSWER_REPAIRS: Readonly<Record<string, string>> = {
  tool_use_failed:
    'That answer tried to call a tool. There are no tools attached to this request, and no tool name you may remember from anywhere else exists here. Send the whole answer again as one JSON object matching the required shape, and call nothing.',
  json_validate_failed:
    'That answer was not one JSON object of the required shape. Send it again as one JSON object, with every required field, no field that is not in the shape, and nothing written outside the object.',
};

export function unusableAnswer(error: unknown): { code: string; repair: string } | null {
  if (!isLlmError(error) || error.providerCode === null) {
    return null;
  }

  const repair = UNUSABLE_ANSWER_REPAIRS[error.providerCode];

  return repair === undefined ? null : { code: error.providerCode, repair };
}

export class GroqTextProvider implements TextProvider {
  readonly name = 'groq' as const;

  readonly real = true;

  readonly defaultModel: string;

  private readonly apiKey: string;

  private readonly logger: Logger;

  private readonly timeoutMs: number;

  private readonly url: string;

  private readonly maxAttempts: number;

  private readonly random: (() => number) | undefined;

  constructor(options: GroqOptions) {
    if (options.apiKey.trim() === '') {
      throw new LlmError('LLM_NOT_CONFIGURED', 'Groq is not set up.');
    }

    this.apiKey = options.apiKey;
    this.logger = options.logger;
    this.defaultModel = options.defaultModel ?? DEFAULT_GROQ_TEXT_MODEL;
    this.timeoutMs = options.timeoutMs ?? LLM_LIMITS.requestTimeoutMs;
    this.url = options.url ?? GROQ_URL;
    this.maxAttempts = options.maxAttempts ?? LLM_LIMITS.maxAttempts;
    this.random = options.random;
  }

  async complete(request: CompleteRequest): Promise<CompleteResult> {
    const model = request.model ?? this.defaultModel;
    const prepared = prepareMessages(request.messages);
    const { body, attempts, durationMs } = await this.send(model, prepared.messages, request, null);

    return {
      text: readText(body),
      report: this.report(model, body, attempts, durationMs),
    };
  }

  async completeStructured<T>(request: StructuredRequest<T>): Promise<StructuredResult<T>> {
    const model = request.model ?? this.defaultModel;
    const facts = findModel(model);
    const useSchema = facts?.structuredOutput === 'json_schema' && request.jsonSchema !== undefined;

    const format = useSchema
      ? {
          type: 'json_schema',
          json_schema: { name: request.schemaName, schema: request.jsonSchema, strict: true },
        }
      : { type: 'json_object' };

    let messages = withJsonReminder(prepareMessages(request.messages).messages);
    let lastCodes: string | undefined;

    for (let round = 0; round <= LLM_LIMITS.schemaRepairAttempts; round += 1) {
      let sent: { body: unknown; attempts: number; durationMs: number };

      try {
        sent = await this.send(model, messages, request, format);
      } catch (error) {
        const unusable = unusableAnswer(error);

        if (unusable === null) {
          throw error;
        }

        lastCodes = unusable.code;

        this.logger.warn(
          { provider: this.name, model, round, problem: unusable.code },
          'the model answered in a way the provider could not return',
        );

        messages = [...messages, { role: 'user', content: unusable.repair }];
        continue;
      }

      const { body, attempts, durationMs } = sent;
      const report = this.report(model, body, attempts, durationMs);
      const parsed = parseJson(readText(body));

      let problem: string;
      let logged: string;

      if (parsed === null) {
        problem = 'the answer was not valid JSON';
        logged = 'not-json';
      } else {
        const checked = request.schema.safeParse(parsed);

        if (checked.success) {
          return { value: checked.data, report };
        }
        problem = describeIssues(checked.error);
        logged = issueCodes(checked.error);
      }

      lastCodes = logged;

      this.logger.warn(
        { provider: this.name, model, round, problem: logged },
        'model answer did not match the schema',
      );

      messages = [
        ...messages,
        {
          role: 'user',
          content: `That answer did not match the required shape. What was wrong: ${problem}. Send the whole object again, corrected, as one JSON object matching the ${request.schemaName} schema. Include every required field, add no fields that are not in the schema, and write nothing outside the object.`,
        },
      ];
    }

    throw new LlmError('LLM_SCHEMA_REFUSED', 'The model could not answer in the required shape.', {
      detail: (lastCodes ?? 'unknown').slice(0, LLM_LIMITS.errorDetailMaxChars),
    });
  }

  private async send(
    model: string,
    messages: readonly Message[],
    request: CompleteRequest,
    format: unknown,
  ): Promise<{ body: unknown; attempts: number; durationMs: number }> {
    const runner = new ProviderRunner({ provider: this.name, model, logger: this.logger });

    return await runner.send({
      url: this.url,
      headers: { Authorization: `Bearer ${this.apiKey}` },
      body: {
        model,
        messages: messages.map((message) => ({ role: message.role, content: message.content })),
        temperature: request.temperature ?? 0,
        max_tokens: request.maxOutputTokens ?? LLM_LIMITS.maxOutputTokens,
        ...(format === null ? {} : { response_format: format }),
      },
      timeoutMs: this.timeoutMs,
      maxAttempts: this.maxAttempts,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
      ...(this.random === undefined ? {} : { random: this.random }),
    });
  }

  private report(model: string, body: unknown, attempts: number, durationMs: number): CallReport {
    return buildReport({
      provider: this.name,
      model,
      usage: readGroqUsage((body as GroqBody | null)?.usage),
      attempts,
      durationMs,
    });
  }
}

export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

export interface SchemaIssue {
  path: PropertyKey[];
  message: string;
  code?: string;
}

export function describeIssues(error: { issues: readonly SchemaIssue[] }): string {
  return error.issues
    .slice(0, 5)
    .map((issue) => `${issue.path.map(String).join('.') || 'the answer'} ${issue.message}`)
    .join('; ');
}

export function issueCodes(error: { issues: readonly SchemaIssue[] }): string {
  return error.issues
    .slice(0, 5)
    .map((issue) => `${issue.path.map(String).join('.') || 'root'}:${issue.code ?? 'invalid'}`)
    .join(',');
}
