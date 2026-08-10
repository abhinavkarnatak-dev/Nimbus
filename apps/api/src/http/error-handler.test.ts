import { ApiErrorBodySchema, type ApiErrorBody } from '@nimbus/contracts';
import express, { type Express } from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { ApiError } from './api-error.js';
import { createTestLogger, type CapturedLog } from './http.fixtures.js';
import { createErrorHandler } from './middleware/error-handler.js';
import { createRequestContextMiddleware } from './middleware/request-context.js';

function errorBody(body: unknown): ApiErrorBody {
  return ApiErrorBodySchema.parse(body);
}

const LEAKY_MESSAGE = 'connect failed for mongodb://admin:hunter2@db-internal:27017/nimbus';

function appThatFails(thrower: express.RequestHandler): { app: Express; lines: CapturedLog[] } {
  const { logger, lines } = createTestLogger();
  const app = express();
  app.use(createRequestContextMiddleware(false));
  app.get('/boom', thrower);
  app.use(createErrorHandler(logger));
  return { app, lines };
}

describe('an unexpected failure', () => {
  it('never sends the internal message to the caller', async () => {
    const { app } = appThatFails(() => {
      throw new Error(LEAKY_MESSAGE);
    });

    const response = await request(app).get('/boom');
    const body = JSON.stringify(response.body);

    expect(response.status).toBe(500);
    expect(errorBody(response.body).error.code).toBe('INTERNAL_ERROR');
    expect(body).not.toContain('hunter2');
    expect(body).not.toContain('db-internal');
    expect(body).not.toContain('mongodb');
  });

  it('sends no stack trace', async () => {
    const { app } = appThatFails(() => {
      throw new Error(LEAKY_MESSAGE);
    });

    const response = await request(app).get('/boom');

    expect(JSON.stringify(response.body)).not.toContain('at ');
    expect(errorBody(response.body).error).not.toHaveProperty('stack');
  });

  it('keeps the full detail in the logs', async () => {
    const { app, lines } = appThatFails(() => {
      throw new Error(LEAKY_MESSAGE);
    });

    await request(app).get('/boom');

    expect(lines.some((line) => line.level === 50)).toBe(true);
    expect(JSON.stringify(lines)).toContain('db-internal');
  });

  it('still matches the contract error shape', async () => {
    const { app } = appThatFails(() => {
      throw new Error('anything');
    });

    const response = await request(app).get('/boom');

    expect(() => errorBody(response.body)).not.toThrow();
  });
});

describe('an error we raised on purpose', () => {
  it('sends our own code, status, and message', async () => {
    const { app } = appThatFails(() => {
      throw new ApiError('ACTIVE_SESSION_EXISTS', 'You already have a session running.');
    });

    const response = await request(app).get('/boom');

    expect(response.status).toBe(409);
    expect(errorBody(response.body).error.code).toBe('ACTIVE_SESSION_EXISTS');
    expect(errorBody(response.body).error.message).toBe('You already have a session running.');
  });

  it('logs a client mistake as a warning rather than an error', async () => {
    const { app, lines } = appThatFails(() => {
      throw new ApiError('VALIDATION_FAILED', 'That is not valid.');
    });

    await request(app).get('/boom');

    expect(lines.some((line) => line.level === 40)).toBe(true);
    expect(lines.some((line) => line.level === 50)).toBe(false);
  });
});

describe('asynchronous failures', () => {
  it('catches a rejected promise from an async handler', async () => {
    const { app } = appThatFails(async () => {
      await Promise.resolve();
      throw new Error(LEAKY_MESSAGE);
    });

    const response = await request(app).get('/boom');

    expect(response.status).toBe(500);
    expect(errorBody(response.body).error.code).toBe('INTERNAL_ERROR');
    expect(JSON.stringify(response.body)).not.toContain('hunter2');
  });

  it('catches a rejected api error from an async handler', async () => {
    const { app } = appThatFails(async () => {
      await Promise.resolve();
      throw new ApiError('RATE_LIMITED', 'Too many requests.');
    });

    const response = await request(app).get('/boom');

    expect(response.status).toBe(429);
    expect(errorBody(response.body).error.code).toBe('RATE_LIMITED');
  });
});
