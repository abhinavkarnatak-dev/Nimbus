import { describe, expect, it } from 'vitest';

import { RequestIdSchema } from '@nimbus/contracts';

import {
  attachToRequestContext,
  getRequestContext,
  getRequestId,
  newRequestId,
  runWithRequestContext,
} from './request-context.js';

describe('request ids', () => {
  it('produces ids matching the shared contract', () => {
    const id = newRequestId();

    expect(RequestIdSchema.safeParse(id).success).toBe(true);
    expect(id.startsWith('req_')).toBe(true);
  });

  it('produces a different id every time', () => {
    const ids = new Set(Array.from({ length: 1000 }, () => newRequestId()));

    expect(ids.size).toBe(1000);
  });
});

describe('request context', () => {
  it('is empty outside a request', () => {
    expect(getRequestContext()).toBeUndefined();
    expect(getRequestId()).toBeUndefined();
  });

  it('is readable anywhere inside a request without being passed down', () => {
    const requestId = newRequestId();

    const deeplyNested = (): string | undefined => getRequestId();
    const middle = (): string | undefined => deeplyNested();

    runWithRequestContext({ requestId }, () => {
      expect(middle()).toBe(requestId);
    });
  });

  it('survives awaits', async () => {
    const requestId = newRequestId();

    await runWithRequestContext({ requestId }, async () => {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(getRequestId()).toBe(requestId);
    });
  });

  it('is cleared once the request finishes', () => {
    runWithRequestContext({ requestId: newRequestId() }, () => {
      expect(getRequestId()).toBeDefined();
    });

    expect(getRequestId()).toBeUndefined();
  });

  it('lets later code attach the user and session once they are known', () => {
    const requestId = newRequestId();

    runWithRequestContext({ requestId }, () => {
      expect(getRequestContext()?.userId).toBeUndefined();

      attachToRequestContext({ userId: 'usr_0123456789abcdefghijk' as never });

      expect(getRequestContext()?.userId).toBe('usr_0123456789abcdefghijk');
      expect(getRequestContext()?.requestId).toBe(requestId);
    });
  });

  it('ignores an attach attempt outside a request instead of throwing', () => {
    expect(() => {
      attachToRequestContext({ userId: 'usr_0123456789abcdefghijk' as never });
    }).not.toThrow();
  });

  it('keeps concurrent requests isolated', async () => {
    const first = newRequestId();
    const second = newRequestId();
    const seen: (string | undefined)[] = [];

    await Promise.all([
      runWithRequestContext({ requestId: first }, async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        seen.push(getRequestId());
      }),
      runWithRequestContext({ requestId: second }, async () => {
        await Promise.resolve();
        seen.push(getRequestId());
      }),
    ]);

    expect(seen).toContain(first);
    expect(seen).toContain(second);
  });
});
