import type { LlmConfig } from '../config/load.js';
import type { Logger } from '../logging/logger.js';
import { LlmError } from './errors.js';
import { FakeTextProvider, type FakeTextOptions } from './fake-text.js';
import { FakeVisionProvider, type FakeVisionOptions } from './fake-vision.js';
import { GeminiTextProvider } from './gemini-text.js';
import { GeminiVisionProvider } from './gemini.js';
import { GroqTextProvider } from './groq.js';
import { DEFAULT_TEXT_MODEL, DEFAULT_VISION_MODEL, findModel, type ModelFacts } from './models.js';
import type { TextProvider, VisionProvider } from './provider.js';

export interface LlmFactoryOptions {
  config: LlmConfig;
  logger: Logger;
  fakeText?: FakeTextOptions;
  fakeVision?: FakeVisionOptions;
}

function chosenModel(configured: string | undefined, fallback: string): string {
  return configured === undefined || configured.trim() === '' ? fallback : configured.trim();
}

function factsFor(id: string, wants: 'text' | 'vision'): ModelFacts {
  const facts = findModel(id);

  if (facts === null) {
    throw new LlmError('LLM_MODEL_UNKNOWN', 'That model is not one Nimbus knows about.', {
      detail: id,
    });
  }

  if (wants === 'vision' && !facts.vision) {
    throw new LlmError('LLM_MODEL_UNKNOWN', 'That model cannot look at images.', { detail: id });
  }
  return facts;
}

function keyFor(config: LlmConfig, provider: ModelFacts['provider']): string | null {
  const key = provider === 'gemini' ? config.geminiApiKey : config.groqApiKey;
  return key === undefined || key.trim() === '' ? null : key;
}

export function createTextProvider(options: LlmFactoryOptions): TextProvider {
  const { config, logger } = options;
  const model = chosenModel(config.defaultTextModel, DEFAULT_TEXT_MODEL);
  const facts = factsFor(model, 'text');
  const key = keyFor(config, facts.provider);

  if (key === null) {
    logger.warn(
      { provider: facts.provider },
      'the text provider has no API key, using the fake text provider',
    );
    return new FakeTextProvider({ defaultModel: model, ...options.fakeText });
  }

  if (facts.provider === 'gemini') {
    return new GeminiTextProvider({ apiKey: key, logger, defaultModel: model });
  }
  return new GroqTextProvider({ apiKey: key, logger, defaultModel: model });
}

export function createVisionProvider(options: LlmFactoryOptions): VisionProvider {
  const { config, logger } = options;
  const model = chosenModel(config.defaultVisionModel, DEFAULT_VISION_MODEL);
  const facts = factsFor(model, 'vision');
  const key = keyFor(config, facts.provider);

  if (key === null) {
    logger.warn(
      { provider: facts.provider },
      'the vision provider has no API key, using the fake vision provider',
    );
    return new FakeVisionProvider({ defaultModel: model, ...options.fakeVision });
  }

  if (facts.provider !== 'gemini') {
    throw new LlmError('LLM_MODEL_UNKNOWN', 'Only Gemini describes images today.', {
      detail: model,
    });
  }
  return new GeminiVisionProvider({ apiKey: key, logger, defaultModel: model });
}
