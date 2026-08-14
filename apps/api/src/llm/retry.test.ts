import { describe, expect, it } from 'vitest';

import { LlmError, LLM_ERROR_CODES, RETRYABLE_CODES } from './errors.js';
import { LLM_LIMITS } from './limits.js';
import {
  backoffMs,
  codeForStatus,
  parseRetryAfter,
  shouldRetry,
  sleep,
  waitBeforeRetry,
} from './retry.js';

describe('codeForStatus', () => {
  it.each([
    [400, 'LLM_REQUEST_INVALID'],
    [401, 'LLM_UNAUTHENTICATED'],
    [403, 'LLM_UNAUTHENTICATED'],
    [404, 'LLM_MODEL_UNKNOWN'],
    [408, 'LLM_TIMED_OUT'],
    [413, 'LLM_INPUT_TOO_LARGE'],
    [422, 'LLM_REQUEST_INVALID'],
    [429, 'LLM_RATE_LIMITED'],
    [500, 'LLM_UNAVAILABLE'],
    [502, 'LLM_UNAVAILABLE'],
    [503, 'LLM_UNAVAILABLE'],
    [504, 'LLM_UNAVAILABLE'],
  ])('maps %i', (status, code) => {
    expect(codeForStatus(status)).toBe(code);
  });

  it('falls back for a status it has never seen', () => {
    expect(codeForStatus(418)).toBe('LLM_FAILED');
  });
});

describe('which failures are worth trying again', () => {
  it('retries only the ones that could change', () => {
    expect([...RETRYABLE_CODES].sort()).toEqual([
      'LLM_RATE_LIMITED',
      'LLM_TIMED_OUT',
      'LLM_UNAVAILABLE',
    ]);
  });

  it('never retries a cancelled call', () => {
    expect(new LlmError('LLM_CANCELLED', 'stopped').retryable).toBe(false);
  });

  it('never retries a request the provider called wrong', () => {
    expect(new LlmError('LLM_REQUEST_INVALID', 'no').retryable).toBe(false);
    expect(new LlmError('LLM_UNAUTHENTICATED', 'no').retryable).toBe(false);
  });

  it('never retries a budget refusal', () => {
    expect(new LlmError('LLM_BUDGET_EXCEEDED', 'no').retryable).toBe(false);
  });

  it('gives every code a definite answer', () => {
    for (const code of LLM_ERROR_CODES) {
      expect(typeof new LlmError(code, 'x').retryable).toBe('boolean');
    }
  });
});

describe('shouldRetry', () => {
  it('stops at the attempt limit', () => {
    const error = new LlmError('LLM_UNAVAILABLE', 'busy');
    expect(shouldRetry(error, 2, 3)).toBe(true);
    expect(shouldRetry(error, 3, 3)).toBe(false);
  });

  it('does not retry something that is not an llm error', () => {
    expect(shouldRetry(new Error('who knows'), 1, 3)).toBe(false);
  });
});

describe('parseRetryAfter', () => {
  it('reads a number of seconds', () => {
    expect(parseRetryAfter('3', 0)).toBe(3_000);
  });

  it('reads a fractional number of seconds', () => {
    expect(parseRetryAfter('1.5', 0)).toBe(1_500);
  });

  it('reads a date', () => {
    const now = Date.parse('2026-08-14T12:00:00Z');
    expect(parseRetryAfter('Fri, 14 Aug 2026 12:00:05 GMT', now)).toBe(5_000);
  });

  it('never waits longer than it is allowed to', () => {
    expect(parseRetryAfter('99999', 0)).toBe(LLM_LIMITS.retryAfterMaxMs);
  });

  it('never waits a negative time for a date that has passed', () => {
    const now = Date.parse('2026-08-14T12:00:00Z');
    expect(parseRetryAfter('Fri, 14 Aug 2026 11:00:00 GMT', now)).toBe(0);
  });

  it.each([
    ['nothing', null],
    ['an empty header', ''],
    ['nonsense', 'soon please'],
  ])('ignores %s', (_label, header) => {
    expect(parseRetryAfter(header, 0)).toBeNull();
  });
});

describe('backoffMs', () => {
  it('grows with each attempt', () => {
    expect(backoffMs(1, () => 1)).toBe(LLM_LIMITS.backoffBaseMs);
    expect(backoffMs(2, () => 1)).toBe(LLM_LIMITS.backoffBaseMs * 2);
    expect(backoffMs(3, () => 1)).toBe(LLM_LIMITS.backoffBaseMs * 4);
  });

  it('stops growing at the ceiling', () => {
    expect(backoffMs(20, () => 1)).toBe(LLM_LIMITS.backoffMaxMs);
  });

  it('spreads callers out rather than sending them back together', () => {
    expect(backoffMs(3, () => 0)).toBe(0);
    expect(backoffMs(3, () => 0.5)).toBe(LLM_LIMITS.backoffBaseMs * 2);
  });
});

describe('waitBeforeRetry', () => {
  it('believes the provider over our own formula', () => {
    const error = new LlmError('LLM_RATE_LIMITED', 'slow down', { retryAfterMs: 1_234 });
    expect(waitBeforeRetry(error, 1, () => 1)).toBe(1_234);
  });

  it('backs off when the provider said nothing', () => {
    const error = new LlmError('LLM_UNAVAILABLE', 'busy');
    expect(waitBeforeRetry(error, 2, () => 1)).toBe(LLM_LIMITS.backoffBaseMs * 2);
  });
});

describe('sleep', () => {
  it('returns at once for no wait', async () => {
    await expect(sleep(0)).resolves.toBeUndefined();
  });

  it('gives up straight away when the caller has already cancelled', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(sleep(5_000, controller.signal)).rejects.toThrow(
      expect.objectContaining({ code: 'LLM_CANCELLED' }) as Error,
    );
  });

  it('stops waiting when the caller cancels partway', async () => {
    const controller = new AbortController();
    setTimeout(() => {
      controller.abort();
    }, 10);

    await expect(sleep(5_000, controller.signal)).rejects.toThrow(
      expect.objectContaining({ code: 'LLM_CANCELLED' }) as Error,
    );
  });
});
