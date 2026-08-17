import type { LlmProviderName } from '@nimbus/contracts';

import type { Logger } from '../logging/logger.js';
import { LlmError } from './errors.js';
import { GeminiTextProvider } from './gemini-text.js';
import { GeminiVisionProvider } from './gemini.js';
import { DEFAULT_VISION_MODEL, defaultTextModelFor } from './models.js';
import type { TextProvider, VisionProvider } from './provider.js';
import { RoutedTextProvider } from './routed-text.js';
import type { ProviderKeyDirectory, TextProviderSource, VisionProviderSource } from './sources.js';

export const NO_KEYS_FOR_RUN =
  'This account has no working model API key. Add one in settings and start the session again.';

export interface UserProvidersOptions {
  keys: ProviderKeyDirectory;
  logger: Logger;
}

export class UserProviders implements TextProviderSource {
  readonly #keys: ProviderKeyDirectory;

  readonly #logger: Logger;

  constructor(options: UserProvidersOptions) {
    this.#keys = options.keys;
    this.#logger = options.logger;
  }

  async for(userId: string): Promise<TextProvider> {
    const keys = await this.#keys.keysFor(userId);
    const providers: TextProvider[] = [];

    for (const [provider, apiKey] of keys) {
      providers.push(this.#text(provider, apiKey));
    }

    if (providers.length === 0) {
      throw new LlmError('LLM_NOT_CONFIGURED', NO_KEYS_FOR_RUN);
    }

    this.#logger.info(
      { userId, providers: providers.map((one) => one.name) },
      'model providers were built from the keys this account saved',
    );

    return new RoutedTextProvider({
      providers,
      defaultModel: defaultTextModelFor([...keys.keys()]),
    });
  }

  async vision(userId: string): Promise<VisionProvider | null> {
    const keys = await this.#keys.keysFor(userId);
    const apiKey = keys.get('gemini');

    if (apiKey === undefined) {
      return null;
    }

    return new GeminiVisionProvider({
      apiKey,
      logger: this.#logger,
      defaultModel: DEFAULT_VISION_MODEL,
    });
  }

  #text(_provider: LlmProviderName, apiKey: string): TextProvider {
    return new GeminiTextProvider({ apiKey, logger: this.#logger });
  }
}

export class UserVisionProviders implements VisionProviderSource {
  readonly #providers: UserProviders;

  constructor(providers: UserProviders) {
    this.#providers = providers;
  }

  async for(userId: string): Promise<VisionProvider | null> {
    return await this.#providers.vision(userId);
  }
}
