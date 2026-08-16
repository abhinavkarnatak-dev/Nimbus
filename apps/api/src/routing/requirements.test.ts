import { describe, expect, it } from 'vitest';

import { findModel } from '../llm/models.js';
import {
  missingProviderIssues,
  modelCatalogueIssues,
  plannedModels,
  providersForPlan,
} from './requirements.js';
import { SELECTABLE_TEXT_MODELS } from './selection.js';

const BOTH = { gemini: true, groq: true };

describe('the models a plan can reach', () => {
  it('covers every role', () => {
    const roles = new Set(plannedModels({}).map((planned) => planned.role));

    expect([...roles].sort()).toEqual(['light', 'primary', 'reasoning', 'vision']);
  });

  it('covers every model a person is allowed to choose', () => {
    const models = new Set(plannedModels({}).map((planned) => planned.model));

    for (const selectable of SELECTABLE_TEXT_MODELS) {
      expect(models.has(selectable), selectable).toBe(true);
    }
  });

  it('follows the configured defaults rather than the built in ones', () => {
    const planned = plannedModels({
      defaultTextModel: 'openai/gpt-oss-120b',
      defaultVisionModel: 'gemini-3.6-flash',
    });

    expect(planned.find((one) => one.setting === 'DEFAULT_TEXT_MODEL')?.model).toBe(
      'openai/gpt-oss-120b',
    );
    expect(planned.find((one) => one.setting === 'DEFAULT_VISION_MODEL')?.model).toBe(
      'gemini-3.6-flash',
    );
  });

  it('treats a blank configured model as no configured model', () => {
    const blank = plannedModels({ defaultTextModel: '   ' });
    const absent = plannedModels({});

    expect(blank).toEqual(absent);
  });

  it('derives the providers rather than naming them', () => {
    const derived = providersForPlan({});
    const expected = new Set(
      plannedModels({})
        .map((planned) => findModel(planned.model)?.provider)
        .filter((provider) => provider !== undefined),
    );

    expect(new Set(derived)).toEqual(expected);
  });
});

describe('what the catalogue refuses', () => {
  it('accepts the plan this build ships with', () => {
    expect(modelCatalogueIssues({})).toEqual([]);
  });

  it('refuses a model nobody has heard of', () => {
    const issues = modelCatalogueIssues({ defaultTextModel: 'made-up-model' });

    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('DEFAULT_TEXT_MODEL');
    expect(issues[0]).toContain('made-up-model');
  });

  it('refuses a vision role given a model that cannot see', () => {
    const issues = modelCatalogueIssues({ defaultVisionModel: 'openai/gpt-oss-120b' });

    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('DEFAULT_VISION_MODEL');
    expect(issues[0]).toContain('cannot look at images');
  });
});

describe('what a missing provider costs', () => {
  it('asks for nothing when both providers are configured', () => {
    expect(missingProviderIssues({}, BOTH)).toEqual([]);
  });

  it('asks for Gemini when only Groq is configured', () => {
    const issues = missingProviderIssues({}, { gemini: false, groq: true });

    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('GEMINI_API_KEY');
  });

  it('asks for Groq when only Gemini is configured, because reasoning is a Groq role', () => {
    const issues = missingProviderIssues({}, { gemini: true, groq: false });

    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('GROQ_API_KEY');
  });

  it('asks for both when neither is configured', () => {
    const issues = missingProviderIssues({}, { gemini: false, groq: false });

    expect(issues).toHaveLength(2);
    expect(issues.join('\n')).toContain('GEMINI_API_KEY');
    expect(issues.join('\n')).toContain('GROQ_API_KEY');
  });

  it('asks once per provider rather than once per role', () => {
    const issues = missingProviderIssues({}, { gemini: false, groq: true });
    const geminiIssues = issues.filter((issue) => issue.startsWith('GEMINI_API_KEY'));

    expect(geminiIssues).toHaveLength(1);
  });

  it('names the role that needs it, so the reason is readable', () => {
    const issues = missingProviderIssues({}, { gemini: false, groq: true });

    expect(issues[0]).toContain('role uses');
  });

  it('does not ask for a provider no model in the plan belongs to', () => {
    const issues = missingProviderIssues({ defaultTextModel: 'made-up-model' }, BOTH);

    expect(issues).toEqual([]);
  });
});
