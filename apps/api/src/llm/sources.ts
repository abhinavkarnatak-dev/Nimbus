import { LLM_PROVIDERS, type LlmProviderName } from '@nimbus/contracts';

import type { TextProvider, VisionProvider } from './provider.js';

export interface ProviderKeyDirectory {
  keysFor(userId: string): Promise<Map<LlmProviderName, string>>;
  providersFor(userId: string): Promise<LlmProviderName[]>;
}

export interface TextProviderSource {
  for(userId: string): Promise<TextProvider>;
}

export interface VisionProviderSource {
  for(userId: string): Promise<VisionProvider | null>;
}

export function fixedText(provider: TextProvider): TextProviderSource {
  return { for: (): Promise<TextProvider> => Promise.resolve(provider) };
}

export function fixedVision(provider: VisionProvider | null): VisionProviderSource {
  return { for: (): Promise<VisionProvider | null> => Promise.resolve(provider) };
}

export function heldProviderKeys(
  held: Readonly<Partial<Record<LlmProviderName, string>>>,
): ProviderKeyDirectory {
  const keys = new Map<LlmProviderName, string>();

  for (const provider of LLM_PROVIDERS) {
    const apiKey = held[provider];

    if (apiKey !== undefined) {
      keys.set(provider, apiKey);
    }
  }

  return {
    keysFor: (): Promise<Map<LlmProviderName, string>> => Promise.resolve(new Map(keys)),
    providersFor: (): Promise<LlmProviderName[]> => Promise.resolve([...keys.keys()]),
  };
}

export function noProviderKeys(): ProviderKeyDirectory {
  return heldProviderKeys({});
}

export function everyProviderKey(): ProviderKeyDirectory {
  return heldProviderKeys({ gemini: 'gemini-key' });
}
