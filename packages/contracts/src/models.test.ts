import { describe, expect, it } from 'vitest';

import { ModelCatalogueResponseSchema, SelectableModelSchema } from './models.js';

const MODEL = {
  id: 'gemini-3.6-flash',
  provider: 'gemini',
  vision: true,
  reasoning: true,
} as const;

describe('the public model catalogue contract', () => {
  it('accepts only the safe public facts a model picker needs', () => {
    expect(SelectableModelSchema.parse(MODEL)).toEqual(MODEL);
    expect(
      SelectableModelSchema.safeParse({ ...MODEL, apiKey: 'must-never-leave-the-server' }).success,
    ).toBe(false);
  });

  it('wraps the catalogue in a strict response', () => {
    expect(ModelCatalogueResponseSchema.parse({ models: [MODEL] })).toEqual({ models: [MODEL] });
    expect(
      ModelCatalogueResponseSchema.safeParse({ models: [MODEL], defaultModel: MODEL.id }).success,
    ).toBe(false);
  });
});
