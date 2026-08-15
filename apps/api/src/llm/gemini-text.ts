import type { CallReport } from '@nimbus/contracts';

import type { Logger } from '../logging/logger.js';
import { prepareMessages } from './context.js';
import { LlmError } from './errors.js';
import { GEMINI_BASE, readGeminiText, readGeminiUsage, type GeminiOptions } from './gemini.js';
import { describeIssues, issueCodes, parseJson } from './groq.js';
import { ProviderRunner } from './http.js';
import { LLM_LIMITS } from './limits.js';
import { DEFAULT_GEMINI_TEXT_MODEL, findModel } from './models.js';
import {
  buildReport,
  type CompleteRequest,
  type CompleteResult,
  type Message,
  type StructuredRequest,
  type StructuredResult,
  type TextProvider,
} from './provider.js';

export interface GeminiContent {
  role: 'user' | 'model';
  parts: { text: string }[];
}

export interface GeminiRequestParts {
  systemInstruction: { parts: { text: string }[] } | null;
  contents: GeminiContent[];
}

export function toGeminiParts(messages: readonly Message[]): GeminiRequestParts {
  const system: string[] = [];
  const contents: GeminiContent[] = [];

  for (const message of messages) {
    if (message.role === 'system') {
      system.push(message.content);
      continue;
    }

    const role = message.role === 'assistant' ? 'model' : 'user';
    const last = contents[contents.length - 1];

    if (last?.role === role) {
      last.parts.push({ text: message.content });
      continue;
    }
    contents.push({ role, parts: [{ text: message.content }] });
  }

  if (contents.length === 0) {
    throw new LlmError('LLM_REQUEST_INVALID', 'There was nothing to ask the model.');
  }

  return {
    systemInstruction: system.length === 0 ? null : { parts: [{ text: system.join('\n\n') }] },
    contents,
  };
}

export function outputBudget(requested: number | undefined, model: string): number {
  const asked = requested ?? LLM_LIMITS.maxOutputTokens;
  return findModel(model)?.thinks === false ? asked : asked + LLM_LIMITS.geminiThinkingHeadroom;
}

export function thinkingBudget(model: string): number | null {
  return findModel(model)?.thinks === false ? null : LLM_LIMITS.geminiThinkingHeadroom;
}

export function truncationDetail(model: string, allowed: number, body: unknown): string {
  const usage = readGeminiUsage((body as { usageMetadata?: unknown } | null)?.usageMetadata);

  return `${model} was allowed ${String(allowed)} tokens, spent ${String(
    usage.reasoningTokens,
  )} thinking and wrote ${String(usage.completionTokens)}`;
}

export class GeminiTextProvider implements TextProvider {
  readonly name = 'gemini' as const;

  readonly real = true;

  readonly defaultModel: string;

  private readonly apiKey: string;

  private readonly logger: Logger;

  private readonly timeoutMs: number;

  private readonly baseUrl: string;

  private readonly maxAttempts: number;

  private readonly random: (() => number) | undefined;

  constructor(options: GeminiOptions) {
    if (options.apiKey.trim() === '') {
      throw new LlmError('LLM_NOT_CONFIGURED', 'Gemini is not set up.');
    }

    this.apiKey = options.apiKey;
    this.logger = options.logger;
    this.defaultModel = options.defaultModel ?? DEFAULT_GEMINI_TEXT_MODEL;
    this.timeoutMs = options.timeoutMs ?? LLM_LIMITS.requestTimeoutMs;
    this.baseUrl = options.baseUrl ?? GEMINI_BASE;
    this.maxAttempts = options.maxAttempts ?? LLM_LIMITS.maxAttempts;
    this.random = options.random;
  }

  async complete(request: CompleteRequest): Promise<CompleteResult> {
    const model = request.model ?? this.defaultModel;
    const prepared = prepareMessages(request.messages);
    const { body, attempts, durationMs } = await this.send(model, prepared.messages, request, null);
    const found = readGeminiText(body);

    if (found.hitLimit) {
      throw new LlmError('LLM_TRUNCATED', 'The model ran out of room before it finished.', {
        detail: truncationDetail(model, outputBudget(request.maxOutputTokens, model), body),
      });
    }

    return { text: found.text, report: this.report(model, body, attempts, durationMs) };
  }

  async completeStructured<T>(request: StructuredRequest<T>): Promise<StructuredResult<T>> {
    const model = request.model ?? this.defaultModel;
    const shape =
      request.jsonSchema === undefined
        ? { responseMimeType: 'application/json' }
        : { responseMimeType: 'application/json', responseJsonSchema: request.jsonSchema };

    let messages = prepareMessages(request.messages).messages;
    let lastCodes: string | undefined;

    for (let round = 0; round <= LLM_LIMITS.schemaRepairAttempts; round += 1) {
      const { body, attempts, durationMs } = await this.send(model, messages, request, shape);
      const report = this.report(model, body, attempts, durationMs);
      const found = readGeminiText(body);

      if (found.hitLimit) {
        throw new LlmError('LLM_TRUNCATED', 'The model ran out of room before it finished.', {
          detail: truncationDetail(model, outputBudget(request.maxOutputTokens, model), body),
        });
      }

      const parsed = parseJson(found.text);
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
    shape: Readonly<Record<string, unknown>> | null,
  ): Promise<{ body: unknown; attempts: number; durationMs: number }> {
    const runner = new ProviderRunner({ provider: this.name, model, logger: this.logger });
    const parts = toGeminiParts(messages);
    const thinking = thinkingBudget(model);

    return await runner.send({
      url: `${this.baseUrl}/${model}:generateContent`,
      headers: { 'x-goog-api-key': this.apiKey },
      body: {
        ...(parts.systemInstruction === null ? {} : { systemInstruction: parts.systemInstruction }),
        contents: parts.contents,
        generationConfig: {
          temperature: request.temperature ?? 0,
          maxOutputTokens: outputBudget(request.maxOutputTokens, model),
          ...(thinking === null ? {} : { thinkingConfig: { thinkingBudget: thinking } }),
          ...(shape ?? {}),
        },
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
      usage: readGeminiUsage((body as { usageMetadata?: unknown } | null)?.usageMetadata),
      attempts,
      durationMs,
    });
  }
}
