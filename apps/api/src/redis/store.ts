import type { Redis } from 'ioredis';
import type { z } from 'zod';

import type { Logger } from '../logging/logger.js';
import { buildKey, type Namespace } from './keys.js';

export class InvalidTtlError extends RangeError {
  constructor(ttlSeconds: number) {
    super(
      `Time to live must be a positive whole number of seconds, received ${String(ttlSeconds)}`,
    );
    this.name = 'InvalidTtlError';
  }
}

export interface TypedStoreOptions<T> {
  namespace: Namespace;
  schema: z.ZodType<T>;
  defaultTtlSeconds: number;
  logger?: Logger;
}

function assertTtl(ttlSeconds: number): void {
  if (!Number.isInteger(ttlSeconds) || ttlSeconds <= 0) {
    throw new InvalidTtlError(ttlSeconds);
  }
}

export class TypedStore<T> {
  private readonly client: Redis;
  private readonly options: TypedStoreOptions<T>;

  constructor(client: Redis, options: TypedStoreOptions<T>) {
    assertTtl(options.defaultTtlSeconds);
    this.client = client;
    this.options = options;
  }

  key(id: string): string {
    return buildKey(this.options.namespace, id);
  }

  async set(id: string, value: T, ttlSeconds?: number): Promise<void> {
    const ttl = ttlSeconds ?? this.options.defaultTtlSeconds;
    assertTtl(ttl);
    const encoded = JSON.stringify(this.options.schema.parse(value));
    await this.client.set(this.key(id), encoded, 'EX', ttl);
  }

  async setIfAbsent(id: string, value: T, ttlSeconds?: number): Promise<boolean> {
    const ttl = ttlSeconds ?? this.options.defaultTtlSeconds;
    assertTtl(ttl);
    const encoded = JSON.stringify(this.options.schema.parse(value));
    const outcome = await this.client.set(this.key(id), encoded, 'EX', ttl, 'NX');
    return outcome === 'OK';
  }

  async get(id: string): Promise<T | null> {
    const raw = await this.client.get(this.key(id));
    if (raw === null) {
      return null;
    }
    return this.decode(id, raw);
  }

  async take(id: string): Promise<T | null> {
    const raw = await this.client.getdel(this.key(id));
    if (raw === null) {
      return null;
    }
    return this.decode(id, raw);
  }

  async delete(id: string): Promise<boolean> {
    return (await this.client.del(this.key(id))) > 0;
  }

  async ttlSeconds(id: string): Promise<number> {
    return this.client.ttl(this.key(id));
  }

  async extend(id: string, ttlSeconds: number): Promise<boolean> {
    assertTtl(ttlSeconds);
    return (await this.client.expire(this.key(id), ttlSeconds)) === 1;
  }

  private async decode(id: string, raw: string): Promise<T | null> {
    let candidate: unknown;
    try {
      candidate = JSON.parse(raw);
    } catch {
      await this.discard(id, 'unreadable');
      return null;
    }

    const parsed = this.options.schema.safeParse(candidate);
    if (!parsed.success) {
      await this.discard(id, 'outdated shape');
      return null;
    }
    return parsed.data;
  }

  private async discard(id: string, reason: string): Promise<void> {
    this.options.logger?.warn(
      { namespace: this.options.namespace, reason },
      'Discarded a stored value that no longer matches its schema',
    );
    await this.delete(id);
  }
}
