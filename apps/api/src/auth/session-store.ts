import type { Redis } from 'ioredis';
import { z } from 'zod';

import type { Logger } from '../logging/logger.js';
import { buildKey, NAMESPACES } from '../redis/keys.js';
import { TypedStore } from '../redis/store.js';

export const SessionRecordSchema = z.strictObject({
  userId: z.string().min(1),
  createdAt: z.string().min(1),
  absoluteExpiresAt: z.string().min(1),
});

export type SessionRecord = z.infer<typeof SessionRecordSchema>;

function userIndexKey(userId: string): string {
  return buildKey(NAMESPACES.session, 'user', userId);
}

export interface SessionStoreOptions {
  idleTtlSeconds: number;
  logger?: Logger;
}

export class SessionStore {
  private readonly client: Redis;
  private readonly records: TypedStore<SessionRecord>;
  private readonly idleTtlSeconds: number;

  constructor(client: Redis, options: SessionStoreOptions) {
    this.client = client;
    this.idleTtlSeconds = options.idleTtlSeconds;
    this.records = new TypedStore(client, {
      namespace: NAMESPACES.session,
      schema: SessionRecordSchema,
      defaultTtlSeconds: options.idleTtlSeconds,
      ...(options.logger === undefined ? {} : { logger: options.logger }),
    });
  }

  async save(sessionKey: string, record: SessionRecord): Promise<void> {
    await this.records.set(sessionKey, record, this.idleTtlSeconds);
    await this.client.sadd(userIndexKey(record.userId), sessionKey);
    await this.client.expire(userIndexKey(record.userId), this.idleTtlSeconds * 24);
  }

  async read(sessionKey: string): Promise<SessionRecord | null> {
    return this.records.get(sessionKey);
  }

  async refresh(sessionKey: string): Promise<void> {
    await this.records.extend(sessionKey, this.idleTtlSeconds);
  }

  async remove(sessionKey: string, userId?: string): Promise<boolean> {
    const removed = await this.records.delete(sessionKey);

    if (userId !== undefined) {
      await this.client.srem(userIndexKey(userId), sessionKey);
    }
    return removed;
  }

  async removeAllForUser(userId: string): Promise<number> {
    const keys = await this.client.smembers(userIndexKey(userId));
    let removed = 0;

    for (const key of keys) {
      if (await this.records.delete(key)) {
        removed += 1;
      }
    }

    await this.client.del(userIndexKey(userId));
    return removed;
  }

  async countForUser(userId: string): Promise<number> {
    return this.client.scard(userIndexKey(userId));
  }

  async idleTtlRemaining(sessionKey: string): Promise<number> {
    return this.records.ttlSeconds(sessionKey);
  }
}
