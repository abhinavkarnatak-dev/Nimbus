import express, { type Express } from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { createCorsMiddleware } from './middleware/cors.js';

const ALLOWED = 'http://localhost:5173';

function appWithCors(): Express {
  const app = express();
  app.use(createCorsMiddleware(ALLOWED));
  app.get('/thing', (_request, response) => {
    response.json({ ok: true });
  });
  app.post('/thing', (_request, response) => {
    response.json({ ok: true });
  });
  return app;
}

describe('origins that must be allowed', () => {
  it('allows the exact configured origin', async () => {
    const response = await request(appWithCors()).get('/thing').set('Origin', ALLOWED);

    expect(response.status).toBe(200);
    expect(response.headers['access-control-allow-origin']).toBe(ALLOWED);
    expect(response.headers['access-control-allow-credentials']).toBe('true');
  });

  it('allows a request with no Origin header, which is not a browser cross site call', async () => {
    const response = await request(appWithCors()).get('/thing');

    expect(response.status).toBe(200);
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('origins that must be refused', () => {
  const rejected = [
    ['a different port', 'http://localhost:5174'],
    ['a different scheme', 'https://localhost:5173'],
    ['a suffix of the allowed origin', 'http://localhost:5173.evil.com'],
    ['a prefix match attempt', 'http://localhost:51730'],
    ['an unrelated site', 'http://evil.com'],
    ['the null origin', 'null'],
    ['the allowed origin with a trailing slash', 'http://localhost:5173/'],
    ['the allowed origin with different case host', 'http://LOCALHOST:5173'],
  ] as const;

  for (const [label, origin] of rejected) {
    it(`never sends an allow header for ${label}`, async () => {
      const response = await request(appWithCors()).get('/thing').set('Origin', origin);

      expect(response.headers['access-control-allow-origin']).toBeUndefined();
      expect(response.headers['access-control-allow-credentials']).toBeUndefined();
    });
  }
});

describe('preflight', () => {
  it('answers a preflight from the allowed origin', async () => {
    const response = await request(appWithCors())
      .options('/thing')
      .set('Origin', ALLOWED)
      .set('Access-Control-Request-Method', 'POST');

    expect(response.status).toBe(204);
    expect(response.headers['access-control-allow-origin']).toBe(ALLOWED);
    expect(response.headers['access-control-allow-methods']).toContain('POST');
    expect(response.headers['access-control-allow-headers']).toContain('X-CSRF-Token');
    expect(response.headers['access-control-max-age']).toBe('600');
  });

  it('refuses a preflight from a wrong origin without leaking an allow header', async () => {
    const response = await request(appWithCors())
      .options('/thing')
      .set('Origin', 'http://evil.com')
      .set('Access-Control-Request-Method', 'POST');

    expect(response.status).toBe(403);
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('caching correctness', () => {
  it('always sets Vary Origin so a cache cannot reuse an allowed reply for another site', async () => {
    const allowed = await request(appWithCors()).get('/thing').set('Origin', ALLOWED);
    const refused = await request(appWithCors()).get('/thing').set('Origin', 'http://evil.com');
    const none = await request(appWithCors()).get('/thing');

    expect(allowed.headers['vary']).toContain('Origin');
    expect(refused.headers['vary']).toContain('Origin');
    expect(none.headers['vary']).toContain('Origin');
  });
});
