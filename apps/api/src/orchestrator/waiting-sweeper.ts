import type { FailureCode } from '@nimbus/contracts';

import type { SessionDocument } from '../db/models/session.js';
import type { MailService } from '../email/mail-service.js';
import type { EventPublisher } from '../events/publisher.js';
import { InFlight } from '../lib/in-flight.js';
import type { Logger } from '../logging/logger.js';
import type { SessionRecords } from '../sessions/repository.js';
import { WAIT_LIMITS, type WaitLimits } from './limits.js';
import { failureOf } from './outcome.js';

export const WAIT_SWEEP_RESOURCE = 'session-wait-sweep';

export type WaitKind = 'clarification' | 'approval' | 'unknown';

export function waitKindOf(session: SessionDocument): WaitKind {
  if (session.clarificationQuestion !== null && session.clarificationAnswer === null) {
    return 'clarification';
  }

  if (session.approvals.some((one) => one.status === 'pending')) {
    return 'approval';
  }
  return 'unknown';
}

export function waitedMs(session: SessionDocument, now: Date): number | null {
  const since = session.waitingSince;
  return since === null ? null : now.getTime() - since.getTime();
}

export function timedOut(
  session: SessionDocument,
  now: Date,
  limits: WaitLimits = WAIT_LIMITS,
): FailureCode | null {
  const waited = waitedMs(session, now);

  if (waited === null) {
    return null;
  }

  const kind = waitKindOf(session);

  if (kind === 'approval') {
    return waited >= limits.approvalMs ? 'APPROVAL_TIMEOUT' : null;
  }

  if (kind === 'clarification') {
    return waited >= limits.clarificationMs ? 'CLARIFICATION_TIMEOUT' : null;
  }
  return waited >= limits.clarificationMs ? 'INTERNAL_ERROR' : null;
}

export interface WaitingSweeperOptions {
  records: SessionRecords;
  logger: Logger;
  events?: EventPublisher;
  mail?: MailService;
  notifyEmailFor?: (session: SessionDocument) => Promise<string>;
  withLock?: <T>(resource: string, run: () => Promise<T>) => Promise<T | null>;
  limits?: Partial<WaitLimits>;
  now?: () => Date;
}

export class WaitingSessionSweeper {
  readonly #options: WaitingSweeperOptions;

  readonly #limits: WaitLimits;

  readonly #now: () => Date;

  readonly #inFlight = new InFlight();

  #timer: NodeJS.Timeout | null = null;

  constructor(options: WaitingSweeperOptions) {
    this.#options = options;
    this.#limits = { ...WAIT_LIMITS, ...options.limits };
    this.#now = options.now ?? ((): Date => new Date());
  }

  start(): void {
    if (this.#timer !== null) {
      return;
    }

    this.#timer = setInterval(() => {
      void this.sweep();
    }, this.#limits.sweepIntervalMs);

    this.#timer.unref();
  }

  async stop(): Promise<void> {
    if (this.#timer !== null) {
      clearInterval(this.#timer);
      this.#timer = null;
    }

    await this.#inFlight.settle();
  }

  async sweep(): Promise<string[] | null> {
    return this.#inFlight.run(async () => {
      try {
        const withLock = this.#options.withLock;

        if (withLock === undefined) {
          return await this.sweepOnce();
        }
        return await withLock(WAIT_SWEEP_RESOURCE, () => this.sweepOnce());
      } catch (error) {
        this.#options.logger.error(
          { error: String(error) },
          'a sweep of waiting sessions failed, the next one tries again',
        );
        return null;
      }
    });
  }

  async sweepOnce(): Promise<string[]> {
    const now = this.#now();
    const shortest = Math.min(this.#limits.clarificationMs, this.#limits.approvalMs);
    const cutoff = new Date(now.getTime() - shortest);

    const waiting = await this.#options.records.findWaitingSince(cutoff, this.#limits.sweepBatch);
    const ended: string[] = [];

    for (const session of waiting) {
      const code = timedOut(session, now, this.#limits);

      if (code === null) {
        continue;
      }

      if (await this.#end(session, code, now)) {
        ended.push(session.sessionId);
      }
    }

    return ended;
  }

  async #end(session: SessionDocument, code: FailureCode, now: Date): Promise<boolean> {
    const failure = failureOf(code);

    const written = await this.#options.records.recordOutcome(
      session.sessionId,
      { status: 'failed', failure, currentActivity: null },
      now,
    );

    if (written === null) {
      return false;
    }

    this.#options.logger.info(
      {
        sessionId: session.sessionId,
        code,
        waitedMs: waitedMs(session, now),
        kind: waitKindOf(session),
      },
      'a session was waiting for a person for too long and was ended',
    );

    await this.#say(session, failure);
    await this.#mailEnded(session, failure.message);
    return true;
  }

  async #say(session: SessionDocument, failure: ReturnType<typeof failureOf>): Promise<void> {
    if (this.#options.events === undefined) {
      return;
    }

    try {
      await this.#options.events.publish(session.sessionId, session.userId, {
        type: 'session.failed',
        failure,
      });
    } catch (error) {
      this.#options.logger.warn(
        { sessionId: session.sessionId, error: String(error) },
        'a timed out session could not be announced, it is ended either way',
      );
    }
  }

  async #mailEnded(session: SessionDocument, reason: string): Promise<void> {
    const mail = this.#options.mail;
    const notifyEmailFor = this.#options.notifyEmailFor;

    if (mail === undefined || notifyEmailFor === undefined) {
      return;
    }

    try {
      await mail.sendSessionEnded(await notifyEmailFor(session), {
        repository: `${session.repository.owner}/${session.repository.name}`,
        task: session.task,
        outcome: 'failed',
        reason,
      });
    } catch (error) {
      this.#options.logger.warn(
        { sessionId: session.sessionId, error: String(error) },
        'a timed out session could not be reported by email, which changes nothing about the session',
      );
    }
  }
}
