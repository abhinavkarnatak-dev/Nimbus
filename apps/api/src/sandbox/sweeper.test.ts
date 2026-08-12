import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { E2bRunningSandbox } from './e2b-client.js';
import { FakeE2bClient } from './e2b-fake-client.js';
import { OWNER_TAG } from './e2b-provider.js';
import type { LeaseManager } from '../redis/lease.js';
import {
  KILL_REASONS,
  SWEEP_GRACE_MS,
  SWEEP_INTERVAL_MS,
  SWEEP_LEASE_SECONDS,
  SWEEP_MAX_KILLS,
  SWEEP_RESOURCE,
  SandboxSweeper,
  decide,
  leaseLock,
} from './sweeper.js';

const NOW = Date.UTC(2026, 7, 13, 12, 0, 0);

function running(overrides: Partial<E2bRunningSandbox> = {}): E2bRunningSandbox {
  return {
    sandboxId: 'sbx_one',
    metadata: { owner: OWNER_TAG, sessionId: 'ses_aaaaaaaaaaaaaaaaaaaaaa' },
    startedAt: new Date(NOW - 60_000),
    endAt: new Date(NOW + 60_000),
    ...overrides,
  };
}

describe('decide', () => {
  it('leaves a live sandbox inside its deadline alone', () => {
    expect(decide(running(), NOW, true)).toBeNull();
  });

  it('leaves a sandbox alone when nothing is known about its session', () => {
    expect(decide(running(), NOW, null)).toBeNull();
  });

  it('kills a sandbox past its deadline and past the grace period', () => {
    const late = running({ endAt: new Date(NOW - SWEEP_GRACE_MS - 1_000) });

    expect(decide(late, NOW, true)).toBe('past_deadline');
  });

  it('does not kill a sandbox that only just passed its deadline', () => {
    const barely = running({ endAt: new Date(NOW - 1_000) });

    expect(decide(barely, NOW, true)).toBeNull();
  });

  it('kills a sandbox whose session has ended', () => {
    expect(decide(running(), NOW, false)).toBe('session_ended');
  });

  it('kills a sandbox nobody can attribute to a session', () => {
    const orphan = running({ metadata: { owner: OWNER_TAG } });

    expect(decide(orphan, NOW, null)).toBe('unattributed');
  });

  it('kills a sandbox whose session id is blank', () => {
    const blank = running({ metadata: { owner: OWNER_TAG, sessionId: '  ' } });

    expect(decide(blank, NOW, null)).toBe('unattributed');
  });

  it('treats an untagged sandbox as foreign rather than silently killing it as ours', () => {
    const foreign = running({ metadata: {} });

    expect(decide(foreign, NOW, null)).toBe('foreign');
  });

  it('prefers the deadline reason when a sandbox is both late and ended', () => {
    const late = running({ endAt: new Date(NOW - SWEEP_GRACE_MS - 1_000) });

    expect(decide(late, NOW, false)).toBe('past_deadline');
  });
});

describe('SandboxSweeper.sweepOnce', () => {
  it('asks only for sandboxes tagged as ours', async () => {
    const client = new FakeE2bClient({ running: [] });
    await new SandboxSweeper({ client, now: () => NOW }).sweepOnce();

    expect(client.listQueries).toEqual([{ owner: OWNER_TAG }]);
  });

  it('destroys a sandbox past its deadline', async () => {
    const late = running({ endAt: new Date(NOW - SWEEP_GRACE_MS - 1_000) });
    const client = new FakeE2bClient({ running: [late] });
    const result = await new SandboxSweeper({ client, now: () => NOW }).sweepOnce();

    expect(client.killedIds).toEqual(['sbx_one']);
    expect(result.killed).toBe(1);
    expect(result.inspected).toBe(1);
    expect(result.reasons['past_deadline']).toBe(1);
  });

  it('leaves a healthy sandbox running', async () => {
    const client = new FakeE2bClient({ running: [running()] });
    const result = await new SandboxSweeper({ client, now: () => NOW }).sweepOnce();

    expect(client.killedIds).toEqual([]);
    expect(result.killed).toBe(0);
  });

  it('destroys a sandbox whose session has ended', async () => {
    const client = new FakeE2bClient({ running: [running()] });
    const result = await new SandboxSweeper({
      client,
      now: () => NOW,
      isSessionLive: () => Promise.resolve(false),
    }).sweepOnce();

    expect(client.killedIds).toEqual(['sbx_one']);
    expect(result.reasons['session_ended']).toBe(1);
  });

  it('leaves a sandbox alone when the session check itself failed', async () => {
    const client = new FakeE2bClient({ running: [running()] });
    const result = await new SandboxSweeper({
      client,
      now: () => NOW,
      isSessionLive: () => Promise.reject(new Error('mongo down')),
    }).sweepOnce();

    expect(client.killedIds).toEqual([]);
    expect(result.killed).toBe(0);
  });

  it('keeps going when one sandbox cannot be destroyed', async () => {
    const late = (id: string): E2bRunningSandbox =>
      running({ sandboxId: id, endAt: new Date(NOW - SWEEP_GRACE_MS - 1_000) });
    const client = new FakeE2bClient({
      running: [late('sbx_a'), late('sbx_b')],
      killFails: new Error('kill failed'),
    });
    const result = await new SandboxSweeper({ client, now: () => NOW }).sweepOnce();

    expect(result.failed).toBe(2);
    expect(result.killed).toBe(0);
  });

  it('stops after the cap, so one bad sweep cannot run away', async () => {
    const many: E2bRunningSandbox[] = [];
    for (let index = 0; index < SWEEP_MAX_KILLS + 10; index += 1) {
      many.push(
        running({
          sandboxId: `sbx_${String(index)}`,
          endAt: new Date(NOW - SWEEP_GRACE_MS - 1_000),
        }),
      );
    }
    const client = new FakeE2bClient({ running: many });
    const result = await new SandboxSweeper({ client, now: () => NOW }).sweepOnce();

    expect(result.killed).toBe(SWEEP_MAX_KILLS);
    expect(client.killedIds).toHaveLength(SWEEP_MAX_KILLS);
  });

  it('does not touch a sandbox belonging to somebody else', async () => {
    const client = new FakeE2bClient({
      running: [running({ metadata: { owner: 'someone-else' } })],
    });
    const result = await new SandboxSweeper({ client, now: () => NOW }).sweepOnce();

    expect(client.killedIds).toEqual([]);
    expect(result.killed).toBe(0);
  });

  it('does not touch a foreign sandbox even when it is long past its deadline', async () => {
    const foreign = running({
      metadata: { owner: 'someone-else', sessionId: 'ses_theirs' },
      endAt: new Date(NOW - SWEEP_GRACE_MS - 86_400_000),
    });
    const client = new FakeE2bClient({ running: [foreign] });
    const result = await new SandboxSweeper({ client, now: () => NOW }).sweepOnce();

    expect(client.killedIds).toEqual([]);
    expect(result.killed).toBe(0);
  });

  it('never treats being foreign as a reason to destroy something', () => {
    expect(KILL_REASONS).not.toContain('foreign');
    expect(KILL_REASONS).toEqual(['past_deadline', 'session_ended', 'unattributed']);
  });
});

describe('SandboxSweeper.sweep', () => {
  it('runs inside the lock when one is given', async () => {
    const client = new FakeE2bClient({ running: [] });
    const resources: string[] = [];
    const sweeper = new SandboxSweeper({
      client,
      now: () => NOW,
      withLock: async (resource, run) => {
        resources.push(resource);
        return run();
      },
    });

    await sweeper.sweep();

    expect(resources).toEqual([SWEEP_RESOURCE]);
    expect(client.listQueries).toHaveLength(1);
  });

  it('does nothing when another copy of the backend holds the lock', async () => {
    const client = new FakeE2bClient({ running: [running()] });
    const sweeper = new SandboxSweeper({
      client,
      now: () => NOW,
      withLock: () => Promise.resolve(null),
    });

    expect(await sweeper.sweep()).toBeNull();
    expect(client.listQueries).toHaveLength(0);
  });

  it('reports a failed sweep as nothing rather than throwing at a timer', async () => {
    const client = new FakeE2bClient();
    const sweeper = new SandboxSweeper({
      client,
      now: () => NOW,
      withLock: () => Promise.reject(new Error('redis down')),
    });

    expect(await sweeper.sweep()).toBeNull();
  });

  it('does not start a second sweep while one is running', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const client = new FakeE2bClient({ running: [] });
    const sweeper = new SandboxSweeper({
      client,
      now: () => NOW,
      withLock: async (_resource, run) => {
        await gate;
        return run();
      },
    });

    const first = sweeper.sweep();
    const second = await sweeper.sweep();
    release();
    await first;

    expect(second).toBeNull();
    expect(client.listQueries).toHaveLength(1);
  });
});

describe('leaseLock', () => {
  interface FakeLeases {
    acquire: (resource: string, ttlSeconds: number) => Promise<{ resource: string } | null>;
    release: (lease: { resource: string }) => Promise<boolean>;
  }

  function leases(granted: boolean, released: string[]): FakeLeases {
    return {
      acquire: (resource) => Promise.resolve(granted ? { resource } : null),
      release: (lease) => {
        released.push(lease.resource);
        return Promise.resolve(true);
      },
    };
  }

  it('runs the work and gives the lease back', async () => {
    const released: string[] = [];
    const lock = leaseLock(leases(true, released) as unknown as LeaseManager);

    expect(await lock('sweep', () => Promise.resolve('done'))).toBe('done');
    expect(released).toEqual(['sweep']);
  });

  it('does nothing when the lease was not granted', async () => {
    let ran = false;
    const lock = leaseLock(leases(false, []) as unknown as LeaseManager);

    const outcome = await lock('sweep', () => {
      ran = true;
      return Promise.resolve('done');
    });

    expect(outcome).toBeNull();
    expect(ran).toBe(false);
  });

  it('gives the lease back even when the work threw', async () => {
    const released: string[] = [];
    const lock = leaseLock(leases(true, released) as unknown as LeaseManager);

    await expect(lock('sweep', () => Promise.reject(new Error('sweep blew up')))).rejects.toThrow(
      'sweep blew up',
    );
    expect(released).toEqual(['sweep']);
  });

  it('holds the lease for longer than a sweep should ever take', () => {
    expect(SWEEP_LEASE_SECONDS).toBeGreaterThanOrEqual(60);
  });
});

describe('SandboxSweeper timer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('sweeps on a schedule once started', async () => {
    const client = new FakeE2bClient({ running: [] });
    const sweeper = new SandboxSweeper({ client, now: () => NOW, intervalMs: 1_000 });

    sweeper.start();
    await vi.advanceTimersByTimeAsync(3_500);
    sweeper.stop();

    expect(client.listQueries).toHaveLength(3);
  });

  it('stops sweeping once stopped', async () => {
    const client = new FakeE2bClient({ running: [] });
    const sweeper = new SandboxSweeper({ client, now: () => NOW, intervalMs: 1_000 });

    sweeper.start();
    await vi.advanceTimersByTimeAsync(1_500);
    sweeper.stop();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(client.listQueries).toHaveLength(1);
  });

  it('starting twice does not sweep twice as often', async () => {
    const client = new FakeE2bClient({ running: [] });
    const sweeper = new SandboxSweeper({ client, now: () => NOW, intervalMs: 1_000 });

    sweeper.start();
    sweeper.start();
    await vi.advanceTimersByTimeAsync(2_500);
    sweeper.stop();

    expect(client.listQueries).toHaveLength(2);
  });

  it('stopping without starting is harmless', () => {
    const sweeper = new SandboxSweeper({ client: new FakeE2bClient() });

    expect(() => {
      sweeper.stop();
    }).not.toThrow();
  });

  it('defaults to a quiet interval rather than a busy one', () => {
    expect(SWEEP_INTERVAL_MS).toBeGreaterThanOrEqual(60_000);
  });
});
