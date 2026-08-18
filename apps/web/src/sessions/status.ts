import type { SessionStatus } from '@nimbus/contracts';

export type StatusTone = 'running' | 'waiting' | 'done' | 'failed' | 'quiet' | 'merged';

const TONES: Readonly<Record<SessionStatus, StatusTone>> = {
  ready: 'quiet',
  queued: 'quiet',
  provisioning: 'running',
  indexing: 'running',
  working: 'running',
  awaiting_user: 'waiting',
  validating: 'running',
  pushing: 'running',
  completed: 'done',
  pr_created: 'done',
  failed: 'failed',
  cancelled: 'quiet',
};

const WORDS: Readonly<Record<SessionStatus, string>> = {
  ready: 'Ready',
  queued: 'Queued',
  provisioning: 'Starting a machine',
  indexing: 'Reading the code',
  working: 'Working',
  awaiting_user: 'Waiting for you',
  validating: 'Checking the patch',
  pushing: 'Pushing a branch',
  completed: 'Ready',
  pr_created: 'Pull request opened',
  failed: 'Failed',
  cancelled: 'Ended',
};

export const LIVE_STATUSES: readonly SessionStatus[] = [
  'queued',
  'provisioning',
  'indexing',
  'working',
  'awaiting_user',
  'validating',
  'pushing',
];

export function toneFor(status: SessionStatus): StatusTone {
  return TONES[status];
}

export function statusWords(status: SessionStatus): string {
  return WORDS[status];
}

export function isLive(status: SessionStatus): boolean {
  return LIVE_STATUSES.includes(status);
}

export function whenWords(iso: string, now: number): string {
  const at = Date.parse(iso);

  if (Number.isNaN(at)) {
    return 'unknown';
  }

  const seconds = Math.max(0, Math.round((now - at) / 1_000));

  if (seconds < 60) {
    return 'just now';
  }

  const minutes = Math.floor(seconds / 60);

  if (minutes < 60) {
    return `${String(minutes)}m ago`;
  }

  const hours = Math.floor(minutes / 60);

  if (hours < 24) {
    return `${String(hours)}h ago`;
  }

  const days = Math.floor(hours / 24);
  return days === 1 ? 'yesterday' : `${String(days)}d ago`;
}
