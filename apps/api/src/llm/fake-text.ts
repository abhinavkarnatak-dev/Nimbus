import type { CallReport, LlmProviderName, TokenUsage } from '@nimbus/contracts';

import { prepareMessages } from './context.js';
import { LlmError } from './errors.js';
import { issueCodes } from './json.js';
import { LLM_LIMITS } from './limits.js';
import { DEFAULT_TEXT_MODEL, findModel } from './models.js';
import {
  buildReport,
  type CompleteRequest,
  type CompleteResult,
  type Message,
  type StructuredRequest,
  type StructuredResult,
  type TextProvider,
} from './provider.js';

export interface FakeAnswer {
  text?: string;
  value?: unknown;
  fails?: LlmError;
  usage?: Partial<TokenUsage>;
}

export interface FakeTextOptions {
  answers?: readonly FakeAnswer[];
  defaultAnswer?: FakeAnswer;
  defaultModel?: string;
}

export interface RecordedCall {
  model: string;
  messages: Message[];
  structured: boolean;
  schemaName: string | null;
  cancelled: boolean;
}

function usageFrom(partial: Partial<TokenUsage> | undefined, text: string): TokenUsage {
  const completionTokens = partial?.completionTokens ?? Math.ceil(text.length / 4);
  const promptTokens = partial?.promptTokens ?? 20;
  const reasoningTokens = partial?.reasoningTokens ?? 0;

  return {
    promptTokens,
    completionTokens,
    reasoningTokens,
    totalTokens: partial?.totalTokens ?? promptTokens + completionTokens + reasoningTokens,
  };
}

export class FakeTextProvider implements TextProvider {
  readonly name: LlmProviderName;

  readonly real = false;

  readonly defaultModel: string;

  readonly calls: RecordedCall[] = [];

  private readonly answers: FakeAnswer[];

  private readonly defaultAnswer: FakeAnswer;

  constructor(options: FakeTextOptions = {}) {
    this.answers = [...(options.answers ?? [])];
    this.defaultAnswer = options.defaultAnswer ?? { text: 'a fake answer' };
    this.defaultModel = options.defaultModel ?? DEFAULT_TEXT_MODEL;
    this.name = findModel(this.defaultModel)?.provider ?? 'gemini';
  }

  queue(answer: FakeAnswer): void {
    this.answers.push(answer);
  }

  get callCount(): number {
    return this.calls.length;
  }

  async complete(request: CompleteRequest): Promise<CompleteResult> {
    const { model, answer } = this.begin(request, false, null);
    const text = answer.text ?? JSON.stringify(answer.value ?? null);

    return await Promise.resolve({
      text,
      report: this.report(model, usageFrom(answer.usage, text)),
    });
  }

  async completeStructured<T>(request: StructuredRequest<T>): Promise<StructuredResult<T>> {
    const { model, answer } = this.begin(request, true, request.schemaName);
    const candidate =
      answer.value ?? (answer.text === undefined ? undefined : safeParse(answer.text));

    const checked = request.schema.safeParse(candidate);

    if (!checked.success) {
      throw new LlmError(
        'LLM_SCHEMA_REFUSED',
        'The model could not answer in the required shape.',
        {
          detail: issueCodes(checked.error).slice(0, LLM_LIMITS.errorDetailMaxChars),
        },
      );
    }

    const text = JSON.stringify(checked.data);
    return await Promise.resolve({
      value: checked.data,
      report: this.report(model, usageFrom(answer.usage, text)),
    });
  }

  private begin(
    request: CompleteRequest,
    structured: boolean,
    schemaName: string | null,
  ): { model: string; answer: FakeAnswer } {
    if (request.signal?.aborted === true) {
      throw new LlmError('LLM_CANCELLED', 'That request was cancelled.');
    }

    const model = request.model ?? this.defaultModel;
    const prepared = prepareMessages(request.messages);

    this.calls.push({
      model,
      messages: prepared.messages,
      structured,
      schemaName,
      cancelled: false,
    });

    const answer = this.answers.shift() ?? this.defaultAnswer;

    if (answer.fails !== undefined) {
      throw answer.fails;
    }
    return { model, answer };
  }

  private report(model: string, usage: TokenUsage): CallReport {
    return buildReport({
      provider: findModel(model)?.provider ?? this.name,
      model,
      usage,
      attempts: 1,
      durationMs: 1,
    });
  }
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}
