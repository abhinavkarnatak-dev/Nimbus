import { describe, expect, it } from 'vitest';

import {
  CONTEXT_PARTS,
  ContextSummarySchema,
  DescribedImageSchema,
  MODEL_ROLES,
  ModelPlanSchema,
  ModelRoleSchema,
} from './routing.js';

const plan = {
  primary: 'gemini-3.6-flash',
  light: 'gemini-3.5-flash-lite',
  reasoning: 'openai/gpt-oss-120b',
  vision: 'gemini-3.6-flash',
  chosenByUser: false,
};

const described = {
  attachmentId: 'att_routingroutingrout001',
  name: 'screenshot.png',
  description: 'a red box saying Error 500',
  model: 'gemini-3.6-flash',
  reused: false,
};

const summary = {
  characters: 4_212,
  parts: ['task', 'images', 'retrieval'],
  dropped: ['attachments'],
  imagesDescribed: 1,
  imagesReused: 0,
  truncated: true,
};

describe('ModelRoleSchema', () => {
  it('knows exactly four roles', () => {
    expect([...MODEL_ROLES].sort()).toEqual(['light', 'primary', 'reasoning', 'vision']);
  });

  it('refuses a role it does not know', () => {
    expect(ModelRoleSchema.safeParse('cheap').success).toBe(false);
  });
});

describe('ModelPlanSchema', () => {
  it('accepts a plan', () => {
    expect(ModelPlanSchema.safeParse(plan).success).toBe(true);
  });

  it('needs a model for every role, so no role can be left unset', () => {
    for (const role of ['primary', 'light', 'reasoning', 'vision']) {
      const { [role]: _dropped, ...rest } = plan as Record<string, unknown>;
      expect(ModelPlanSchema.safeParse(rest).success).toBe(false);
    }
  });

  it('refuses a model name with a space in it', () => {
    expect(ModelPlanSchema.safeParse({ ...plan, primary: 'gpt 4' }).success).toBe(false);
  });

  it('refuses an extra field', () => {
    expect(ModelPlanSchema.safeParse({ ...plan, fallback: 'x' }).success).toBe(false);
  });
});

describe('DescribedImageSchema', () => {
  it('accepts a description', () => {
    expect(DescribedImageSchema.safeParse(described).success).toBe(true);
  });

  it('refuses an attachment id of the wrong shape', () => {
    expect(
      DescribedImageSchema.safeParse({ ...described, attachmentId: 'att_short' }).success,
    ).toBe(false);
  });

  it('refuses an empty description', () => {
    expect(DescribedImageSchema.safeParse({ ...described, description: '' }).success).toBe(false);
  });

  it('refuses a description that is far too long', () => {
    expect(
      DescribedImageSchema.safeParse({ ...described, description: 'a'.repeat(2_001) }).success,
    ).toBe(false);
  });

  it('records whether it was reused, so cost can be explained', () => {
    const { reused: _dropped, ...rest } = described;
    expect(DescribedImageSchema.safeParse(rest).success).toBe(false);
  });
});

describe('ContextSummarySchema', () => {
  it('accepts a summary', () => {
    expect(ContextSummarySchema.safeParse(summary).success).toBe(true);
  });

  it('knows exactly four parts', () => {
    expect([...CONTEXT_PARTS]).toEqual(['task', 'images', 'attachments', 'retrieval']);
  });

  it('refuses a part it does not know', () => {
    expect(ContextSummarySchema.safeParse({ ...summary, parts: ['history'] }).success).toBe(false);
  });

  it('refuses a negative count', () => {
    expect(ContextSummarySchema.safeParse({ ...summary, imagesDescribed: -1 }).success).toBe(false);
  });

  it('refuses an extra field', () => {
    expect(ContextSummarySchema.safeParse({ ...summary, tokens: 10 }).success).toBe(false);
  });
});
