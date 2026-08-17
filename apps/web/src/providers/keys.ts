import {
  LLM_PROVIDERS,
  PROVIDER_KEY_SHAPES,
  type LlmProviderName,
  type ProviderKeySummary,
} from '@nimbus/contracts';

import { ApiError, NetworkError } from '../api/errors.js';

export const PROVIDER_ORDER: readonly LlmProviderName[] = LLM_PROVIDERS;

export function shapeOf(provider: LlmProviderName): (typeof PROVIDER_KEY_SHAPES)[LlmProviderName] {
  return PROVIDER_KEY_SHAPES[provider];
}

export function savedKeyFor(keys: readonly ProviderKeySummary[]): ProviderKeySummary | null {
  return keys.at(0) ?? null;
}

export function saveProblem(error: unknown): string {
  if (error instanceof NetworkError) {
    return 'Nimbus is not answering. Check your connection and try again.';
  }

  if (error instanceof ApiError) {
    if (error.code === 'PROVIDER_KEY_INVALID' || error.code === 'PROVIDER_UNAVAILABLE') {
      return error.message;
    }

    if (error.code === 'VALIDATION_FAILED') {
      return 'That does not look like a key Nimbus can use.';
    }
  }
  return 'That key could not be saved. Try again.';
}

export function removeProblem(error: unknown): string {
  if (error instanceof NetworkError) {
    return 'Nimbus is not answering. Check your connection and try again.';
  }

  if (error instanceof ApiError && error.code === 'NOT_FOUND') {
    return 'There is no key saved for that provider.';
  }
  return 'That key could not be removed. Try again.';
}

export function savedWords(provider: LlmProviderName): string {
  return `${PROVIDER_KEY_SHAPES[provider].label} is ready. Nimbus checked the key against ${PROVIDER_KEY_SHAPES[provider].label} before saving it.`;
}

export function removedWords(provider: LlmProviderName): string {
  return `The ${PROVIDER_KEY_SHAPES[provider].label} key is gone. Nimbus kept no copy of it.`;
}

export function addedOn(summary: ProviderKeySummary): string {
  return new Date(summary.addedAt).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}
