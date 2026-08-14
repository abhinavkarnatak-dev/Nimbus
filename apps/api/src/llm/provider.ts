import type { CallCost, CallReport, LlmProviderName, TokenUsage } from '@nimbus/contracts';
import type { ZodType } from 'zod';

import { LlmError } from './errors.js';
import { LLM_LIMITS } from './limits.js';
import { ratesFor } from './models.js';

export const MESSAGE_ROLES = ['system', 'user', 'assistant'] as const;

export type MessageRole = (typeof MESSAGE_ROLES)[number];

export interface Message {
  role: MessageRole;
  content: string;
}

export interface CompleteRequest {
  messages: readonly Message[];
  model?: string;
  maxOutputTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
}

export interface CompleteResult {
  text: string;
  report: CallReport;
}

export interface StructuredRequest<T> extends CompleteRequest {
  schema: ZodType<T>;
  schemaName: string;
  jsonSchema?: Readonly<Record<string, unknown>>;
}

export interface StructuredResult<T> {
  value: T;
  report: CallReport;
}

export interface TextProvider {
  readonly name: LlmProviderName;
  readonly real: boolean;
  readonly defaultModel: string;
  complete(request: CompleteRequest): Promise<CompleteResult>;
  completeStructured<T>(request: StructuredRequest<T>): Promise<StructuredResult<T>>;
}

export const VISION_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;

export type VisionMimeType = (typeof VISION_MIME_TYPES)[number];

export interface DescribeImageRequest {
  bytes: Buffer;
  mimeType: VisionMimeType;
  prompt?: string;
  model?: string;
  signal?: AbortSignal;
}

export interface DescribeImageResult {
  description: string;
  truncated: boolean;
  report: CallReport;
}

export interface VisionProvider {
  readonly name: LlmProviderName;
  readonly real: boolean;
  readonly defaultModel: string;
  describeImage(request: DescribeImageRequest): Promise<DescribeImageResult>;
}

export function assertDescribableImage(request: DescribeImageRequest): void {
  if (!VISION_MIME_TYPES.includes(request.mimeType)) {
    throw new LlmError('LLM_REQUEST_INVALID', 'That kind of image cannot be described.');
  }

  if (request.bytes.byteLength === 0) {
    throw new LlmError('LLM_REQUEST_INVALID', 'That image is empty.');
  }

  if (request.bytes.byteLength > LLM_LIMITS.visionMaxBytes) {
    throw new LlmError('LLM_INPUT_TOO_LARGE', 'That image is too large to describe.');
  }
}

export function emptyUsage(): TokenUsage {
  return { promptTokens: 0, completionTokens: 0, reasoningTokens: 0, totalTokens: 0 };
}

export function addUsage(left: TokenUsage, right: TokenUsage): TokenUsage {
  return {
    promptTokens: left.promptTokens + right.promptTokens,
    completionTokens: left.completionTokens + right.completionTokens,
    reasoningTokens: left.reasoningTokens + right.reasoningTokens,
    totalTokens: left.totalTokens + right.totalTokens,
  };
}

export function costOf(model: string, usage: TokenUsage): CallCost {
  const rates = ratesFor(model);
  const billedOutput = usage.completionTokens + usage.reasoningTokens;

  return {
    microCents: usage.promptTokens * rates.input + billedOutput * rates.output,
    estimated: true,
  };
}

export function buildReport(input: {
  provider: LlmProviderName;
  model: string;
  usage: TokenUsage;
  attempts: number;
  durationMs: number;
}): CallReport {
  return {
    provider: input.provider,
    model: input.model,
    usage: input.usage,
    cost: costOf(input.model, input.usage),
    attempts: input.attempts,
    durationMs: input.durationMs,
  };
}
