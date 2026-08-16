import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { ApiClient, CSRF_HEADER, type CsrfSource } from './client.js';
import { ApiError, NetworkError, isApiError, readErrorBody } from './errors.js';

const Shape = z.strictObject({ ok: z.boolean() });

interface Sent {
  url: string;
  init: RequestInit;
}

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') {
    return input;
  }
  return input instanceof URL ? input.href : input.url;
}

function clientWith(
  reply: (sent: Sent) => Response | Promise<Response>,
  token: string | null = 'a-csrf-token',
): { api: ApiClient; sent: Sent[] } {
  const sent: Sent[] = [];
  const csrf: CsrfSource = { token: (): string | null => token };

  const api = new ApiClient({
    baseUrl: 'http://localhost:4000/',
    csrf,
    fetch: async (input, init): Promise<Response> => {
      const one = { url: urlOf(input), init: init ?? {} };
      sent.push(one);
      return reply(one);
    },
  });

  return { api, sent };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('sending a request', () => {
  it('carries the cookie, because the session is one', async () => {
    const held = clientWith(() => json({ ok: true }));

    await held.api.get('/auth/me', Shape);

    expect(held.sent[0]?.init.credentials).toBe('include');
  });

  it('joins the base url without doubling the slash', async () => {
    const held = clientWith(() => json({ ok: true }));

    await held.api.get('/auth/me', Shape);

    expect(held.sent[0]?.url).toBe('http://localhost:4000/auth/me');
  });

  it('sends no csrf token on a read', async () => {
    const held = clientWith(() => json({ ok: true }));

    await held.api.get('/auth/me', Shape);

    expect(new Headers(held.sent[0]?.init.headers).get(CSRF_HEADER)).toBeNull();
  });

  it('sends the csrf token on a write', async () => {
    const held = clientWith(() => json({ ok: true }));

    await held.api.post('/auth/logout', {}, Shape);

    expect(new Headers(held.sent[0]?.init.headers).get(CSRF_HEADER)).toBe('a-csrf-token');
  });

  it('refuses to write at all when there is no csrf token to send', async () => {
    const held = clientWith(() => json({ ok: true }), null);

    await expect(held.api.post('/auth/logout', {}, Shape)).rejects.toThrow(ApiError);
    expect(held.sent).toHaveLength(0);
  });
});

describe('reading a reply', () => {
  it('gives back the parsed body', async () => {
    const held = clientWith(() => json({ ok: true }));

    expect(await held.api.get('/auth/me', Shape)).toStrictEqual({ ok: true });
  });

  it('treats a body that does not match its schema as an error, not a surprise later', async () => {
    const held = clientWith(() => json({ ok: 'yes' }));

    await expect(held.api.get('/auth/me', Shape)).rejects.toThrow(ApiError);
  });

  it('carries the error code and the request id back', async () => {
    const held = clientWith(() =>
      json(
        {
          error: {
            code: 'SESSION_EXPIRED',
            message: 'Sign in again.',
            requestId: 'req_aaaaaaaaaaaaaaaaaaaaa',
          },
        },
        401,
      ),
    );

    try {
      await held.api.get('/auth/me', Shape);
      expect.unreachable();
    } catch (error) {
      expect(isApiError(error, 'SESSION_EXPIRED')).toBe(true);
      expect((error as ApiError).requestId).toBe('req_aaaaaaaaaaaaaaaaaaaaa');
      expect((error as ApiError).signedOut).toBe(true);
    }
  });

  it('does not mistake an ordinary failure for being signed out', async () => {
    const held = clientWith(() =>
      json(
        {
          error: {
            code: 'RATE_LIMITED',
            message: 'Slow down.',
            requestId: 'req_aaaaaaaaaaaaaaaaaaaaa',
          },
        },
        429,
      ),
    );

    await expect(held.api.get('/auth/me', Shape)).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      signedOut: false,
    });
  });

  it('survives an error body that is not the shape it promised', async () => {
    const held = clientWith(() => new Response('<html>gateway</html>', { status: 502 }));

    await expect(held.api.get('/auth/me', Shape)).rejects.toMatchObject({
      code: 'INTERNAL_ERROR',
      status: 502,
    });
  });

  it('tells a network failure apart from a refusal', async () => {
    const held = clientWith(() => {
      throw new TypeError('failed to fetch');
    });

    await expect(held.api.get('/auth/me', Shape)).rejects.toThrow(NetworkError);
  });
});

describe('reading an error body directly', () => {
  it('keeps the code the server chose', () => {
    const error = readErrorBody(409, {
      error: {
        code: 'ACTIVE_SESSION_EXISTS',
        message: 'One at a time.',
        requestId: 'req_aaaaaaaaaaaaaaaaaaaaa',
      },
    });

    expect(error.code).toBe('ACTIVE_SESSION_EXISTS');
    expect(error.status).toBe(409);
  });

  it('falls back rather than throwing on nonsense', () => {
    expect(readErrorBody(500, undefined).code).toBe('INTERNAL_ERROR');
  });
});
