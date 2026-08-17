import { describe, expect, it } from 'vitest';

import { KNOWN_MODELS, findModel } from '../llm/models.js';
import { modelCatalogueIssues, plannedModels, providersForPlan } from './requirements.js';
import { SELECTABLE_TEXT_MODELS } from './selection.js';

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
      defaultTextModel: 'gemini-3.5-flash-lite',
      defaultVisionModel: 'gemini-3.6-flash',
    });

    expect(planned.find((one) => one.setting === 'DEFAULT_TEXT_MODEL')?.model).toBe(
      'gemini-3.5-flash-lite',
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

  it('accepts every known model for the vision role, because every one of them can see', () => {
    for (const model of KNOWN_MODELS) {
      expect(model.vision).toBe(true);
      expect(modelCatalogueIssues({ defaultVisionModel: model.id })).toEqual([]);
    }
  });
});
