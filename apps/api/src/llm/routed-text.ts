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
}

export class RoutedTextProvider implements TextProvider {
  readonly name: LlmProviderName;

  readonly real: boolean;

  readonly defaultModel: string;

  readonly #byProvider = new Map<LlmProviderName, TextProvider>();

  constructor(options: RoutedTextOptions) {
    if (options.providers.length === 0) {
      throw new LlmError('LLM_UNAVAILABLE', 'No model provider was configured.');
    }

    for (const provider of options.providers) {
      this.#byProvider.set(provider.name, provider);
    }

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

    if (facts === null) {
      throw new LlmError('LLM_UNAVAILABLE', 'That model is not one this build knows about.', {
        detail: wanted,
      });
    }

    const provider = this.#byProvider.get(facts.provider);

    if (provider === undefined) {
      throw new LlmError('LLM_UNAVAILABLE', 'No provider is configured for that model.', {
        detail: `${wanted} needs ${facts.provider}`,
      });
    }
    return provider;
  }
}
