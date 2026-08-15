import { describe, expect, it } from 'vitest';

import {
  DEFAULT_LIGHT_MODEL,
  DEFAULT_REASONING_MODEL,
  DEFAULT_TEXT_MODEL,
  DEFAULT_VISION_MODEL,
  findModel,
} from '../llm/models.js';
import {
  SELECTABLE_TEXT_MODELS,
  assertSelectableModel,
  isSelectable,
  modelForRole,
  planFor,
  selectableModels,
} from './selection.js';

describe('SELECTABLE_TEXT_MODELS', () => {
  it('offers only models Nimbus knows about', () => {
    for (const id of SELECTABLE_TEXT_MODELS) {
      expect(findModel(id)).not.toBeNull();
    }
  });

  it('offers models from both providers', () => {
    const providers = new Set(selectableModels().map((model) => model.provider));
    expect(providers).toEqual(new Set(['groq', 'gemini']));
  });

  it('includes the default, so the default is always a legal choice', () => {
    expect(SELECTABLE_TEXT_MODELS).toContain(DEFAULT_TEXT_MODEL);
  });

  it('describes each one enough for a person to choose', () => {
    for (const model of selectableModels()) {
      expect(model.id).not.toBe('');
      expect(typeof model.vision).toBe('boolean');
    }
  });

  it('names a model for every role that this build still knows about', () => {
    const plan = planFor();

    for (const role of ['primary', 'light', 'reasoning', 'vision'] as const) {
      expect(findModel(modelForRole(plan, role))).not.toBeNull();
    }
  });

  it('offers nothing that has been taken away', () => {
    for (const gone of ['llama-3.3-70b-versatile', 'openai/gpt-oss-20b']) {
      expect(isSelectable(gone)).toBe(false);
      expect(() => assertSelectableModel(gone)).toThrow(
        expect.objectContaining({ code: 'LLM_MODEL_UNKNOWN' }) as Error,
      );
    }
  });
});

describe('assertSelectableModel', () => {
  it('accepts every model on the list', () => {
    for (const id of SELECTABLE_TEXT_MODELS) {
      expect(assertSelectableModel(id)).toBe(id);
    }
  });

  it('trims what it is given', () => {
    expect(assertSelectableModel('  gemini-3.6-flash  ')).toBe('gemini-3.6-flash');
  });

  it('refuses a model nobody has heard of', () => {
    expect(() => assertSelectableModel('gpt-9-ultra')).toThrow(
      expect.objectContaining({ code: 'LLM_MODEL_UNKNOWN' }) as Error,
    );
  });

  it('refuses an empty choice', () => {
    expect(() => assertSelectableModel('   ')).toThrow(
      expect.objectContaining({ code: 'LLM_MODEL_UNKNOWN' }) as Error,
    );
  });

  it('never quietly substitutes a model it refused', () => {
    let refused = false;

    try {
      assertSelectableModel('gpt-9-ultra');
    } catch {
      refused = true;
    }

    expect(refused).toBe(true);
  });

  it('agrees with isSelectable', () => {
    expect(isSelectable('gemini-3.6-flash')).toBe(true);
    expect(isSelectable('gpt-9-ultra')).toBe(false);
  });
});

describe('planFor', () => {
  it('uses the default when the user chose nothing', () => {
    const plan = planFor();

    expect(plan.primary).toBe(DEFAULT_TEXT_MODEL);
    expect(plan.chosenByUser).toBe(false);
  });

  it('uses the default when the choice is blank', () => {
    expect(planFor({ textModel: '   ' }).chosenByUser).toBe(false);
  });

  it('uses what the user chose', () => {
    const plan = planFor({ textModel: 'openai/gpt-oss-120b' });

    expect(plan.primary).toBe('openai/gpt-oss-120b');
    expect(plan.chosenByUser).toBe(true);
  });

  it('refuses a choice that is not on the list', () => {
    expect(() => planFor({ textModel: 'gpt-9-ultra' })).toThrow(
      expect.objectContaining({ code: 'LLM_MODEL_UNKNOWN' }) as Error,
    );
  });

  it('keeps the light model out of the user choice', () => {
    expect(planFor({ textModel: 'openai/gpt-oss-120b' }).light).toBe(DEFAULT_LIGHT_MODEL);
    expect(planFor().light).toBe(DEFAULT_LIGHT_MODEL);
  });

  it('keeps the reasoning model out of the user choice', () => {
    expect(planFor({ textModel: 'openai/gpt-oss-120b' }).reasoning).toBe(DEFAULT_REASONING_MODEL);
  });

  it('keeps the vision model out of the user choice', () => {
    expect(planFor({ textModel: 'openai/gpt-oss-120b' }).vision).toBe(DEFAULT_VISION_MODEL);
  });

  it('never lets a model that cannot see become the vision model', () => {
    for (const id of SELECTABLE_TEXT_MODELS) {
      expect(findModel(planFor({ textModel: id }).vision)?.vision).toBe(true);
    }
  });

  it('picks a light model that spends nothing thinking', () => {
    expect(findModel(planFor().light)?.thinks).toBe(false);
  });
});

describe('modelForRole', () => {
  it('answers for every role', () => {
    const plan = planFor({ textModel: 'gemini-3.5-flash-lite' });

    expect(modelForRole(plan, 'primary')).toBe('gemini-3.5-flash-lite');
    expect(modelForRole(plan, 'light')).toBe(DEFAULT_LIGHT_MODEL);
    expect(modelForRole(plan, 'reasoning')).toBe(DEFAULT_REASONING_MODEL);
    expect(modelForRole(plan, 'vision')).toBe(DEFAULT_VISION_MODEL);
  });
});
