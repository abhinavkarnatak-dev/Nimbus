import { ApiErrorBodySchema, OtpRequestResponseSchema, type ApiErrorBody } from '@nimbus/contracts';
import type { Express } from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import type { RequestCodeInput, RequestCodeResult } from '../auth/otp-service.js';
import { createApp } from '../app.js';
import { ApiError } from './api-error.js';
import { createTestLogger, testConfig } from './http.fixtures.js';
import { clientIp, createAuthRouter, UNKNOWN_CLIENT_IP } from './routes/auth.js';

const REQUEST_ID = 'req_V1StGXR8Z5jdHi6BmyTab';

interface Stub {
  app: Express;
  calls: RequestCodeInput[];
}

function stubApp(behaviour?: () => never): Stub {
  const calls: RequestCodeInput[] = [];
  const { logger } = createTestLogger();

  const otp = {
    requestCode: async (input: RequestCodeInput): Promise<RequestCodeResult> => {
      calls.push(input);
      behaviour?.();
      await Promise.resolve();
      return { requestId: REQUEST_ID, expiresInSeconds: 600, resendAvailableInSeconds: 60 };
    },
  };

  return {
    app: createApp({
      config: testConfig(),
      logger,
      routers: [createAuthRouter({ otp })],
    }),
    calls,
  };
}

function errorBody(body: unknown): ApiErrorBody {
  return ApiErrorBodySchema.parse(body);
}

describe('POST /auth/otp/request', () => {
  it('accepts a valid address and answers in the contract shape', async () => {
    const { app } = stubApp();

    const response = await request(app)
      .post('/auth/otp/request')
      .send({ email: 'person@example.com' });

    expect(response.status).toBe(202);
    expect(() => OtpRequestResponseSchema.parse(response.body)).not.toThrow();
  });

  it('passes the address and the caller address to the service', async () => {
    const { app, calls } = stubApp();

    await request(app).post('/auth/otp/request').send({ email: 'person@example.com' });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.email).toBe('person@example.com');
    expect(calls[0]?.ip).toBeDefined();
  });

  it('refuses a body that is not an email address', async () => {
    const { app, calls } = stubApp();

    const response = await request(app).post('/auth/otp/request').send({ email: 'not-an-email' });

    expect(response.status).toBe(400);
    expect(errorBody(response.body).error.code).toBe('VALIDATION_FAILED');
    expect(calls).toHaveLength(0);
  });

  it('refuses a body with unknown fields rather than ignoring them', async () => {
    const { app, calls } = stubApp();

    const response = await request(app)
      .post('/auth/otp/request')
      .send({ email: 'person@example.com', role: 'admin' });

    expect(response.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it('refuses a missing body', async () => {
    const { app } = stubApp();

    const response = await request(app).post('/auth/otp/request').send({});

    expect(response.status).toBe(400);
  });

  it('never echoes the submitted address back in an error', async () => {
    const { app } = stubApp();

    const response = await request(app)
      .post('/auth/otp/request')
      .send({ email: 'probe-me@example.com' });

    expect(JSON.stringify(response.body)).not.toContain('probe-me@example.com');
  });

  it('maps a refusal to 429 with a stable code', async () => {
    const { app } = stubApp(() => {
      throw new ApiError('RATE_LIMITED', 'Too many attempts. Try again in about 42 seconds.');
    });

    const response = await request(app)
      .post('/auth/otp/request')
      .send({ email: 'person@example.com' });

    expect(response.status).toBe(429);
    expect(errorBody(response.body).error.code).toBe('RATE_LIMITED');
  });

  it('maps an email outage to 503 without naming the provider', async () => {
    const { app } = stubApp(() => {
      throw new ApiError('PROVIDER_UNAVAILABLE', 'We could not send the email just now.');
    });

    const response = await request(app)
      .post('/auth/otp/request')
      .send({ email: 'person@example.com' });

    expect(response.status).toBe(503);
    expect(JSON.stringify(response.body).toLowerCase()).not.toContain('smtp');
  });

  it('turns an unexpected failure into a generic error', async () => {
    const { app } = stubApp(() => {
      throw new Error('mongodb://admin:hunter2@db:27017 is unreachable');
    });

    const response = await request(app)
      .post('/auth/otp/request')
      .send({ email: 'person@example.com' });

    expect(response.status).toBe(500);
    expect(JSON.stringify(response.body)).not.toContain('hunter2');
  });

  it('is not reachable with the wrong method', async () => {
    const { app } = stubApp();

    const response = await request(app).get('/auth/otp/request');

    expect(response.status).toBe(404);
  });
});

describe('working out the caller address', () => {
  it('falls back to a placeholder rather than an empty string', () => {
    expect(clientIp(undefined)).toBe(UNKNOWN_CLIENT_IP);
    expect(clientIp('')).toBe(UNKNOWN_CLIENT_IP);
    expect(clientIp('203.0.113.10')).toBe('203.0.113.10');
  });
});
