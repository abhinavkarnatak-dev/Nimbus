import { describe, expect, it } from 'vitest';

import { createRoutedTextProvider, createTextProvider, createVisionProvider } from './factory.js';
import { capturingLogger } from './llm.fixtures.js';
import {
  DEFAULT_GEMINI_TEXT_MODEL,
  DEFAULT_GROQ_TEXT_MODEL,
  DEFAULT_TEXT_MODEL,
  DEFAULT_VISION_MODEL,
  KNOWN_MODELS,
  findModel,
  highestInputRate,
  highestOutputRate,
  modelsFor,
  ratesFor,
} from './models.js';
import { costOf } from './provider.js';
import { RoutedTextProvider } from './routed-text.js';

describe('KNOWN_MODELS', () => {
  it('has no duplicate ids', () => {
    const ids = KNOWN_MODELS.map((model) => model.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('prices every model it knows', () => {
    for (const model of KNOWN_MODELS) {
      expect(model.inputMicroCentsPerToken).toBeGreaterThan(0);
      expect(model.outputMicroCentsPerToken).toBeGreaterThan(0);
      expect(model.contextTokens).toBeGreaterThan(0);
    }
  });

  it('knows both default models', () => {
    expect(findModel(DEFAULT_TEXT_MODEL)).not.toBeNull();
    expect(findModel(DEFAULT_VISION_MODEL)).not.toBeNull();
  });

  it('pins the defaults rather than following an alias', () => {
    expect(DEFAULT_TEXT_MODEL).not.toContain('latest');
    expect(DEFAULT_VISION_MODEL).not.toContain('latest');
  });

  it('has a vision default that can see', () => {
    expect(findModel(DEFAULT_VISION_MODEL)?.vision).toBe(true);
  });

  it('says which models spend tokens thinking', () => {
    expect(findModel('gemini-3.6-flash')?.thinks).toBe(true);
    expect(findModel('gemini-3.5-flash-lite')?.thinks).toBe(false);
  });

  it('offers a model from each provider that can hold a schema', () => {
    const schemaCapable = KNOWN_MODELS.filter((model) => model.structuredOutput === 'json_schema');
    expect(schemaCapable.some((model) => model.provider === 'groq')).toBe(true);
    expect(schemaCapable.some((model) => model.provider === 'gemini')).toBe(true);
  });

  it('has a per provider text default that belongs to that provider', () => {
    expect(findModel(DEFAULT_GROQ_TEXT_MODEL)?.provider).toBe('groq');
    expect(findModel(DEFAULT_GEMINI_TEXT_MODEL)?.provider).toBe('gemini');
  });

  it('groups models by provider', () => {
    expect(modelsFor('groq').every((model) => model.provider === 'groq')).toBe(true);
    expect(modelsFor('gemini').every((model) => model.provider === 'gemini')).toBe(true);
    expect(modelsFor('groq').length + modelsFor('gemini').length).toBe(KNOWN_MODELS.length);
  });

  it('carries no model that cannot hold a schema, because the agent asks for one every step', () => {
    for (const model of KNOWN_MODELS) {
      expect(model.structuredOutput).toBe('json_schema');
    }
  });

  it('carries no model that has been taken away', () => {
    for (const gone of ['llama-3.3-70b-versatile', 'openai/gpt-oss-20b', 'qwen/qwen3.6-27b']) {
      expect(findModel(gone)).toBeNull();
    }
  });
});

describe('ratesFor', () => {
  it('returns the price of a model it knows', () => {
    expect(ratesFor('openai/gpt-oss-120b')).toEqual({ input: 15, output: 75, known: true });
  });

  it('charges an unknown model the highest rate it knows', () => {
    expect(ratesFor('some-model-nobody-priced')).toEqual({
      input: highestInputRate(),
      output: highestOutputRate(),
      known: false,
    });
  });

  it('never treats an unknown model as free', () => {
    const rates = ratesFor('some-model-nobody-priced');
    expect(rates.input).toBeGreaterThan(0);
    expect(rates.output).toBeGreaterThan(0);
  });
});

describe('costOf', () => {
  it('multiplies tokens by the rate', () => {
    const cost = costOf('openai/gpt-oss-120b', {
      promptTokens: 100,
      completionTokens: 40,
      reasoningTokens: 0,
      totalTokens: 140,
    });

    expect(cost.microCents).toBe(100 * 15 + 40 * 75);
  });

  it('bills thinking the same as speaking', () => {
    const cost = costOf('openai/gpt-oss-120b', {
      promptTokens: 0,
      completionTokens: 0,
      reasoningTokens: 100,
      totalTokens: 100,
    });

    expect(cost.microCents).toBe(100 * 75);
  });

  it('always says it is an estimate', () => {
    const cost = costOf('openai/gpt-oss-120b', {
      promptTokens: 1,
      completionTokens: 1,
      reasoningTokens: 0,
      totalTokens: 2,
    });

    expect(cost.estimated).toBe(true);
  });
});

describe('the factory', () => {
  it('follows the model to its own provider', () => {
    const { logger } = capturingLogger();

    const gemini = createTextProvider({
      config: { geminiApiKey: 'AIza'.repeat(6), defaultTextModel: 'gemini-3.6-flash' },
      logger,
    });
    expect(gemini.name).toBe('gemini');
    expect(gemini.real).toBe(true);

    const groq = createTextProvider({
      config: { groqApiKey: 'gsk_x'.repeat(6), defaultTextModel: 'openai/gpt-oss-120b' },
      logger,
    });
    expect(groq.name).toBe('groq');
    expect(groq.real).toBe(true);
  });

  it('asks for the key of the provider the model belongs to', () => {
    const { logger } = capturingLogger();

    const noGroqKey = createTextProvider({
      config: { geminiApiKey: 'AIza'.repeat(6), defaultTextModel: 'openai/gpt-oss-120b' },
      logger,
    });

    expect(noGroqKey.real).toBe(false);
  });

  it('falls back to a fake when the key is missing, and says so', () => {
    const captured = capturingLogger();
    const text = createTextProvider({ config: {}, logger: captured.logger });

    expect(text.real).toBe(false);
    expect(captured.text()).toContain('no API key');
  });

  it('gives the fake the model that was configured', () => {
    const { logger } = capturingLogger();
    const text = createTextProvider({
      config: { defaultTextModel: 'openai/gpt-oss-120b' },
      logger,
    });

    expect(text.defaultModel).toBe('openai/gpt-oss-120b');
    expect(text.name).toBe('groq');
  });

  it('falls back to a fake when the key is blank', () => {
    const { logger } = capturingLogger();
    expect(createVisionProvider({ config: { geminiApiKey: '   ' }, logger }).real).toBe(false);
  });

  it('uses the configured model when it is one we know', () => {
    const { logger } = capturingLogger();
    const text = createTextProvider({
      config: { groqApiKey: 'gsk_x'.repeat(6), defaultTextModel: 'openai/gpt-oss-120b' },
      logger,
    });

    expect(text.defaultModel).toBe('openai/gpt-oss-120b');
  });

  it('refuses a model it has never heard of', () => {
    const { logger } = capturingLogger();

    expect(() =>
      createTextProvider({ config: { defaultTextModel: 'made-up-model' }, logger }),
    ).toThrow(expect.objectContaining({ code: 'LLM_MODEL_UNKNOWN' }) as Error);
  });

  it('refuses a model that cannot see where a vision model is wanted', () => {
    const { logger } = capturingLogger();

    expect(() =>
      createVisionProvider({ config: { defaultVisionModel: 'openai/gpt-oss-120b' }, logger }),
    ).toThrow(expect.objectContaining({ code: 'LLM_MODEL_UNKNOWN' }) as Error);
  });

  it('routes across every provider that has a key, because a plan spans them', () => {
    const { logger } = capturingLogger();
    const text = createRoutedTextProvider({
      config: { geminiApiKey: 'AIza'.repeat(6), groqApiKey: 'gsk_x'.repeat(6) },
      logger,
    });

    expect(text.real).toBe(true);
    expect(text).toBeInstanceOf(RoutedTextProvider);
  });

  it('still works with one provider configured', () => {
    const { logger } = capturingLogger();
    const text = createRoutedTextProvider({ config: { geminiApiKey: 'AIza'.repeat(6) }, logger });

    expect(text.real).toBe(true);
  });

  it('falls back to a fake when nothing is configured, and says so', () => {
    const captured = capturingLogger();
    const text = createRoutedTextProvider({ config: {}, logger: captured.logger });

    expect(text.real).toBe(false);
    expect(captured.text()).toContain('no model provider has an API key');
  });

  it('defaults to the model the project chose', () => {
    const { logger } = capturingLogger();
    expect(createTextProvider({ config: {}, logger }).defaultModel).toBe(DEFAULT_TEXT_MODEL);
    expect(createVisionProvider({ config: {}, logger }).defaultModel).toBe(DEFAULT_VISION_MODEL);
  });
});
