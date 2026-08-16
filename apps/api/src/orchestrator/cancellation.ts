import type { Redis } from 'ioredis';
import { z } from 'zod';

import type { Logger } from '../logging/logger.js';

export const CANCEL_CHANNEL = 'nimbus:session-cancel';

export const CancelNoticeSchema = z.strictObject({
  sessionId: z.string().min(1).max(64),
  at: z.string().min(1).max(40),
});

export type CancelNotice = z.infer<typeof CancelNoticeSchema>;

export interface CancelAnnouncer {
  announce(sessionId: string, at: Date): Promise<void>;
}

export interface CancelWatcher {
  watch(handler: (sessionId: string) => void): Promise<void>;
  stop(): Promise<void>;
}

export function readCancelNotice(payload: string): CancelNotice | null {
  let parsed: unknown;

  try {
    parsed = JSON.parse(payload);
  } catch {
    return null;
  }

  const checked = CancelNoticeSchema.safeParse(parsed);
  return checked.success ? checked.data : null;
}

export interface RedisCancelOptions {
  redis: Redis;
  logger: Logger;
}

export class RedisCancelAnnouncer implements CancelAnnouncer {
  readonly #redis: Redis;

  readonly #logger: Logger;

  constructor(options: RedisCancelOptions) {
    this.#redis = options.redis;
    this.#logger = options.logger;
  }

  async announce(sessionId: string, at: Date): Promise<void> {
    const notice: CancelNotice = { sessionId, at: at.toISOString() };

    try {
      await this.#redis.publish(CANCEL_CHANNEL, JSON.stringify(notice));
    } catch (error) {
      this.#logger.warn(
        { sessionId, error: String(error) },
        'a cancellation could not be announced, the worker will notice it at its next liveness check',
      );
    }
  }
}

export class RedisCancelWatcher implements CancelWatcher {
  readonly #redis: Redis;

  readonly #logger: Logger;

  #listening: Redis | null = null;

  constructor(options: RedisCancelOptions) {
    this.#redis = options.redis;
    this.#logger = options.logger;
  }

  async watch(handler: (sessionId: string) => void): Promise<void> {
    if (this.#listening !== null) {
      return;
    }

    const listener = this.#redis.duplicate();
    this.#listening = listener;

    listener.on('message', (channel: string, payload: string) => {
      if (channel !== CANCEL_CHANNEL) {
        return;
      }

      const notice = readCancelNotice(payload);

      if (notice === null) {
        this.#logger.warn({ channel }, 'a cancellation notice could not be read and was ignored');
        return;
      }

      handler(notice.sessionId);
    });

    await listener.subscribe(CANCEL_CHANNEL);
  }

  async stop(): Promise<void> {
    const listener = this.#listening;

    if (listener === null) {
      return;
    }

    this.#listening = null;

    try {
      await listener.unsubscribe(CANCEL_CHANNEL);
    } catch (error) {
      this.#logger.warn({ error: String(error) }, 'a cancellation listener could not unsubscribe');
    }
    listener.disconnect();
  }
}

export class CollectingCancelAnnouncer implements CancelAnnouncer {
  readonly notices: CancelNotice[] = [];

  get announced(): string[] {
    return this.notices.map((notice) => notice.sessionId);
  }

  async announce(sessionId: string, at: Date): Promise<void> {
    this.notices.push({ sessionId, at: at.toISOString() });
    await Promise.resolve();
  }
}
