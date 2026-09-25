import { describe, expect, it } from 'vitest';

import type { Lease } from '../redis/lease.js';
import { Heartbeat, type SessionLeases } from './claim.js';
import { InMemoryLeases, orchestratorLogger } from './orchestrator.fixtures.js';

const TTL_SECONDS = 45;

function flakyLeases(inner: InMemoryLeases, failing: () => boolean): SessionLeases {
  return {
    acquire: (resource, ttl, holder) => inner.acquire(resource, ttl, holder),
    release: (lease) => inner.release(lease),
    holderOf: (resource) => inner.holderOf(resource),
    renew: async (lease, ttl) => {
      if (failing()) {
        throw new Error('Command timed out');
      }
      return inner.renew(lease, ttl);
    },
  };
}

async function held(): Promise<{ inner: InMemoryLeases; lease: Lease }> {
  const inner = new InMemoryLeases();
  const lease = await inner.acquire('run-ses_test', TTL_SECONDS);

  if (lease === null) {
    throw new Error('the lease should have been free');
  }
  return { inner, lease };
}

describe('a heartbeat whose renew throws', () => {
  it('keeps the run alive while the lease cannot yet have expired', async () => {
    const { inner, lease } = await held();
    let clock = 0;
    let lostCalls = 0;
    const captured = orchestratorLogger();

    const heartbeat = new Heartbeat({
      leases: flakyLeases(inner, () => true),
      lease,
      logger: captured.logger,
      ttlSeconds: TTL_SECONDS,
      now: () => clock,
      onLost: () => {
        lostCalls += 1;
      },
    });

    clock = 15_000;
    expect(await heartbeat.beat()).toBe(true);
    clock = 30_000;
    expect(await heartbeat.beat()).toBe(true);

    expect(heartbeat.lost).toBe(false);
    expect(lostCalls).toBe(0);
    expect(captured.text()).toContain('could not be renewed');
  });

  it('gives up once the lease has surely expired', async () => {
    const { inner, lease } = await held();
    let clock = 0;
    let lostCalls = 0;

    const heartbeat = new Heartbeat({
      leases: flakyLeases(inner, () => true),
      lease,
      logger: orchestratorLogger().logger,
      ttlSeconds: TTL_SECONDS,
      now: () => clock,
      onLost: () => {
        lostCalls += 1;
      },
    });

    clock = TTL_SECONDS * 1_000;
    expect(await heartbeat.beat()).toBe(false);
    expect(heartbeat.lost).toBe(true);
    expect(lostCalls).toBe(1);
  });

  it('measures expiry from the last renewal that succeeded', async () => {
    const { inner, lease } = await held();
    let clock = 0;
    let failing = false;

    const heartbeat = new Heartbeat({
      leases: flakyLeases(inner, () => failing),
      lease,
      logger: orchestratorLogger().logger,
      ttlSeconds: TTL_SECONDS,
      now: () => clock,
      onLost: () => undefined,
    });

    clock = 30_000;
    expect(await heartbeat.beat()).toBe(true);

    failing = true;
    clock = 60_000;
    expect(await heartbeat.beat()).toBe(true);
    clock = 75_000;
    expect(await heartbeat.beat()).toBe(false);
    expect(heartbeat.lost).toBe(true);
  });
});

describe('a heartbeat whose lease was taken by somebody else', () => {
  it('is lost at once', async () => {
    const { inner, lease } = await held();
    let lostCalls = 0;

    const heartbeat = new Heartbeat({
      leases: inner,
      lease,
      logger: orchestratorLogger().logger,
      ttlSeconds: TTL_SECONDS,
      onLost: () => {
        lostCalls += 1;
      },
    });

    inner.steal(lease.resource);

    expect(await heartbeat.beat()).toBe(false);
    expect(heartbeat.lost).toBe(true);
    expect(lostCalls).toBe(1);
    expect(await heartbeat.beat()).toBe(false);
    expect(lostCalls).toBe(1);
  });
});
