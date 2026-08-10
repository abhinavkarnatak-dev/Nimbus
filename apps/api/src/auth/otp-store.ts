import type { Redis } from 'ioredis';
import { z } from 'zod';

import type { Logger } from '../logging/logger.js';
import { buildKey, NAMESPACES } from '../redis/keys.js';
import { TypedStore } from '../redis/store.js';

export const OTP_PURPOSE = 'sign-in';

export const OtpRecordSchema = z.strictObject({
  requestId: z.string().min(1),
  email: z.string().min(1),
  codeHash: z.string().min(1),
  purpose: z.literal(OTP_PURPOSE),
  issuedAt: z.string().min(1),
});

export type OtpRecord = z.infer<typeof OtpRecordSchema>;

function activeKey(emailHash: string): string {
  return buildKey(NAMESPACES.otp, 'active', emailHash);
}

function attemptsKey(requestId: string): string {
  return buildKey(NAMESPACES.otp, 'attempts', requestId);
}

function cooldownKey(emailHash: string): string {
  return buildKey(NAMESPACES.otp, 'cooldown', emailHash);
}

export interface OtpStoreOptions {
  ttlSeconds: number;
  logger?: Logger;
}

export class OtpStore {
  private readonly client: Redis;
  private readonly records: TypedStore<OtpRecord>;
  private readonly ttlSeconds: number;

  constructor(client: Redis, options: OtpStoreOptions) {
    this.client = client;
    this.ttlSeconds = options.ttlSeconds;
    this.records = new TypedStore(client, {
      namespace: NAMESPACES.otp,
      schema: OtpRecordSchema,
      defaultTtlSeconds: options.ttlSeconds,
      ...(options.logger === undefined ? {} : { logger: options.logger }),
    });
  }

  async replaceOutstanding(emailHash: string, record: OtpRecord): Promise<void> {
    const previous = await this.client.get(activeKey(emailHash));

    if (previous !== null) {
      await this.discard(previous);
    }

    await this.records.set(record.requestId, record, this.ttlSeconds);
    await this.client.set(activeKey(emailHash), record.requestId, 'EX', this.ttlSeconds);
  }

  async read(requestId: string): Promise<OtpRecord | null> {
    return this.records.get(requestId);
  }

  async countAttempt(requestId: string): Promise<number> {
    const key = attemptsKey(requestId);
    const attempts = await this.client.incr(key);
    if (attempts === 1) {
      await this.client.expire(key, this.ttlSeconds);
    }
    return attempts;
  }

  async claim(requestId: string): Promise<boolean> {
    return (await this.client.del(this.records.key(requestId))) === 1;
  }

  async discard(requestId: string): Promise<void> {
    await this.client.del(this.records.key(requestId), attemptsKey(requestId));
  }

  async startCooldown(emailHash: string, seconds: number): Promise<boolean> {
    const outcome = await this.client.set(cooldownKey(emailHash), '1', 'EX', seconds, 'NX');
    return outcome === 'OK';
  }

  async clearCooldown(emailHash: string): Promise<void> {
    await this.client.del(cooldownKey(emailHash));
  }

  async cooldownRemainingSeconds(emailHash: string): Promise<number> {
    const ttl = await this.client.ttl(cooldownKey(emailHash));
    return ttl > 0 ? ttl : 0;
  }

  async clearActive(emailHash: string): Promise<void> {
    await this.client.del(activeKey(emailHash));
  }
}
