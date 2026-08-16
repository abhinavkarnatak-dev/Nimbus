import type { SessionDocument } from '../db/models/session.js';
import { isActiveSessionStatus } from '../db/models/session.js';
import type { Logger } from '../logging/logger.js';
import type { Lease } from '../redis/lease.js';
import type { SessionRecords } from '../sessions/repository.js';
import { leaseResource, type SessionLeases } from './claim.js';

export const LIVENESS_VERDICTS = [
  'live',
  'aborted',
  'cancelled',
  'ended',
  'gone',
  'not_ours',
  'unknown',
] as const;

export type LivenessVerdict = (typeof LIVENESS_VERDICTS)[number];

export type RunLiveness = (where: string) => Promise<LivenessVerdict>;

export const ALWAYS_LIVE: RunLiveness = async () => Promise.resolve('live');

export interface LivenessOptions {
  session: SessionDocument;
  records: SessionRecords;
  leases: SessionLeases;
  lease: Lease;
  signal: AbortSignal;
  logger: Logger;
}

export function stillLive(options: LivenessOptions): RunLiveness {
  return async (where: string): Promise<LivenessVerdict> => {
    const verdict = await judge(options);

    if (verdict !== 'live') {
      options.logger.warn(
        { sessionId: options.session.sessionId, where, verdict },
        'a run stopped short of an external write because it is no longer the live owner',
      );
    }

    return verdict;
  };
}

function isAborted(signal: AbortSignal): boolean {
  return signal.aborted;
}

async function judge(options: LivenessOptions): Promise<LivenessVerdict> {
  if (isAborted(options.signal)) {
    return 'aborted';
  }

  let current: SessionDocument | null;

  try {
    current = await options.records.findById(options.session.sessionId);
  } catch (error) {
    options.logger.error(
      { sessionId: options.session.sessionId, error: String(error) },
      'a session could not be read before an external write, so the write is refused',
    );
    return 'unknown';
  }

  if (current === null) {
    return 'gone';
  }

  if (current.userId !== options.session.userId) {
    return 'not_ours';
  }

  if (current.status === 'cancelled') {
    return 'cancelled';
  }

  if (!isActiveSessionStatus(current.status)) {
    return 'ended';
  }

  let holder: string | null;

  try {
    holder = await options.leases.holderOf(leaseResource(options.session.sessionId));
  } catch (error) {
    options.logger.error(
      { sessionId: options.session.sessionId, error: String(error) },
      'a session lease could not be read before an external write, so the write is refused',
    );
    return 'unknown';
  }

  if (holder !== options.lease.holder) {
    return 'not_ours';
  }

  return isAborted(options.signal) ? 'aborted' : 'live';
}
