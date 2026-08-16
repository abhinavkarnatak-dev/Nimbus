import type { SessionDocument } from '../db/models/session.js';
import type { Logger } from '../logging/logger.js';
import type { Lease } from '../redis/lease.js';
import type { RunOutcome, SessionRecords } from '../sessions/repository.js';
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
  cancellations?: CancelWatcher;
  now?: () => Date;
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

  readonly #now: () => Date;

  readonly #cancellations: CancelWatcher | null;

  readonly #running = new Map<string, AbortController>();

  #timer: NodeJS.Timeout | null = null;

  #stopping = false;

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
    this.#cancellations = options.cancellations ?? null;
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

  async stop(): Promise<void> {
    this.#stopping = true;

    if (this.#timer !== null) {
      clearInterval(this.#timer);
      this.#timer = null;
    }

    await this.#cancellations?.stop();
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

    const recovering = session.status !== 'queued';

    if (recovering && !(await this.#mayRecover(session))) {
      await claim.release();
      return false;
    }

    const controller = new AbortController();

    this.#running.set(session.sessionId, controller);
    void this.#work(session, claim.lease, claim.release, recovering, controller);
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

    await this.#records.recordOutcome(
      session.sessionId,
      { status: 'failed', failure: failureOf('INTERNAL_ERROR'), currentActivity: null },
      this.#now(),
    );
    return false;
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
    } finally {
      await release();
      this.#running.delete(session.sessionId);
    }
  }
}
