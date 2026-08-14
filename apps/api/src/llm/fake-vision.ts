import type { CallReport, LlmProviderName, TokenUsage } from '@nimbus/contracts';

import { LlmError } from './errors.js';
import { LLM_LIMITS } from './limits.js';
import { DEFAULT_VISION_MODEL, findModel } from './models.js';
import {
  assertDescribableImage,
  buildReport,
  type DescribeImageRequest,
  type DescribeImageResult,
  type VisionProvider,
} from './provider.js';

export interface FakeDescription {
  description?: string;
  fails?: LlmError;
  usage?: Partial<TokenUsage>;
}

export interface FakeVisionOptions {
  descriptions?: readonly FakeDescription[];
  defaultDescription?: FakeDescription;
  defaultModel?: string;
}

export interface RecordedImage {
  model: string;
  mimeType: string;
  bytes: number;
  prompt: string | null;
}

export class FakeVisionProvider implements VisionProvider {
  readonly name: LlmProviderName;

  readonly real = false;

  readonly defaultModel: string;

  readonly calls: RecordedImage[] = [];

  private readonly descriptions: FakeDescription[];

  private readonly defaultDescription: FakeDescription;

  constructor(options: FakeVisionOptions = {}) {
    this.descriptions = [...(options.descriptions ?? [])];
    this.defaultDescription = options.defaultDescription ?? {
      description: 'a fake description of an image',
    };
    this.defaultModel = options.defaultModel ?? DEFAULT_VISION_MODEL;
    this.name = findModel(this.defaultModel)?.provider ?? 'gemini';
  }

  queue(description: FakeDescription): void {
    this.descriptions.push(description);
  }

  async describeImage(request: DescribeImageRequest): Promise<DescribeImageResult> {
    if (request.signal?.aborted === true) {
      throw new LlmError('LLM_CANCELLED', 'That request was cancelled.');
    }

    assertDescribableImage(request);

    const model = request.model ?? this.defaultModel;

    this.calls.push({
      model,
      mimeType: request.mimeType,
      bytes: request.bytes.byteLength,
      prompt: request.prompt ?? null,
    });

    const next = this.descriptions.shift() ?? this.defaultDescription;

    if (next.fails !== undefined) {
      throw next.fails;
    }

    const full = next.description ?? '';

    if (full.trim() === '') {
      throw new LlmError('LLM_RESPONSE_MALFORMED', 'The model did not describe the image.');
    }

    const capped = full.slice(0, LLM_LIMITS.visionDescriptionMaxChars);
    const usage: TokenUsage = {
      promptTokens: next.usage?.promptTokens ?? 1_000,
      completionTokens: next.usage?.completionTokens ?? Math.ceil(capped.length / 4),
      reasoningTokens: next.usage?.reasoningTokens ?? 0,
      totalTokens: 0,
    };
    usage.totalTokens =
      next.usage?.totalTokens ??
      usage.promptTokens + usage.completionTokens + usage.reasoningTokens;

    return await Promise.resolve({
      description: capped,
      truncated: capped.length < full.length,
      report: this.report(model, usage),
    });
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
