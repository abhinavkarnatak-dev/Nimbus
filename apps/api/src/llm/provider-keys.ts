import {
  LLM_PROVIDERS,
  PROVIDER_KEY_SHAPES,
  ProviderKeysResponseSchema,
  providerKeyHint,
  providerKeyProblem,
  type LlmProviderName,
  type ProviderKeysResponse,
} from '@nimbus/contracts';
import type { Db } from 'mongodb';

import { recordAuditEvent } from '../auth/audit.js';
import {
  providerKeysCollection,
  sealedBinding,
  toProviderKeySummary,
  PROVIDER_KEY_ID_PREFIX,
  type ProviderKeyDocument,
} from '../db/models/provider-key.js';
import { ApiError } from '../http/api-error.js';
import { newPrefixedId } from '../lib/id.js';
import type { SecretBox } from '../lib/secret-box.js';
import { SecretBoxError } from '../lib/secret-box.js';
import type { Logger } from '../logging/logger.js';
import type { ProviderKeyVerifier } from './verify.js';

export const NO_PROVIDER_KEYS = 'Add a Google Gemini API key before starting a session.';

export interface ProviderKeyServiceOptions {
  db: Db;
  box: SecretBox;
  verifier: ProviderKeyVerifier;
  logger: Logger;
  now?: () => Date;
}

export interface SaveProviderKeyInput {
  userId: string;
  provider: LlmProviderName;
  apiKey: string;
  ip?: string | null;
}

export class ProviderKeyService {
  readonly #db: Db;

  readonly #box: SecretBox;

  readonly #verifier: ProviderKeyVerifier;

  readonly #logger: Logger;

  readonly #now: () => Date;

  constructor(options: ProviderKeyServiceOptions) {
    this.#db = options.db;
    this.#box = options.box;
    this.#verifier = options.verifier;
    this.#logger = options.logger;
    this.#now = options.now ?? ((): Date => new Date());
  }

  async list(userId: string): Promise<ProviderKeysResponse> {
    return ProviderKeysResponseSchema.parse({
      keys: (await this.#documents(userId)).map(toProviderKeySummary),
    });
  }

  async save(input: SaveProviderKeyInput): Promise<ProviderKeysResponse> {
    const apiKey = input.apiKey.trim();
    const problem = providerKeyProblem(input.provider, apiKey);

    if (problem !== null) {
      throw new ApiError('PROVIDER_KEY_INVALID', problem, {
        details: { field: 'apiKey' },
      });
    }

    await this.#assertUsable(input, apiKey);

    const at = this.#now();
    const sealed = this.#box.seal(apiKey, sealedBinding(input.userId, input.provider));

    await providerKeysCollection(this.#db).updateOne(
      { userId: input.userId, provider: input.provider },
      {
        $set: {
          hint: providerKeyHint(apiKey),
          sealed,
          updatedAt: at,
          lastVerifiedAt: at,
        },
        $setOnInsert: {
          providerKeyId: newPrefixedId(PROVIDER_KEY_ID_PREFIX),
          userId: input.userId,
          provider: input.provider,
          createdAt: at,
        },
      },
      { upsert: true },
    );

    await recordAuditEvent(this.#db, this.#logger, {
      action: 'provider_key.added',
      outcome: 'success',
      actorType: 'user',
      userId: input.userId,
      ip: input.ip ?? null,
      metadata: { provider: input.provider },
    });

    this.#logger.info(
      { userId: input.userId, provider: input.provider },
      'a provider key was saved',
    );
    return this.list(input.userId);
  }

  async remove(
    userId: string,
    provider: LlmProviderName,
    ip?: string | null,
  ): Promise<ProviderKeysResponse> {
    const gone = await providerKeysCollection(this.#db).deleteOne({ userId, provider });

    if (gone.deletedCount === 0) {
      throw new ApiError('NOT_FOUND', 'There is no key saved for that provider.');
    }

    await recordAuditEvent(this.#db, this.#logger, {
      action: 'provider_key.removed',
      outcome: 'success',
      actorType: 'user',
      userId,
      ip: ip ?? null,
      metadata: { provider },
    });

    this.#logger.info({ userId, provider }, 'a provider key was removed');
    return this.list(userId);
  }

  async providersFor(userId: string): Promise<LlmProviderName[]> {
    return (await this.#documents(userId)).map((one) => one.provider);
  }

  async keysFor(userId: string): Promise<Map<LlmProviderName, string>> {
    const keys = new Map<LlmProviderName, string>();

    for (const document of await this.#documents(userId)) {
      const opened = this.#open(document);

      if (opened !== null) {
        keys.set(document.provider, opened);
      }
    }

    return keys;
  }

  #open(document: ProviderKeyDocument): string | null {
    try {
      return this.#box.open(document.sealed, sealedBinding(document.userId, document.provider));
    } catch (error) {
      this.#logger.error(
        {
          userId: document.userId,
          provider: document.provider,
          sealedBy: error instanceof SecretBoxError ? 'a different secret' : 'an unknown fault',
        },
        'a saved provider key could not be opened, that provider is unusable until it is saved again',
      );
      return null;
    }
  }

  async #assertUsable(input: SaveProviderKeyInput, apiKey: string): Promise<void> {
    const checked = await this.#verifier.verify(input.provider, apiKey);

    if (checked.verdict === 'valid') {
      return;
    }

    await recordAuditEvent(this.#db, this.#logger, {
      action: 'provider_key.rejected',
      outcome: 'failure',
      actorType: 'user',
      userId: input.userId,
      ip: input.ip ?? null,
      reason: checked.verdict,
      metadata: { provider: input.provider, status: checked.status },
    });

    if (checked.verdict === 'rejected') {
      throw new ApiError(
        'PROVIDER_KEY_INVALID',
        `${PROVIDER_KEY_SHAPES[input.provider].label} did not accept that key.`,
        { details: { field: 'apiKey' } },
      );
    }

    throw new ApiError(
      'PROVIDER_UNAVAILABLE',
      `${PROVIDER_KEY_SHAPES[input.provider].label} could not be reached to check that key. Try again in a moment.`,
    );
  }

  async #documents(userId: string): Promise<ProviderKeyDocument[]> {
    const documents = await providerKeysCollection(this.#db).find({ userId }).toArray();

    return documents.sort(
      (left, right) => LLM_PROVIDERS.indexOf(left.provider) - LLM_PROVIDERS.indexOf(right.provider),
    );
  }
}
