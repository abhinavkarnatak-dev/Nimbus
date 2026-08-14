import { LlmError, type LlmErrorCode } from './errors.js';
import { LLM_LIMITS } from './limits.js';

export const RETRYABLE_STATUSES: readonly number[] = [408, 409, 429, 500, 502, 503, 504];

export const STATUS_CODES: ReadonlyMap<number, LlmErrorCode> = new Map([
  [400, 'LLM_REQUEST_INVALID'],
  [401, 'LLM_UNAUTHENTICATED'],
  [403, 'LLM_UNAUTHENTICATED'],
  [404, 'LLM_MODEL_UNKNOWN'],
  [408, 'LLM_TIMED_OUT'],
  [413, 'LLM_INPUT_TOO_LARGE'],
  [422, 'LLM_REQUEST_INVALID'],
  [429, 'LLM_RATE_LIMITED'],
]);

export function codeForStatus(status: number): LlmErrorCode {
  const known = STATUS_CODES.get(status);

  if (known !== undefined) {
    return known;
  }

  if (status >= 500) {
    return 'LLM_UNAVAILABLE';
  }
  return 'LLM_FAILED';
}

export function parseRetryAfter(header: string | null, now: number): number | null {
  if (header === null) {
    return null;
  }

  const trimmed = header.trim();

  if (trimmed === '') {
    return null;
  }

  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    return Math.min(Math.round(Number(trimmed) * 1000), LLM_LIMITS.retryAfterMaxMs);
  }

  const when = Date.parse(trimmed);

  if (Number.isNaN(when)) {
    return null;
  }
  return Math.min(Math.max(when - now, 0), LLM_LIMITS.retryAfterMaxMs);
}

export function backoffMs(attempt: number, random: () => number = Math.random): number {
  const ceiling = Math.min(
    LLM_LIMITS.backoffBaseMs * 2 ** Math.max(attempt - 1, 0),
    LLM_LIMITS.backoffMaxMs,
  );
  return Math.round(ceiling * random());
}

export function waitBeforeRetry(
  error: LlmError,
  attempt: number,
  random: () => number = Math.random,
): number {
  if (error.retryAfterMs !== null) {
    return Math.min(error.retryAfterMs, LLM_LIMITS.retryAfterMaxMs);
  }
  return backoffMs(attempt, random);
}

export function shouldRetry(error: unknown, attempt: number, maxAttempts: number): boolean {
  if (attempt >= maxAttempts) {
    return false;
  }
  return error instanceof LlmError && error.retryable;
}

export async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);

    function onAbort(): void {
      clearTimeout(timer);
      reject(new LlmError('LLM_CANCELLED', 'That request was cancelled.'));
    }

    if (signal?.aborted === true) {
      onAbort();
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
