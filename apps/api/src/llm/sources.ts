import { KEY_PROVIDERS, type KeyProviderName, type LlmProviderName } from '@nimbus/contracts';

import type { TextProvider, VisionProvider } from './provider.js';

export interface ProviderKeyDirectory {
  keysFor(userId: string): Promise<Map<KeyProviderName, string>>;
  providersFor(userId: string): Promise<LlmProviderName[]>;
}

export interface TextProviderSource {
  for(userId: string): Promise<TextProvider>;
}

/** Resolves an already-authenticated Codex account into a Nimbus text provider. */
export interface CodexProviderSource {
  for(userId: string): Promise<TextProvider | null>;
}

export class UserProviderDirectory implements ProviderKeyDirectory {
  readonly #keys: ProviderKeyDirectory;
  readonly #codex: CodexProviderSource;

  constructor(keys: ProviderKeyDirectory, codex: CodexProviderSource) {
    this.#keys = keys;
    this.#codex = codex;
  }

  async keysFor(userId: string): Promise<Map<KeyProviderName, string>> {
    return this.#keys.keysFor(userId);
  }

  async providersFor(userId: string): Promise<LlmProviderName[]> {
    const providers: LlmProviderName[] = [...(await this.#keys.providersFor(userId))];
    if ((await this.#codex.for(userId)) !== null && !providers.includes('codex')) {
      providers.push('codex');
    }
    return providers;
  }
}

export interface VisionProviderSource {
  for(userId: string): Promise<VisionProvider | null>;
}

export function fixedText(provider: TextProvider): TextProviderSource {
  return { for: (): Promise<TextProvider> => Promise.resolve(provider) };
}

export function fixedCodex(provider: TextProvider | null): CodexProviderSource {
  return { for: (): Promise<TextProvider | null> => Promise.resolve(provider) };
}

export function fixedVision(provider: VisionProvider | null): VisionProviderSource {
  return { for: (): Promise<VisionProvider | null> => Promise.resolve(provider) };
}

export function heldProviderKeys(
  held: Readonly<Partial<Record<KeyProviderName, string>>>,
): ProviderKeyDirectory {
  const keys = new Map<KeyProviderName, string>();

  for (const provider of KEY_PROVIDERS) {
    const apiKey = held[provider];

    if (apiKey !== undefined) {
      keys.set(provider, apiKey);
    }
  }

  return {
    keysFor: (): Promise<Map<KeyProviderName, string>> => Promise.resolve(new Map(keys)),
    providersFor: (): Promise<LlmProviderName[]> => Promise.resolve([...keys.keys()]),
  };
}

export function noProviderKeys(): ProviderKeyDirectory {
  return heldProviderKeys({});
}

export function everyProviderKey(): ProviderKeyDirectory {
  return heldProviderKeys({ gemini: 'gemini-key' });
}
