import { describe, expect, it } from 'vitest';

import { LLM_PROVIDERS } from './llm.js';
import {
  PROVIDER_KEY_HINT_CHARS,
  PROVIDER_KEY_SHAPES,
  ProviderKeysResponseSchema,
  SaveProviderKeyBodySchema,
  providerKeyHint,
  providerKeyProblem,
} from './provider-keys.js';

const GEMINI_KEY = `AIza${'k'.repeat(35)}`;
const GEMINI_DOTTED_KEY = `AQ.Ab8${'k'.repeat(50)}`;
const ALTERNATE_SHAPE_KEY = `AQ.Ab8${'k'.repeat(50)}`;

describe('what a provider key has to look like', () => {
  it('describes every provider Nimbus can talk to', () => {
    for (const provider of LLM_PROVIDERS) {
      expect(PROVIDER_KEY_SHAPES[provider].example).not.toBe('');
      expect(PROVIDER_KEY_SHAPES[provider].consoleUrl.startsWith('https://')).toBe(true);
    }
  });

  it('accepts a key of the right shape', () => {
    expect(providerKeyProblem('gemini', GEMINI_KEY)).toBeNull();
  });

  it('accepts a Gemini key that does not start with AIza', () => {
    expect(providerKeyProblem('gemini', GEMINI_DOTTED_KEY)).toBeNull();
  });

  it('leaves the provider to say whose key it is', () => {
    expect(providerKeyProblem('gemini', ALTERNATE_SHAPE_KEY)).toBeNull();
  });

  it('asks for something when nothing was pasted', () => {
    expect(providerKeyProblem('gemini', '   ')).toContain('Google AI Studio');
  });

  it('notices a key that was cut short', () => {
    expect(providerKeyProblem('gemini', 'AIzaAIzaAIzaAIzaAIzaAIza')).toContain('cut short');
  });

  it('refuses text that could never be a key', () => {
    expect(providerKeyProblem('gemini', 'AIza this has spaces in it and quotes "')).not.toBeNull();
  });

  it('never repeats the key in what it says', () => {
    for (const bad of ['AIza-short', `${ALTERNATE_SHAPE_KEY} `, 'nonsense']) {
      expect(providerKeyProblem('gemini', bad) ?? '').not.toContain(bad.trim());
    }
  });

  it('keeps only the last few characters as a hint', () => {
    expect(providerKeyHint(GEMINI_KEY)).toHaveLength(PROVIDER_KEY_HINT_CHARS);
    expect(GEMINI_KEY.endsWith(providerKeyHint(GEMINI_KEY))).toBe(true);
    expect(providerKeyHint(GEMINI_KEY).startsWith('AIza')).toBe(false);
  });
});

describe('the shapes on the wire', () => {
  it('takes a provider and a key on the way in', () => {
    expect(
      SaveProviderKeyBodySchema.safeParse({ provider: 'gemini', apiKey: GEMINI_KEY }).success,
    ).toBe(true);
  });

  it('refuses a provider Nimbus does not talk to', () => {
    expect(
      SaveProviderKeyBodySchema.safeParse({ provider: 'openai', apiKey: GEMINI_KEY }).success,
    ).toBe(false);
  });

  it('refuses anything alongside the two fields it expects', () => {
    expect(
      SaveProviderKeyBodySchema.safeParse({
        provider: 'gemini',
        apiKey: GEMINI_KEY,
        userId: 'usr_somebodyelse',
      }).success,
    ).toBe(false);
  });

  it('never sends a key back out, only a hint', () => {
    const parsed = ProviderKeysResponseSchema.parse({
      keys: [
        {
          provider: 'gemini',
          hint: providerKeyHint(GEMINI_KEY),
          addedAt: '2026-08-17T00:00:00.000Z',
          lastVerifiedAt: null,
        },
      ],
    });

    expect(JSON.stringify(parsed)).not.toContain(GEMINI_KEY);
    expect(Object.keys(parsed.keys[0] ?? {}).sort()).toEqual([
      'addedAt',
      'hint',
      'lastVerifiedAt',
      'provider',
    ]);
  });

  it('holds at most one key per provider', () => {
    const one = {
      provider: 'gemini',
      hint: 'aaaa',
      addedAt: '2026-08-17T00:00:00.000Z',
      lastVerifiedAt: null,
    };

    expect(
      ProviderKeysResponseSchema.safeParse({ keys: Array.from({ length: 3 }, () => one) }).success,
    ).toBe(false);
  });
});
