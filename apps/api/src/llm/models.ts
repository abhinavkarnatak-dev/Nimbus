import type { LlmProviderName } from '@nimbus/contracts';

export interface ModelFacts {
  id: string;
  provider: LlmProviderName;
  contextTokens: number;
  inputMicroCentsPerToken: number;
  outputMicroCentsPerToken: number;
  structuredOutput: 'json_schema' | 'json_object';
  vision: boolean;
  thinks: boolean;
  selectable: boolean;
}

export const DEFAULT_TEXT_MODEL = 'gemini-3.6-flash';
export const DEFAULT_VISION_MODEL = 'gemini-3.5-flash-lite';
export const DEFAULT_LIGHT_MODEL = 'gemini-3.5-flash-lite';
export const DEFAULT_REASONING_MODEL = 'gemini-3.6-flash';

export const DEFAULT_GEMINI_TEXT_MODEL = 'gemini-3.6-flash';

export const KNOWN_MODELS: readonly ModelFacts[] = [
  {
    id: 'gemini-3.6-flash',
    provider: 'gemini',
    contextTokens: 1_048_576,
    inputMicroCentsPerToken: 30,
    outputMicroCentsPerToken: 250,
    structuredOutput: 'json_schema',
    vision: true,
    thinks: true,
    selectable: true,
  },
  {
    id: 'gemini-3.5-flash-lite',
    provider: 'gemini',
    contextTokens: 1_048_576,
    inputMicroCentsPerToken: 10,
    outputMicroCentsPerToken: 40,
    structuredOutput: 'json_schema',
    vision: true,
    thinks: false,
    selectable: true,
  },
];

const BY_ID = new Map(KNOWN_MODELS.map((model) => [model.id, model]));

export function findModel(id: string): ModelFacts | null {
  return BY_ID.get(id) ?? null;
}

export function defaultTextModelFor(_providers: readonly LlmProviderName[]): string {
  return DEFAULT_GEMINI_TEXT_MODEL;
}

export function highestInputRate(): number {
  return Math.max(...KNOWN_MODELS.map((model) => model.inputMicroCentsPerToken));
}

export function highestOutputRate(): number {
  return Math.max(...KNOWN_MODELS.map((model) => model.outputMicroCentsPerToken));
}

export function ratesFor(id: string): { input: number; output: number; known: boolean } {
  const model = findModel(id);

  if (model === null) {
    return { input: highestInputRate(), output: highestOutputRate(), known: false };
  }
  return {
    input: model.inputMicroCentsPerToken,
    output: model.outputMicroCentsPerToken,
    known: true,
  };
}
