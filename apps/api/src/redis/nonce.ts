import type { Redis } from 'ioredis';
import { z } from 'zod';

import { newPrefixedId } from '../lib/id.js';
import type { Logger } from '../logging/logger.js';
import { NAMESPACES } from './keys.js';
import { TypedStore } from './store.js';

export const NONCE_PREFIX = 'non';

export interface NonceStoreOptions<T> {
  purpose: string;
  schema: z.ZodType<T>;
  ttlSeconds: number;
  logger?: Logger;
}

export class NonceStore<T> {
  private readonly purpose: string;
  private readonly store: TypedStore<{ purpose: string; payload: T }>;
  private readonly logger: Logger | undefined;

  constructor(client: Redis, options: NonceStoreOptions<T>) {
    this.purpose = options.purpose;
    this.logger = options.logger;
    this.store = new TypedStore(client, {
      namespace: NAMESPACES.nonce,
      schema: z.strictObject({ purpose: z.string().min(1), payload: options.schema }),
      defaultTtlSeconds: options.ttlSeconds,
      ...(options.logger === undefined ? {} : { logger: options.logger }),
    });
  }

  async issue(payload: T, ttlSeconds?: number): Promise<string> {
    const nonce = newPrefixedId(NONCE_PREFIX);
    await this.store.set(nonce, { purpose: this.purpose, payload }, ttlSeconds);
    return nonce;
  }

  async consume(nonce: string): Promise<T | null> {
    const record = await this.store.take(nonce);
    if (record === null) {
      return null;
    }

    if (record.purpose !== this.purpose) {
      this.logger?.warn(
        { expectedPurpose: this.purpose, actualPurpose: record.purpose },
        'Rejected a one time value issued for a different purpose',
      );
      return null;
    }

    return record.payload;
  }
}
