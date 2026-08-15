import type { Logger } from '../logging/logger.js';
import type { Lease } from '../redis/lease.js';
import { ORCHESTRATOR_LIMITS } from './limits.js';

export interface SessionLeases {
  acquire(resource: string, ttlSeconds: number, holder?: string): Promise<Lease | null>;
  renew(lease: Lease, ttlSeconds: number): Promise<boolean>;
  release(lease: Lease): Promise<boolean>;
  holderOf(resource: string): Promise<string | null>;
}

export const SESSION_LEASE_PREFIX = 'run';

export function leaseResource(sessionId: string): string {
  return `${SESSION_LEASE_PREFIX}-${sessionId}`;
}

export interface HeartbeatOptions {
  leases: SessionLeases;
  lease: Lease;
  logger: Logger;
  everyMs?: number;
  ttlSeconds?: number;
  onLost: () => void;
}

export class Heartbeat {
  readonly #leases: SessionLeases;

  readonly #lease: Lease;

  readonly #logger: Logger;

  readonly #everyMs: number;

  readonly #ttlSeconds: number;

  readonly #onLost: () => void;

  #timer: NodeJS.Timeout | null = null;

  #lost = false;

  constructor(options: HeartbeatOptions) {
    this.#leases = options.leases;
    this.#lease = options.lease;
    this.#logger = options.logger;
    this.#everyMs = options.everyMs ?? ORCHESTRATOR_LIMITS.heartbeatMs;
    this.#ttlSeconds = options.ttlSeconds ?? ORCHESTRATOR_LIMITS.leaseSeconds;
    this.#onLost = options.onLost;
  }

  get lost(): boolean {
    return this.#lost;
  }

  start(): void {
    if (this.#timer !== null) {
      return;
    }

    this.#timer = setInterval(() => {
      void this.beat();
    }, this.#everyMs);

    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer === null) {
      return;
    }

    clearInterval(this.#timer);
    this.#timer = null;
  }

  async beat(): Promise<boolean> {
    if (this.#lost) {
      return false;
    }

    let held: boolean;

    try {
      held = await this.#leases.renew(this.#lease, this.#ttlSeconds);
    } catch (error) {
      this.#logger.warn(
        { resource: this.#lease.resource, error: String(error) },
        'a session lease could not be renewed',
      );
      held = false;
    }

    if (held) {
      return true;
    }

    this.#lost = true;
    this.stop();

    this.#logger.warn(
      { resource: this.#lease.resource },
      'a session lease was lost, so this worker stops running it',
    );

    this.#onLost();
    return false;
  }
}

export interface ClaimOptions {
  leases: SessionLeases;
  logger: Logger;
  ttlSeconds?: number;
}

export interface Claim {
  lease: Lease;
  release: () => Promise<void>;
}

export async function claimSession(
  sessionId: string,
  options: ClaimOptions,
): Promise<Claim | null> {
  const ttl = options.ttlSeconds ?? ORCHESTRATOR_LIMITS.leaseSeconds;
  const lease = await options.leases.acquire(leaseResource(sessionId), ttl);

  if (lease === null) {
    return null;
  }

  return {
    lease,
    release: async (): Promise<void> => {
      try {
        await options.leases.release(lease);
      } catch (error) {
        options.logger.warn(
          { sessionId, error: String(error) },
          'a session lease could not be released, it will expire on its own',
        );
      }
    },
  };
}

export async function heldBySomebody(leases: SessionLeases, sessionId: string): Promise<boolean> {
  return (await leases.holderOf(leaseResource(sessionId))) !== null;
}
