import type { ModelSelection } from '@nimbus/contracts';

import type { TextProviderSource } from '../llm/sources.js';
import type { Logger } from '../logging/logger.js';

export interface SessionTitleGenerator {
  generate(input: { userId: string; task: string; model: ModelSelection | null }): Promise<string>;
}

/** Generates a compact, human-readable session name without making session creation fragile. */
export class LlmSessionTitleGenerator implements SessionTitleGenerator {
  readonly #text: TextProviderSource;
  readonly #logger: Logger;

  constructor(options: { text: TextProviderSource; logger: Logger }) {
    this.#text = options.text;
    this.#logger = options.logger;
  }

  async generate(input: {
    userId: string;
    task: string;
    model: ModelSelection | null;
  }): Promise<string> {
    try {
      const provider = await this.#text.for(input.userId);
      const result = await provider.complete({
        maxOutputTokens: 32,
        temperature: 0.2,
        messages: [
          {
            role: 'system',
            content:
              'Write a precise session title for a coding-agent task. Return only the title, no quotes, no markdown, maximum 60 characters.',
          },
          { role: 'user', content: input.task },
        ],
        ...(input.model === null ? {} : { model: input.model.textModel }),
      });
      return cleanTitle(result.text, input.task);
    } catch (error) {
      this.#logger.warn({ error: String(error) }, 'could not generate a session title');
      return cleanTitle('', input.task);
    }
  }
}

export function cleanTitle(candidate: string, fallback: string): string {
  const value = candidate
    .replace(/[\r\n]+/g, ' ')
    .replace(/["'`*_#]/g, '')
    .trim();
  const usable = value.length > 0 ? value : fallback.trim();
  return usable.slice(0, 120).trim() || 'New session';
}
