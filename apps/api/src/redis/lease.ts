import type { Redis } from 'ioredis';

import { newPrefixedId } from '../lib/id.js';
import { buildKey, NAMESPACES } from './keys.js';
import { LuaScript, RELEASE_LEASE_SCRIPT, RENEW_LEASE_SCRIPT } from './scripts.js';

const renewScript = new LuaScript<number>(RENEW_LEASE_SCRIPT, 1);
const releaseScript = new LuaScript<number>(RELEASE_LEASE_SCRIPT, 1);

export const HOLDER_PREFIX = 'hld';

export interface Lease {
  resource: string;
  holder: string;
  expiresAt: Date;
}

export class InvalidLeaseTtlError extends RangeError {
  constructor(ttlSeconds: number) {
    super(
      `Lease time to live must be a positive number of seconds, received ${String(ttlSeconds)}`,
    );
    this.name = 'InvalidLeaseTtlError';
  }
}

function assertTtl(ttlSeconds: number): void {
  if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
    throw new InvalidLeaseTtlError(ttlSeconds);
  }
}

export class LeaseManager {
  private readonly client: Redis;

  constructor(client: Redis) {
    this.client = client;
  }

  key(resource: string): string {
    return buildKey(NAMESPACES.lease, resource);
  }

  async acquire(resource: string, ttlSeconds: number, holder?: string): Promise<Lease | null> {
    assertTtl(ttlSeconds);
    const owner = holder ?? newPrefixedId(HOLDER_PREFIX);
    const ttlMs = Math.ceil(ttlSeconds * 1000);

    const outcome = await this.client.set(this.key(resource), owner, 'PX', ttlMs, 'NX');
    if (outcome !== 'OK') {
      return null;
    }

    return { resource, holder: owner, expiresAt: new Date(Date.now() + ttlMs) };
  }

  async renew(lease: Lease, ttlSeconds: number): Promise<boolean> {
    assertTtl(ttlSeconds);
    const ttlMs = Math.ceil(ttlSeconds * 1000);
    const outcome = await renewScript.run(
      this.client,
      [this.key(lease.resource)],
      [lease.holder, ttlMs],
    );

    if (outcome !== 1) {
      return false;
    }
    lease.expiresAt = new Date(Date.now() + ttlMs);
    return true;
  }

  async release(lease: Lease): Promise<boolean> {
    const outcome = await releaseScript.run(
      this.client,
      [this.key(lease.resource)],
      [lease.holder],
    );
    return outcome === 1;
  }

  async holderOf(resource: string): Promise<string | null> {
    return this.client.get(this.key(resource));
  }

  async ttlMs(resource: string): Promise<number> {
    return this.client.pttl(this.key(resource));
  }
}
