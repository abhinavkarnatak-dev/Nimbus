import { InFlight } from '../lib/in-flight.js';
import type { Logger } from '../logging/logger.js';
import type { LeaseManager } from '../redis/lease.js';
import type { E2bClient, E2bRunningSandbox } from './e2b-client.js';
import { OWNER_TAG, ownerQuery } from './e2b-provider.js';

export const SWEEP_INTERVAL_MS = 300_000;
export const SWEEP_GRACE_MS = 60_000;
export const SWEEP_MAX_KILLS = 50;
export const SWEEP_RESOURCE = 'sandbox-sweep';
export const SWEEP_LEASE_SECONDS = 120;

export function leaseLock(
  leases: LeaseManager,
  ttlSeconds: number = SWEEP_LEASE_SECONDS,
): <T>(resource: string, run: () => Promise<T>) => Promise<T | null> {
  return async <T>(resource: string, run: () => Promise<T>): Promise<T | null> => {
    const lease = await leases.acquire(resource, ttlSeconds);
    if (lease === null) {
      return null;
    }

    try {
      return await run();
    } finally {
      await leases.release(lease);
    }
  };
}

export type SweepReason = 'past_deadline' | 'session_ended' | 'unattributed' | 'foreign';

export const KILL_REASONS: readonly SweepReason[] = [
  'past_deadline',
  'session_ended',
  'unattributed',
];

export interface SweepResult {
  inspected: number;
  killed: number;
  failed: number;
  reasons: Record<string, number>;
}

export interface SandboxSweeperOptions {
  client: E2bClient;
  isSessionLive?: (sessionId: string) => Promise<boolean>;
  withLock?: <T>(resource: string, run: () => Promise<T>) => Promise<T | null>;
  logger?: Logger;
  now?: () => number;
  intervalMs?: number;
}

export function decide(
  sandbox: E2bRunningSandbox,
  now: number,
  sessionLive: boolean | null,
): SweepReason | null {
  if (sandbox.metadata['owner'] !== OWNER_TAG) {
    return 'foreign';
  }

  const sessionId = sandbox.metadata['sessionId'];
  if (sessionId === undefined || sessionId.trim() === '') {
    return 'unattributed';
  }

  if (now > sandbox.endAt.getTime() + SWEEP_GRACE_MS) {
    return 'past_deadline';
  }

  if (sessionLive === false) {
    return 'session_ended';
  }

  return null;
}

export class SandboxSweeper {
  private readonly options: SandboxSweeperOptions;
  private readonly now: () => number;
  private readonly intervalMs: number;

  private readonly inFlight = new InFlight();

  private timer: NodeJS.Timeout | null = null;

  constructor(options: SandboxSweeperOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.intervalMs = options.intervalMs ?? SWEEP_INTERVAL_MS;
  }

  start(): void {
    if (this.timer !== null) {
      return;
    }

    this.timer = setInterval(() => {
      void this.sweep();
    }, this.intervalMs);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }

    await this.inFlight.settle();
  }

  async sweep(): Promise<SweepResult | null> {
    return this.inFlight.run(async () => {
      try {
        const withLock = this.options.withLock;
        if (withLock === undefined) {
          return await this.sweepOnce();
        }
        return await withLock(SWEEP_RESOURCE, () => this.sweepOnce());
      } catch (error) {
        this.options.logger?.error({ err: error }, 'sandbox sweep failed');
        return null;
      }
    });
  }

  async sweepOnce(): Promise<SweepResult> {
    const running = await this.options.client.list(ownerQuery());
    const result: SweepResult = { inspected: running.length, killed: 0, failed: 0, reasons: {} };
    const at = this.now();

    for (const sandbox of running) {
      if (result.killed >= SWEEP_MAX_KILLS) {
        break;
      }

      const reason = decide(sandbox, at, await this.sessionLive(sandbox));
      if (reason === null) {
        continue;
      }

      if (!KILL_REASONS.includes(reason)) {
        this.options.logger?.warn(
          { sandboxId: sandbox.sandboxId, reason },
          'sandbox listed but not ours, left alone',
        );
        continue;
      }

      try {
        await this.options.client.kill(sandbox.sandboxId);
        result.killed += 1;
        result.reasons[reason] = (result.reasons[reason] ?? 0) + 1;
        this.options.logger?.warn(
          { sandboxId: sandbox.sandboxId, reason },
          'orphaned sandbox destroyed',
        );
      } catch (error) {
        result.failed += 1;
        this.options.logger?.error(
          { sandboxId: sandbox.sandboxId, reason, err: error },
          'orphaned sandbox could not be destroyed',
        );
      }
    }

    return result;
  }

  private async sessionLive(sandbox: E2bRunningSandbox): Promise<boolean | null> {
    const check = this.options.isSessionLive;
    const sessionId = sandbox.metadata['sessionId'];

    if (check === undefined || sessionId === undefined || sessionId.trim() === '') {
      return null;
    }

    try {
      return await check(sessionId);
    } catch {
      return null;
    }
  }
}
