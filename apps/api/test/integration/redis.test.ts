import { createTestRedis, testRedisUrl, type TestRedis } from '@nimbus/test-utils';
import { Redis } from 'ioredis';
import { z } from 'zod';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createTestLogger } from '../../src/http/http.fixtures.js';
import { IdempotencyStore } from '../../src/redis/idempotency.js';
import { LeaseManager, type Lease } from '../../src/redis/lease.js';
import { NonceStore } from '../../src/redis/nonce.js';
import { RateLimiter } from '../../src/redis/rate-limit.js';
import { InvalidTtlError, TypedStore } from '../../src/redis/store.js';
import { NAMESPACES } from '../../src/redis/keys.js';

const RecordSchema = z.strictObject({ email: z.string(), attempts: z.number() });
type StoredRecord = z.infer<typeof RecordSchema>;

let redis: TestRedis;

beforeAll(async () => {
  redis = await createTestRedis();
});

afterAll(async () => {
  await redis.cleanup();
});

beforeEach(async () => {
  await redis.client.flushdb();
});

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function requireLease(lease: Lease | null): Lease {
  if (lease === null) {
    throw new Error('Expected the lease to be acquired');
  }
  return lease;
}

function store(logger?: ReturnType<typeof createTestLogger>['logger']): TypedStore<StoredRecord> {
  return new TypedStore(redis.client, {
    namespace: NAMESPACES.otp,
    schema: RecordSchema,
    defaultTtlSeconds: 60,
    ...(logger === undefined ? {} : { logger }),
  });
}

describe('typed storage', () => {
  it('stores and returns a value that matches its schema', async () => {
    const subject = store();
    await subject.set('one', { email: 'a@example.com', attempts: 0 });

    expect(await subject.get('one')).toEqual({ email: 'a@example.com', attempts: 0 });
  });

  it('returns nothing for a key that was never written', async () => {
    expect(await store().get('missing')).toBeNull();
  });

  it('refuses to write without a usable expiry', async () => {
    const subject = store();

    await expect(subject.set('x', { email: 'a', attempts: 0 }, 0)).rejects.toThrow(InvalidTtlError);
    await expect(subject.set('x', { email: 'a', attempts: 0 }, -5)).rejects.toThrow(
      InvalidTtlError,
    );
    await expect(subject.set('x', { email: 'a', attempts: 0 }, 1.5)).rejects.toThrow(
      InvalidTtlError,
    );
  });

  it('actually applies the expiry it was given', async () => {
    const subject = store();
    await subject.set('ttl', { email: 'a', attempts: 0 }, 30);

    const ttl = await subject.ttlSeconds('ttl');
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(30);
  });

  it('forgets a value once its time is up', async () => {
    const subject = store();
    await subject.set('short', { email: 'a', attempts: 0 }, 1);

    expect(await subject.get('short')).not.toBeNull();
    await wait(1_200);
    expect(await subject.get('short')).toBeNull();
  });

  it('throws away a value whose shape no longer matches, rather than breaking', async () => {
    const { logger, lines } = createTestLogger();
    const subject = store(logger);
    await redis.client.set('nimbus:otp:stale', JSON.stringify({ wrong: 'shape' }), 'EX', 60);

    expect(await subject.get('stale')).toBeNull();
    expect(await redis.client.exists('nimbus:otp:stale')).toBe(0);
    expect(JSON.stringify(lines)).toContain('no longer matches');
  });

  it('throws away a value that is not readable at all', async () => {
    const subject = store();
    await redis.client.set('nimbus:otp:broken', 'not json', 'EX', 60);

    expect(await subject.get('broken')).toBeNull();
    expect(await redis.client.exists('nimbus:otp:broken')).toBe(0);
  });

  it('refuses to store a value that does not match its schema', async () => {
    const subject = store();

    await expect(
      subject.set('bad', { email: 'a', attempts: 'many' } as unknown as StoredRecord),
    ).rejects.toThrow();
  });

  it('reads and removes in one step with take', async () => {
    const subject = store();
    await subject.set('once', { email: 'a', attempts: 1 });

    expect(await subject.take('once')).toEqual({ email: 'a', attempts: 1 });
    expect(await subject.take('once')).toBeNull();
  });

  it('only claims a key when it is free', async () => {
    const subject = store();

    expect(await subject.setIfAbsent('claim', { email: 'first', attempts: 0 })).toBe(true);
    expect(await subject.setIfAbsent('claim', { email: 'second', attempts: 0 })).toBe(false);
    expect((await subject.get('claim'))?.email).toBe('first');
  });
});

describe('rate limits', () => {
  it('allows up to the capacity and then refuses', async () => {
    const limiter = new RateLimiter(redis.client, {
      name: 'test-basic',
      capacity: 3,
      refillWindowSeconds: 3_600,
    });

    const outcomes = [];
    for (let i = 0; i < 5; i += 1) {
      outcomes.push(await limiter.consume('user'));
    }

    expect(outcomes.filter((outcome) => outcome.allowed)).toHaveLength(3);
    expect(outcomes.filter((outcome) => !outcome.allowed)).toHaveLength(2);
  });

  it('says how long to wait when it refuses', async () => {
    const limiter = new RateLimiter(redis.client, {
      name: 'test-retry',
      capacity: 1,
      refillWindowSeconds: 60,
    });

    await limiter.consume('user');
    const refused = await limiter.consume('user');

    expect(refused.allowed).toBe(false);
    expect(refused.retryAfterMs).toBeGreaterThan(0);
    expect(refused.retryAfterMs).toBeLessThanOrEqual(60_000);
  });

  it('refills over time instead of resetting all at once', async () => {
    const limiter = new RateLimiter(redis.client, {
      name: 'test-refill',
      capacity: 2,
      refillWindowSeconds: 0.4,
    });

    expect((await limiter.consume('user')).allowed).toBe(true);
    expect((await limiter.consume('user')).allowed).toBe(true);
    expect((await limiter.consume('user')).allowed).toBe(false);

    await wait(300);

    expect((await limiter.consume('user')).allowed).toBe(true);
  });

  it('keeps different subjects apart', async () => {
    const limiter = new RateLimiter(redis.client, {
      name: 'test-subjects',
      capacity: 1,
      refillWindowSeconds: 60,
    });

    expect((await limiter.consume('alice')).allowed).toBe(true);
    expect((await limiter.consume('bob')).allowed).toBe(true);
    expect((await limiter.consume('alice')).allowed).toBe(false);
  });

  it('allows exactly the capacity when many requests arrive together', async () => {
    const limiter = new RateLimiter(redis.client, {
      name: 'test-burst',
      capacity: 10,
      refillWindowSeconds: 3_600,
    });

    const outcomes = await Promise.all(
      Array.from({ length: 50 }, async () => limiter.consume('crowd')),
    );

    expect(outcomes.filter((outcome) => outcome.allowed)).toHaveLength(10);
  });

  it('gives the key an expiry so an idle bucket does not live forever', async () => {
    const limiter = new RateLimiter(redis.client, {
      name: 'test-ttl',
      capacity: 1,
      refillWindowSeconds: 60,
    });
    await limiter.consume('user');

    expect(await redis.client.ttl(limiter.key('user'))).toBeGreaterThan(0);
  });
});

describe('one time values', () => {
  const PayloadSchema = z.strictObject({ userId: z.string() });

  function nonces(purpose = 'google-login'): NonceStore<{ userId: string }> {
    return new NonceStore(redis.client, { purpose, schema: PayloadSchema, ttlSeconds: 60 });
  }

  it('returns the payload the first time', async () => {
    const subject = nonces();
    const nonce = await subject.issue({ userId: 'usr_1' });

    expect(await subject.consume(nonce)).toEqual({ userId: 'usr_1' });
  });

  it('returns nothing the second time', async () => {
    const subject = nonces();
    const nonce = await subject.issue({ userId: 'usr_1' });

    await subject.consume(nonce);
    expect(await subject.consume(nonce)).toBeNull();
  });

  it('lets exactly one of twenty simultaneous attempts win', async () => {
    const subject = nonces();
    const nonce = await subject.issue({ userId: 'usr_race' });

    const outcomes = await Promise.all(
      Array.from({ length: 20 }, async () => subject.consume(nonce)),
    );

    expect(outcomes.filter((outcome) => outcome !== null)).toHaveLength(1);
  });

  it('refuses a value issued for a different purpose', async () => {
    const google = nonces('google-login');
    const github = nonces('github-setup');
    const nonce = await google.issue({ userId: 'usr_1' });

    expect(await github.consume(nonce)).toBeNull();
  });

  it('refuses a value that was never issued', async () => {
    expect(await nonces().consume('non_aaaaaaaaaaaaaaaaaaaaa')).toBeNull();
  });

  it('refuses a malformed value without letting it reach the key builder', async () => {
    const subject = nonces();

    expect(await subject.consume('')).toBeNull();
    expect(await subject.consume('not-a-nonce')).toBeNull();
    expect(await subject.consume('non_short')).toBeNull();
    expect(await subject.consume('non_aaaaaaaaaaaaaaaaaaaaa:injected')).toBeNull();
    expect(await subject.consume('non_aaaaaaaaaaaaaaaaaaa*')).toBeNull();
  });

  it('gives every value an expiry', async () => {
    const subject = nonces();
    const nonce = await subject.issue({ userId: 'usr_1' });

    expect(await redis.client.ttl(`nimbus:nonce:${nonce}`)).toBeGreaterThan(0);
  });
});

describe('leases', () => {
  it('lets the first holder take it and refuses the second', async () => {
    const leases = new LeaseManager(redis.client);

    const first = await leases.acquire('session-1', 30);
    const second = await leases.acquire('session-1', 30);

    expect(first).not.toBeNull();
    expect(second).toBeNull();
  });

  it('lets exactly one of twenty simultaneous workers win', async () => {
    const leases = new LeaseManager(redis.client);

    const outcomes = await Promise.all(
      Array.from({ length: 20 }, async () => leases.acquire('session-race', 30)),
    );

    expect(outcomes.filter((outcome) => outcome !== null)).toHaveLength(1);
  });

  it('lets exactly one win when the workers are separate connections', async () => {
    const clients = await Promise.all(
      Array.from({ length: 8 }, async () => {
        const client = new Redis(testRedisUrl(), { db: redis.database, lazyConnect: true });
        await client.connect();
        return client;
      }),
    );

    try {
      const outcomes = await Promise.all(
        clients.map(async (client) => new LeaseManager(client).acquire('session-multi', 30)),
      );

      expect(outcomes.filter((outcome) => outcome !== null)).toHaveLength(1);
    } finally {
      await Promise.all(clients.map(async (client) => client.quit()));
    }
  });

  it('lets the holder renew it', async () => {
    const leases = new LeaseManager(redis.client);
    const lease = requireLease(await leases.acquire('session-2', 1));

    expect(await leases.renew(lease, 60)).toBe(true);
    expect(await leases.ttlMs('session-2')).toBeGreaterThan(1_500);
  });

  it('refuses to renew a lease that has been taken over', async () => {
    const leases = new LeaseManager(redis.client);
    const stale = requireLease(await leases.acquire('session-3', 1));

    await wait(1_200);
    const fresh = requireLease(await leases.acquire('session-3', 30));

    expect(await leases.renew(stale, 30)).toBe(false);
    expect(await leases.holderOf('session-3')).toBe(fresh.holder);
  });

  it('refuses to release a lease that has been taken over', async () => {
    const leases = new LeaseManager(redis.client);
    const stale = requireLease(await leases.acquire('session-4', 1));

    await wait(1_200);
    const fresh = requireLease(await leases.acquire('session-4', 30));

    expect(await leases.release(stale)).toBe(false);
    expect(await leases.holderOf('session-4')).toBe(fresh.holder);
  });

  it('frees the resource when the holder releases it', async () => {
    const leases = new LeaseManager(redis.client);
    const lease = requireLease(await leases.acquire('session-5', 30));

    expect(await leases.release(lease)).toBe(true);
    expect(await leases.acquire('session-5', 30)).not.toBeNull();
  });

  it('frees itself when a worker dies without releasing', async () => {
    const leases = new LeaseManager(redis.client);
    await leases.acquire('session-6', 1);

    expect(await leases.acquire('session-6', 30)).toBeNull();
    await wait(1_200);
    expect(await leases.acquire('session-6', 30)).not.toBeNull();
  });

  it('always gives the lease an expiry', async () => {
    const leases = new LeaseManager(redis.client);
    await leases.acquire('session-7', 30);

    expect(await leases.ttlMs('session-7')).toBeGreaterThan(0);
  });
});

describe('do it once records', () => {
  const ResultSchema = z.strictObject({ pullRequest: z.number() });

  function idempotency(): IdempotencyStore<{ pullRequest: number }> {
    return new IdempotencyStore(redis.client, {
      schema: ResultSchema,
      runningTtlSeconds: 30,
      completedTtlSeconds: 60,
    });
  }

  it('tells the first caller to start', async () => {
    expect(await idempotency().begin('idk_1')).toEqual({ status: 'started' });
  });

  it('tells a second caller it is already running', async () => {
    const subject = idempotency();
    await subject.begin('idk_2');

    expect(await subject.begin('idk_2')).toEqual({ status: 'running' });
  });

  it('gives back the original result once it is finished', async () => {
    const subject = idempotency();
    await subject.begin('idk_3');
    await subject.complete('idk_3', { pullRequest: 42 });

    expect(await subject.begin('idk_3')).toEqual({
      status: 'completed',
      result: { pullRequest: 42 },
    });
  });

  it('lets exactly one of ten simultaneous callers start', async () => {
    const subject = idempotency();

    const outcomes = await Promise.all(
      Array.from({ length: 10 }, async () => subject.begin('idk_race')),
    );

    expect(outcomes.filter((outcome) => outcome.status === 'started')).toHaveLength(1);
  });

  it('lets the work be retried after it is abandoned', async () => {
    const subject = idempotency();
    await subject.begin('idk_4');
    await subject.abandon('idk_4');

    expect(await subject.begin('idk_4')).toEqual({ status: 'started' });
  });

  it('gives the record an expiry in both states', async () => {
    const subject = idempotency();
    await subject.begin('idk_5');
    expect(await redis.client.ttl('nimbus:idem:idk_5')).toBeGreaterThan(0);

    await subject.complete('idk_5', { pullRequest: 1 });
    expect(await redis.client.ttl('nimbus:idem:idk_5')).toBeGreaterThan(0);
  });
});

describe('no key is ever left without an expiry', () => {
  it('holds after exercising every primitive', async () => {
    const limiter = new RateLimiter(redis.client, {
      name: 'sweep',
      capacity: 2,
      refillWindowSeconds: 60,
    });
    const leases = new LeaseManager(redis.client);
    const nonceStore = new NonceStore(redis.client, {
      purpose: 'sweep',
      schema: z.strictObject({ value: z.string() }),
      ttlSeconds: 60,
    });
    const idempotency = new IdempotencyStore(redis.client, {
      schema: z.strictObject({ ok: z.boolean() }),
      runningTtlSeconds: 30,
      completedTtlSeconds: 60,
    });

    await store().set('sweep', { email: 'a', attempts: 0 });
    await limiter.consume('sweep');
    await leases.acquire('sweep', 30);
    await nonceStore.issue({ value: 'x' });
    await idempotency.begin('sweep');
    await idempotency.complete('sweep', { ok: true });

    const keys = await redis.client.keys('nimbus:*');
    expect(keys.length).toBeGreaterThanOrEqual(5);

    const withoutExpiry: string[] = [];
    for (const key of keys) {
      if ((await redis.client.ttl(key)) < 0) {
        withoutExpiry.push(key);
      }
    }

    expect(withoutExpiry).toEqual([]);
  });
});

describe('reconnecting after the connection is cut', () => {
  it('recovers when the server kills the connection', async () => {
    const client = new Redis(testRedisUrl(), {
      db: redis.database,
      lazyConnect: true,
      retryStrategy: () => 50,
    });
    await client.connect();
    await client.set('nimbus:otp:reconnect', 'before', 'EX', 60);

    let reconnecting = 0;
    client.on('reconnecting', () => {
      reconnecting += 1;
    });

    const id = await client.client('ID');
    const killed = await redis.client.call('CLIENT', 'KILL', 'ID', String(id));
    expect(killed).toBe(1);

    let recovered: string | null = null;
    for (let attempt = 0; attempt < 20 && recovered === null; attempt += 1) {
      try {
        recovered = await client.get('nimbus:otp:reconnect');
      } catch {
        await wait(50);
      }
    }

    expect(recovered).toBe('before');
    expect(reconnecting).toBeGreaterThanOrEqual(1);
    await client.quit();
  });
});
