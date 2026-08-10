import {
  ERROR_CODES,
  ApiErrorBodySchema,
  HealthResponseSchema,
  type ApiErrorBody,
} from '@nimbus/contracts';
import type { Express } from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { createApp } from '../app.js';
import { ERROR_STATUS } from './api-error.js';
import { createTestLogger, productionConfig, testConfig } from './http.fixtures.js';
import { translateError } from './middleware/error-handler.js';

function buildApp(overrides: Record<string, string | undefined> = {}): Express {
  const { logger } = createTestLogger();
  return createApp({ config: testConfig(overrides), logger });
}

function errorBody(body: unknown): ApiErrorBody {
  return ApiErrorBodySchema.parse(body);
}

describe('health', () => {
  it('reports the process as alive without mentioning any dependency', async () => {
    const response = await request(buildApp()).get('/health');
    const body = HealthResponseSchema.parse(response.body);

    expect(response.status).toBe(200);
    expect(body.status).toBe('ok');
    expect(body.uptimeSeconds).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(body)).not.toContain('mongo');
  });
});

describe('readiness', () => {
  it('is ready when every dependency answers', async () => {
    const { logger } = createTestLogger();
    const app = createApp({
      config: testConfig(),
      logger,
      checks: [{ name: 'mongodb', run: async () => Promise.resolve() }],
    });

    const response = await request(app).get('/ready');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ready' });
  });

  it('returns 503 and no detail when a dependency fails', async () => {
    const { logger, lines } = createTestLogger();
    const app = createApp({
      config: testConfig(),
      logger,
      checks: [
        {
          name: 'mongodb',
          run: () => Promise.reject(new Error('connection refused at db-internal:27017')),
        },
      ],
    });

    const response = await request(app).get('/ready');

    expect(response.status).toBe(503);
    expect(response.body).toEqual({ status: 'not_ready' });
    expect(JSON.stringify(response.body)).not.toContain('db-internal');
    expect(JSON.stringify(lines)).toContain('mongodb');
  });

  it('does not hang when a dependency never answers', async () => {
    const { logger } = createTestLogger();
    const app = createApp({
      config: testConfig(),
      logger,
      checks: [{ name: 'stuck', run: () => new Promise<void>(() => undefined) }],
    });

    const response = await request(app).get('/ready').timeout(5_000);

    expect(response.status).toBe(503);
  });
});

describe('not found', () => {
  it('answers with the contract error shape rather than an html page', async () => {
    const response = await request(buildApp()).get('/definitely-not-a-route');

    expect(response.status).toBe(404);
    expect(response.headers['content-type']).toContain('application/json');
    expect(() => errorBody(response.body)).not.toThrow();
    expect(errorBody(response.body).error.code).toBe('NOT_FOUND');
  });
});

describe('request id', () => {
  it('returns an id on every response', async () => {
    const response = await request(buildApp()).get('/health');

    expect(response.headers['x-request-id']).toMatch(/^req_[0-9A-Za-z_-]{21}$/);
  });

  it('puts the same id in the error body', async () => {
    const response = await request(buildApp()).get('/nope');

    expect(errorBody(response.body).error.requestId).toBe(response.headers['x-request-id']);
  });

  it('gives different requests different ids', async () => {
    const app = buildApp();
    const first = await request(app).get('/health');
    const second = await request(app).get('/health');

    expect(first.headers['x-request-id']).not.toBe(second.headers['x-request-id']);
  });

  it('ignores a client supplied id when no proxy is trusted', async () => {
    const response = await request(buildApp())
      .get('/health')
      .set('X-Request-Id', 'req_aaaaaaaaaaaaaaaaaaaaa');

    expect(response.headers['x-request-id']).not.toBe('req_aaaaaaaaaaaaaaaaaaaaa');
  });
});

describe('body handling', () => {
  it('turns broken json into a validation error, not a crash', async () => {
    const response = await request(buildApp())
      .post('/health')
      .set('Content-Type', 'application/json')
      .send('{"a":');

    expect(response.status).toBe(400);
    expect(errorBody(response.body).error.code).toBe('VALIDATION_FAILED');
  });

  it('rejects a body over the limit', async () => {
    const response = await request(buildApp())
      .post('/health')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ blob: 'x'.repeat(200_000) }));

    expect(response.status).toBe(413);
    expect(errorBody(response.body).error.code).toBe('PAYLOAD_TOO_LARGE');
  });
});

describe('security headers', () => {
  it('sets a content security policy that allows nothing', async () => {
    const response = await request(buildApp()).get('/health');
    const csp = response.headers['content-security-policy'];

    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
  });

  it('sets the usual protective headers', async () => {
    const response = await request(buildApp()).get('/health');

    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['x-frame-options']).toBe('DENY');
    expect(response.headers['referrer-policy']).toBe('no-referrer');
  });

  it('never announces the server technology', async () => {
    const response = await request(buildApp()).get('/health');

    expect(response.headers['x-powered-by']).toBeUndefined();
  });

  it('sets strict transport security only in production', async () => {
    const development = await request(buildApp()).get('/health');
    expect(development.headers['strict-transport-security']).toBeUndefined();

    const { logger } = createTestLogger();
    const production = await request(createApp({ config: productionConfig(), logger })).get(
      '/health',
    );

    expect(production.headers['strict-transport-security']).toContain('max-age=63072000');
    expect(production.headers['strict-transport-security']).toContain('includeSubDomains');
  });

  it('upgrades insecure requests only in production', async () => {
    const { logger } = createTestLogger();
    const production = await request(createApp({ config: productionConfig(), logger })).get(
      '/health',
    );

    expect(production.headers['content-security-policy']).toContain('upgrade-insecure-requests');
    const development = await request(buildApp()).get('/health');
    expect(development.headers['content-security-policy']).not.toContain(
      'upgrade-insecure-requests',
    );
  });

  it('puts headers on error responses too', async () => {
    const response = await request(buildApp()).get('/nope');

    expect(response.status).toBe(404);
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['content-security-policy']).toContain("default-src 'none'");
  });
});

describe('error mapping', () => {
  it('has a status for every code the contracts define', () => {
    for (const code of ERROR_CODES) {
      const status = ERROR_STATUS[code];
      expect(status).toBeGreaterThanOrEqual(400);
      expect(status).toBeLessThanOrEqual(599);
    }
  });

  it('turns an unknown throw into a generic internal error', () => {
    const translated = translateError(new Error('mongodb://admin:hunter2@db:27017 refused'));

    expect(translated.code).toBe('INTERNAL_ERROR');
    expect(translated.status).toBe(500);
    expect(translated.publicMessage).not.toContain('hunter2');
    expect(translated.publicMessage).not.toContain('mongodb');
  });

  it('keeps the original error attached for the logs', () => {
    const original = new Error('internal detail');
    const translated = translateError(original);

    expect(translated.cause).toBe(original);
  });
});
