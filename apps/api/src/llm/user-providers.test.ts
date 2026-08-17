import { describe, expect, it } from 'vitest';

import { capturingLogger } from './llm.fixtures.js';
import { DEFAULT_GEMINI_TEXT_MODEL } from './models.js';
import { heldProviderKeys, noProviderKeys } from './sources.js';
import { UserProviders, UserVisionProviders } from './user-providers.js';

const GEMINI_KEY = `AIza${'k'.repeat(35)}`;

function providersFor(held: Parameters<typeof heldProviderKeys>[0]): UserProviders {
  return new UserProviders({ keys: heldProviderKeys(held), logger: capturingLogger().logger });
}

describe('the providers built for one account', () => {
  it('builds a real provider for each key the account saved', async () => {
    const text = await providersFor({ gemini: GEMINI_KEY }).for('usr_one');

    expect(text.real).toBe(true);
  });

  it('defaults to a model the saved keys pay for', async () => {
    expect((await providersFor({ gemini: GEMINI_KEY }).for('usr_one')).defaultModel).toBe(
      DEFAULT_GEMINI_TEXT_MODEL,
    );
  });

  it('refuses to build anything for an account with no key, rather than falling back to a fake', async () => {
    const providers = new UserProviders({
      keys: noProviderKeys(),
      logger: capturingLogger().logger,
    });

    await expect(providers.for('usr_one')).rejects.toThrow(
      expect.objectContaining({ code: 'LLM_NOT_CONFIGURED' }) as Error,
    );
  });

  it('never puts a key value in the refusal', async () => {
    const providers = new UserProviders({
      keys: noProviderKeys(),
      logger: capturingLogger().logger,
    });

    try {
      await providers.for('usr_one');
      expect.unreachable('an account with no key should have been refused');
    } catch (error) {
      expect(JSON.stringify(error, Object.getOwnPropertyNames(error))).not.toContain(GEMINI_KEY);
    }
  });

  it('never logs a key value while building providers', async () => {
    const captured = capturingLogger();
    const providers = new UserProviders({
      keys: heldProviderKeys({ gemini: GEMINI_KEY }),
      logger: captured.logger,
    });

    await providers.for('usr_one');

    expect(captured.text()).not.toContain(GEMINI_KEY);
  });

  it('refuses a model no saved key pays for rather than guessing one', async () => {
    const text = await providersFor({ gemini: GEMINI_KEY }).for('usr_one');

    await expect(text.complete({ messages: [], model: 'made-up-model' })).rejects.toThrow(
      expect.objectContaining({ code: 'LLM_UNAVAILABLE' }) as Error,
    );
  });
});

describe('the image describer built for one account', () => {
  it('exists only when the account saved a Gemini key', async () => {
    const withGemini = new UserVisionProviders(providersFor({ gemini: GEMINI_KEY }));
    const withNothing = new UserVisionProviders(providersFor({}));

    expect(await withGemini.for('usr_one')).not.toBeNull();
    expect(await withNothing.for('usr_one')).toBeNull();
  });

  it('is real when it exists, because there is no fake to fall back to', async () => {
    const vision = await new UserVisionProviders(providersFor({ gemini: GEMINI_KEY })).for(
      'usr_one',
    );

    expect(vision?.real).toBe(true);
  });
});
