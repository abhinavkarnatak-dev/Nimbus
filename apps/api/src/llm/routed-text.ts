import type { LlmProviderName } from '@nimbus/contracts';

import { LlmError } from './errors.js';
import { findModel } from './models.js';
import type {
  CompleteRequest,
  CompleteResult,
  StructuredRequest,
  StructuredResult,
  TextProvider,
} from './provider.js';

export interface RoutedTextOptions {
  providers: readonly TextProvider[];
  defaultModel?: string;
  modelProviders?: ReadonlyMap<string, LlmProviderName>;
}

export class RoutedTextProvider implements TextProvider {
  readonly name: LlmProviderName;

  readonly real: boolean;

  readonly defaultModel: string;

  readonly #byProvider = new Map<LlmProviderName, TextProvider>();
  readonly #modelProviders: ReadonlyMap<string, LlmProviderName>;

  constructor(options: RoutedTextOptions) {
    if (options.providers.length === 0) {
      throw new LlmError('LLM_UNAVAILABLE', 'No model provider was configured.');
    }

    for (const provider of options.providers) {
      this.#byProvider.set(provider.name, provider);
    }
    this.#modelProviders = options.modelProviders ?? new Map();

    const first = options.providers[0];

    if (first === undefined) {
      throw new LlmError('LLM_UNAVAILABLE', 'No model provider was configured.');
    }

    this.name = first.name;
    this.real = options.providers.every((provider) => provider.real);
    this.defaultModel = options.defaultModel ?? first.defaultModel;
  }

  async complete(request: CompleteRequest): Promise<CompleteResult> {
    return await this.#providerFor(request.model).complete(request);
  }

  async completeStructured<T>(request: StructuredRequest<T>): Promise<StructuredResult<T>> {
    return await this.#providerFor(request.model).completeStructured(request);
  }

  #providerFor(model: string | undefined): TextProvider {
    const wanted = model ?? this.defaultModel;
    const facts = findModel(wanted);

    const providerName = facts?.provider ?? this.#modelProviders.get(wanted);
    if (providerName === undefined) {
      throw new LlmError('LLM_UNAVAILABLE', 'That model is not one this build knows about.', {
        detail: wanted,
      });
    }

    const provider = this.#byProvider.get(providerName);

    if (provider === undefined) {
      throw new LlmError('LLM_UNAVAILABLE', 'No provider is configured for that model.', {
        detail: `${wanted} needs ${providerName}`,
      });
    }
    return provider;
  }
}
