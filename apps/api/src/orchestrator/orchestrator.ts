import type { SessionFailure } from '@nimbus/contracts';

import type { SessionDocument } from '../db/models/session.js';
import type { MailService } from '../email/mail-service.js';
import type { EventPublisher } from '../events/publisher.js';
import type { Logger } from '../logging/logger.js';
import type { Lease } from '../redis/lease.js';
import { wasLeftMidRun, type RunOutcome, type SessionRecords } from '../sessions/repository.js';
import type { CancelWatcher } from './cancellation.js';
import { Heartbeat, claimSession, type SessionLeases } from './claim.js';
import { ORCHESTRATOR_LIMITS } from './limits.js';
import { stillLive } from './liveness.js';
import { failureOf } from './outcome.js';
import type { SessionRunner } from './runner.js';

export interface OrchestratorOptions {
  records: SessionRecords;
  leases: SessionLeases;
  runner: SessionRunner;
  logger: Logger;
  leaseSeconds?: number;
  heartbeatMs?: number;
  pollMs?: number;
  claimBatch?: number;
  maxRecoveries?: number;
  runningConcurrently?: number;
  drainMs?: number;
  drainGraceMs?: number;
  drainPollMs?: number;
  cancellations?: CancelWatcher;
  events?: EventPublisher;
  mail?: MailService;
  notifyEmailFor?: (session: SessionDocument) => Promise<string>;
  now?: () => Date;
}

export interface DrainReport {
  finished: number;
  stopped: number;
  abandoned: number;
}

export class Orchestrator {
  readonly #records: SessionRecords;

  readonly #leases: SessionLeases;

  readonly #runner: SessionRunner;

  readonly #logger: Logger;

  readonly #leaseSeconds: number;

  readonly #heartbeatMs: number;

  readonly #pollMs: number;

  readonly #claimBatch: number;

  readonly #maxRecoveries: number;

  readonly #runningConcurrently: number;

  readonly #drainMs: number;

  readonly #drainGraceMs: number;

  readonly #drainPollMs: number;

  readonly #now: () => Date;

  readonly #cancellations: CancelWatcher | null;

  readonly #events: EventPublisher | null;

  readonly #mail: MailService | null;

  readonly #notifyEmailFor: ((session: SessionDocument) => Promise<string>) | null;

  readonly #running = new Map<string, AbortController>();

  readonly #drained = new Set<string>();

  #timer: NodeJS.Timeout | null = null;

  #stopping = false;

  #stopped: Promise<DrainReport> | null = null;

  constructor(options: OrchestratorOptions) {
    this.#records = options.records;
    this.#leases = options.leases;
    this.#runner = options.runner;
    this.#logger = options.logger;
    this.#leaseSeconds = options.leaseSeconds ?? ORCHESTRATOR_LIMITS.leaseSeconds;
    this.#heartbeatMs = options.heartbeatMs ?? ORCHESTRATOR_LIMITS.heartbeatMs;
    this.#pollMs = options.pollMs ?? ORCHESTRATOR_LIMITS.pollMs;
    this.#claimBatch = options.claimBatch ?? ORCHESTRATOR_LIMITS.claimBatch;
    this.#maxRecoveries = options.maxRecoveries ?? ORCHESTRATOR_LIMITS.maxRecoveries;
    this.#runningConcurrently =
      options.runningConcurrently ?? ORCHESTRATOR_LIMITS.runningConcurrently;
    this.#drainMs = options.drainMs ?? ORCHESTRATOR_LIMITS.drainMs;
    this.#drainGraceMs = options.drainGraceMs ?? ORCHESTRATOR_LIMITS.drainGraceMs;
    this.#drainPollMs = options.drainPollMs ?? ORCHESTRATOR_LIMITS.drainPollMs;
    this.#cancellations = options.cancellations ?? null;
    this.#events = options.events ?? null;
    this.#mail = options.mail ?? null;
    this.#notifyEmailFor = options.notifyEmailFor ?? null;
    this.#now = options.now ?? ((): Date => new Date());
  }

  get running(): number {
    return this.#running.size;
  }

  holds(sessionId: string): boolean {
    return this.#running.has(sessionId);
  }

  cancel(sessionId: string): boolean {
    const controller = this.#running.get(sessionId);

    if (controller === undefined || controller.signal.aborted) {
      return false;
    }

    controller.abort();
    this.#logger.info(
      { sessionId },
      'a running session was told to stop because somebody cancelled it',
    );
    return true;
  }

  start(): void {
    if (this.#timer !== null) {
      return;
    }

    this.#timer = setInterval(() => {
      void this.tick();
    }, this.#pollMs);

    this.#timer.unref();

    void this.#cancellations?.watch((sessionId) => {
      this.cancel(sessionId);
    });
  }

  async stop(): Promise<DrainReport> {
    this.#stopped ??= this.#drain();
    return this.#stopped;
  }

  async #drain(): Promise<DrainReport> {
    this.#stopping = true;

    if (this.#timer !== null) {
      clearInterval(this.#timer);
      this.#timer = null;
    }

    const held = this.#running.size;

    if (held > 0) {
      this.#logger.info(
        { running: held, waitingMs: this.#drainMs },
        'this worker is shutting down and is waiting for the sessions it is running',
      );
    }

    await this.#settle(this.#drainMs);

    const stubborn = [...this.#running.keys()];

    for (const sessionId of stubborn) {
      this.#drained.add(sessionId);
      this.#running.get(sessionId)?.abort();
    }

    if (stubborn.length > 0) {
      this.#logger.warn(
        { sessions: stubborn.length, unwindingMs: this.#drainGraceMs },
        'these sessions were told to stop so this worker can shut down, and nothing will be written about them',
      );
    }

    await this.#settle(this.#drainGraceMs);

    const abandoned = this.#running.size;

    if (abandoned > 0) {
      this.#logger.error(
        { sessions: abandoned },
        'these sessions were still running when the shutdown deadline passed, their leases will expire and another worker will pick them up',
      );
    }

    await this.#cancellations?.stop();

    return {
      finished: held - stubborn.length,
      stopped: stubborn.length - abandoned,
      abandoned,
    };
  }

  async #settle(withinMs: number): Promise<void> {
    const deadline = Date.now() + withinMs;

    while (this.#running.size > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, this.#drainPollMs));
    }
  }

  async tick(): Promise<number> {
    if (this.#stopping) {
      return 0;
    }

    const waiting = await this.#records.findClaimable(this.#claimBatch);
    let started = 0;

    for (const session of waiting) {
      if (this.#running.size >= this.#runningConcurrently) {
        break;
      }

      if (this.#running.has(session.sessionId)) {
        continue;
      }

      const taken = await this.take(session);

      if (taken) {
        started += 1;
      }
    }
    return started;
  }

  async take(session: SessionDocument): Promise<boolean> {
    const claim = await claimSession(session.sessionId, {
      leases: this.#leases,
      logger: this.#logger,
      ttlSeconds: this.#leaseSeconds,
    });

    if (claim === null) {
      return false;
    }

    const recovering = wasLeftMidRun(session.status);

    if (recovering && !(await this.#mayRecover(session))) {
      await claim.release();
      return false;
    }

    const started = await this.#records.startRun(session.sessionId, this.#now());

    if (started === null) {
      this.#logger.info(
        { sessionId: session.sessionId },
        'a session ended between being looked at and being taken, so this worker starts nothing',
      );
      await claim.release();
      return false;
    }

    const controller = new AbortController();

    this.#running.set(session.sessionId, controller);
    void this.#work(started, claim.lease, claim.release, recovering, controller);
    return true;
  }

  async #mayRecover(session: SessionDocument): Promise<boolean> {
    const attempts = await this.#records.bumpRetry(session.sessionId, this.#now());

    if (attempts <= this.#maxRecoveries) {
      this.#logger.warn(
        { sessionId: session.sessionId, was: session.status, attempts },
        'a session was left behind by a worker, picking it up again',
      );
      return true;
    }

    this.#logger.error(
      { sessionId: session.sessionId, attempts },
      'a session has been picked up too many times, ending it',
    );

    const failure = failureOf('INTERNAL_ERROR');
    const ended = await this.#records.recordOutcome(
      session.sessionId,
      { status: 'failed', failure, currentActivity: null },
      this.#now(),
    );

    if (ended !== null) {
      await this.#announceGivenUp(session, failure);
    }
    return false;
  }

  async #announceGivenUp(session: SessionDocument, failure: SessionFailure): Promise<void> {
    await this.#safely(session, 'announced', async () => {
      await this.#events?.publish(session.sessionId, session.userId, {
        type: 'session.failed',
        failure,
      });
    });

    await this.#safely(session, 'reported by email', async () => {
      const mail = this.#mail;
      const emailFor = this.#notifyEmailFor;

      if (mail === null || emailFor === null) {
        return;
      }

      await mail.sendSessionEnded(await emailFor(session), {
        repository: `${session.repository.owner}/${session.repository.name}`,
        task: session.task,
        outcome: 'failed',
        reason: failure.message,
      });
    });
  }

  async #safely(session: SessionDocument, what: string, work: () => Promise<void>): Promise<void> {
    try {
      await work();
    } catch (error) {
      this.#logger.warn(
        { sessionId: session.sessionId, error: String(error) },
        `a session that was given up on could not be ${what}, which changes nothing about the session`,
      );
    }
  }

  async #work(
    session: SessionDocument,
    lease: Lease,
    release: () => Promise<void>,
    recovering: boolean,
    controller: AbortController,
  ): Promise<void> {
    const heartbeat = new Heartbeat({
      leases: this.#leases,
      lease,
      logger: this.#logger,
      everyMs: this.#heartbeatMs,
      ttlSeconds: this.#leaseSeconds,
      onLost: () => {
        controller.abort();
      },
    });

    heartbeat.start();
    this.#logger.info(
      { sessionId: session.sessionId, recovering },
      'a worker took a session and started it',
    );

    let outcome: RunOutcome | null;

    try {
      outcome = await this.#runner.run(
        session,
        controller.signal,
        stillLive({
          session,
          records: this.#records,
          leases: this.#leases,
          lease,
          signal: controller.signal,
          logger: this.#logger,
        }),
      );
    } catch (error) {
      this.#logger.error(
        { sessionId: session.sessionId, error: String(error) },
        'a session run threw, which it should not',
      );
      outcome = { status: 'failed', failure: failureOf('INTERNAL_ERROR'), currentActivity: null };
    } finally {
      heartbeat.stop();
    }

    if (outcome === null) {
      this.#logger.info(
        { sessionId: session.sessionId },
        'a run stopped without an outcome of its own, so nothing was written about this session',
      );
      await release();
      this.#running.delete(session.sessionId);
      return;
    }

    if (this.#interrupted(session.sessionId, outcome)) {
      this.#logger.warn(
        { sessionId: session.sessionId },
        'a shutdown interrupted this session rather than anybody cancelling it, so nothing was written and another worker will pick it up',
      );
      await release();
      this.#running.delete(session.sessionId);
      return;
    }

    const stillOurs = await heartbeat.beat();

    if (!stillOurs) {
      this.#logger.warn(
        { sessionId: session.sessionId },
        'a worker lost its lease, so it writes nothing about this session',
      );
      this.#running.delete(session.sessionId);
      return;
    }

    try {
      const written = await this.#records.recordOutcome(session.sessionId, outcome, this.#now());

      if (written === null) {
        this.#logger.info(
          { sessionId: session.sessionId, wanted: outcome.status },
          'a session had already ended, so this outcome was not written',
        );
      }
    } catch (error) {
      this.#logger.error(
        { sessionId: session.sessionId, wanted: outcome.status, error: String(error) },
        'a session outcome could not be written, so another worker will pick this session up',
      );
    } finally {
      await release();
      this.#running.delete(session.sessionId);
    }
  }

  #interrupted(sessionId: string, outcome: RunOutcome): boolean {
    return this.#drained.has(sessionId) && outcome.status === 'cancelled';
  }
}
