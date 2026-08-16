import { InFlight } from '../lib/in-flight.js';
import type { Logger } from '../logging/logger.js';

export const SWEEP_INTERVAL_MS = 900_000;
export const SWEEP_MAX_REMOVALS = 100;
export const SWEEP_RESOURCE = 'attachment-sweep';

export interface ExpiredAttachmentRemover {
  removeExpired(limit: number): Promise<string[]>;
}

export interface AttachmentSweeperOptions {
  attachments: ExpiredAttachmentRemover;
  withLock?: <T>(resource: string, run: () => Promise<T>) => Promise<T | null>;
  logger?: Logger;
  intervalMs?: number;
  maxRemovals?: number;
}

export class AttachmentSweeper {
  private readonly options: AttachmentSweeperOptions;

  private readonly intervalMs: number;

  private readonly maxRemovals: number;

  private readonly inFlight = new InFlight();

  private timer: NodeJS.Timeout | null = null;

  constructor(options: AttachmentSweeperOptions) {
    this.options = options;
    this.intervalMs = options.intervalMs ?? SWEEP_INTERVAL_MS;
    this.maxRemovals = options.maxRemovals ?? SWEEP_MAX_REMOVALS;
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

  async sweep(): Promise<string[] | null> {
    return this.inFlight.run(async () => {
      try {
        const withLock = this.options.withLock;
        if (withLock === undefined) {
          return await this.sweepOnce();
        }
        return await withLock(SWEEP_RESOURCE, () => this.sweepOnce());
      } catch (error) {
        this.options.logger?.error({ err: error }, 'attachment sweep failed');
        return null;
      }
    });
  }

  async sweepOnce(): Promise<string[]> {
    const removed = await this.options.attachments.removeExpired(this.maxRemovals);

    if (removed.length > 0) {
      this.options.logger?.info({ removed: removed.length }, 'unclaimed attachments deleted');
    }

    return removed;
  }
}
