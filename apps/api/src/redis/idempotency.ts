import type { Redis } from 'ioredis';
import { z } from 'zod';

import type { Logger } from '../logging/logger.js';
import { NAMESPACES } from './keys.js';
import { TypedStore } from './store.js';

const CLAIM_ATTEMPTS = 3;

export type IdempotencyOutcome<T> =
  { status: 'started' } | { status: 'running' } | { status: 'completed'; result: T };

export interface IdempotencyStoreOptions<T> {
  schema: z.ZodType<T>;
  runningTtlSeconds: number;
  completedTtlSeconds: number;
  logger?: Logger;
}

export class IdempotencyStore<T> {
  private readonly store: TypedStore<{ status: 'running' } | { status: 'completed'; result: T }>;
  private readonly runningTtlSeconds: number;
  private readonly completedTtlSeconds: number;

  constructor(client: Redis, options: IdempotencyStoreOptions<T>) {
    this.runningTtlSeconds = options.runningTtlSeconds;
    this.completedTtlSeconds = options.completedTtlSeconds;
    this.store = new TypedStore(client, {
      namespace: NAMESPACES.idempotency,
      schema: z.discriminatedUnion('status', [
        z.strictObject({ status: z.literal('running') }),
        z.strictObject({ status: z.literal('completed'), result: options.schema }),
      ]),
      defaultTtlSeconds: options.runningTtlSeconds,
      ...(options.logger === undefined ? {} : { logger: options.logger }),
    });
  }

  async begin(key: string): Promise<IdempotencyOutcome<T>> {
    for (let attempt = 0; attempt < CLAIM_ATTEMPTS; attempt += 1) {
      const claimed = await this.store.setIfAbsent(
        key,
        { status: 'running' },
        this.runningTtlSeconds,
      );
      if (claimed) {
        return { status: 'started' };
      }

      const existing = await this.store.get(key);
      if (existing === null) {
        continue;
      }
      if (existing.status === 'completed') {
        return { status: 'completed', result: existing.result };
      }
      return { status: 'running' };
    }

    return { status: 'running' };
  }

  async complete(key: string, result: T): Promise<void> {
    await this.store.set(key, { status: 'completed', result }, this.completedTtlSeconds);
  }

  async abandon(key: string): Promise<void> {
    await this.store.delete(key);
  }

  async peek(key: string): Promise<IdempotencyOutcome<T> | null> {
    const existing = await this.store.get(key);
    if (existing === null) {
      return null;
    }
    if (existing.status === 'completed') {
      return { status: 'completed', result: existing.result };
    }
    return { status: 'running' };
  }
}
