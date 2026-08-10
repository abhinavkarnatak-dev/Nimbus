import type { Redis } from 'ioredis';

import { buildKey, NAMESPACES } from './keys.js';
import { LuaScript, TOKEN_BUCKET_SCRIPT } from './scripts.js';

const TTL_GRACE_MS = 60_000;

const tokenBucket = new LuaScript<[number, number, number]>(TOKEN_BUCKET_SCRIPT, 1);

export interface RateLimitPolicy {
  name: string;
  capacity: number;
  refillWindowSeconds: number;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterMs: number;
}

export class InvalidRateLimitPolicyError extends RangeError {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidRateLimitPolicyError';
  }
}

function assertPolicy(policy: RateLimitPolicy): void {
  if (!Number.isInteger(policy.capacity) || policy.capacity <= 0) {
    throw new InvalidRateLimitPolicyError('Rate limit capacity must be a positive whole number');
  }
  if (!Number.isFinite(policy.refillWindowSeconds) || policy.refillWindowSeconds <= 0) {
    throw new InvalidRateLimitPolicyError('Rate limit refill window must be a positive number');
  }
}

export class RateLimiter {
  private readonly client: Redis;
  private readonly policy: RateLimitPolicy;
  private readonly refillPerMs: number;
  private readonly ttlMs: number;

  constructor(client: Redis, policy: RateLimitPolicy) {
    assertPolicy(policy);
    this.client = client;
    this.policy = policy;
    this.refillPerMs = policy.capacity / (policy.refillWindowSeconds * 1000);
    this.ttlMs = Math.ceil(policy.refillWindowSeconds * 1000) + TTL_GRACE_MS;
  }

  key(subject: string): string {
    return buildKey(NAMESPACES.rateLimit, this.policy.name, subject);
  }

  async consume(subject: string, cost = 1): Promise<RateLimitResult> {
    if (!Number.isInteger(cost) || cost <= 0) {
      throw new InvalidRateLimitPolicyError('Cost must be a positive whole number');
    }

    const [allowed, remaining, retryAfterMs] = await tokenBucket.run(
      this.client,
      [this.key(subject)],
      [this.policy.capacity, this.refillPerMs, cost, this.ttlMs],
    );

    return { allowed: allowed === 1, remaining, retryAfterMs };
  }

  async reset(subject: string): Promise<void> {
    await this.client.del(this.key(subject));
  }
}
