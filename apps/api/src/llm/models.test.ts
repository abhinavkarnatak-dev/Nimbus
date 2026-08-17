import { describe, expect, it } from 'vitest';

import {
  DEFAULT_GEMINI_TEXT_MODEL,
  DEFAULT_TEXT_MODEL,
  DEFAULT_VISION_MODEL,
  KNOWN_MODELS,
  defaultTextModelFor,
  findModel,
  highestInputRate,
  highestOutputRate,
  ratesFor,
} from './models.js';
import { costOf } from './provider.js';

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

  it('offers only models that can hold a schema', () => {
    const schemaCapable = KNOWN_MODELS.filter((model) => model.structuredOutput === 'json_schema');

    expect(schemaCapable).toHaveLength(KNOWN_MODELS.length);
  });

  it('has a per provider text default that belongs to that provider', () => {
    expect(findModel(DEFAULT_GEMINI_TEXT_MODEL)?.provider).toBe('gemini');
  });

  it('picks a text default the account actually holds a key for', () => {
    expect(defaultTextModelFor(['gemini'])).toBe(DEFAULT_GEMINI_TEXT_MODEL);
    expect(findModel(defaultTextModelFor([]))).not.toBeNull();
  });

  it('carries no model that cannot hold a schema, because the agent asks for one every step', () => {
    for (const model of KNOWN_MODELS) {
      expect(model.structuredOutput).toBe('json_schema');
    }
  });

  it('carries no model that has been taken away', () => {
    for (const gone of [
      'llama-3.3-70b-versatile',
      'openai/gpt-oss-20b',
      'openai/gpt-oss-120b',
      'qwen/qwen3.6-27b',
    ]) {
      expect(findModel(gone)).toBeNull();
    }
  });
});

describe('ratesFor', () => {
  it('returns the price of a model it knows', () => {
    expect(ratesFor('gemini-3.5-flash-lite')).toEqual({ input: 10, output: 40, known: true });
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
    const cost = costOf('gemini-3.5-flash-lite', {
      promptTokens: 100,
      completionTokens: 40,
      reasoningTokens: 0,
      totalTokens: 140,
    });

    expect(cost.microCents).toBe(100 * 10 + 40 * 40);
  });

  it('bills thinking the same as speaking', () => {
    const cost = costOf('gemini-3.5-flash-lite', {
      promptTokens: 0,
      completionTokens: 0,
      reasoningTokens: 100,
      totalTokens: 100,
    });

    expect(cost.microCents).toBe(100 * 40);
  });

  it('always says it is an estimate', () => {
    const cost = costOf('gemini-3.5-flash-lite', {
      promptTokens: 1,
      completionTokens: 1,
      reasoningTokens: 0,
      totalTokens: 2,
    });

    expect(cost.estimated).toBe(true);
  });
});
