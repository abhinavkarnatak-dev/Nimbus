import { describe, expect, it } from 'vitest';

import { ApiErrorBodySchema, ERROR_CODES, ErrorCodeSchema } from './errors.js';
import { LIMITS } from './limits.js';
import { VALID_REQUEST_ID } from './session.fixtures.js';

const validBody = () => ({
  error: {
    code: 'VALIDATION_FAILED' as const,
    message: 'The task description is too short',
    requestId: VALID_REQUEST_ID,
  },
});

describe('error envelope', () => {
  it('accepts a well formed error body', () => {
    expect(ApiErrorBodySchema.parse(validBody())).toEqual(validBody());
  });

  it('rejects an unknown error code', () => {
    const body = validBody();
    expect(ApiErrorBodySchema.safeParse({ error: { ...body.error, code: 'TEAPOT' } }).success).toBe(
      false,
    );
  });

  it('rejects unknown keys at both levels', () => {
    expect(
      ApiErrorBodySchema.safeParse({ ...validBody(), stack: 'Error: at line 1' }).success,
    ).toBe(false);
    const body = validBody();
    expect(
      ApiErrorBodySchema.safeParse({ error: { ...body.error, internalDetail: 'db timeout' } })
        .success,
    ).toBe(false);
  });

  it('rejects an oversized message', () => {
    const body = validBody();
    expect(
      ApiErrorBodySchema.safeParse({
        error: { ...body.error, message: 'x'.repeat(LIMITS.errorMessageMaxChars + 1) },
      }).success,
    ).toBe(false);
  });

  it('rejects an empty message and a missing request id', () => {
    const body = validBody();
    expect(ApiErrorBodySchema.safeParse({ error: { ...body.error, message: '' } }).success).toBe(
      false,
    );
    expect(
      ApiErrorBodySchema.safeParse({
        error: { code: body.error.code, message: body.error.message },
      }).success,
    ).toBe(false);
  });
});

describe('error code catalogue', () => {
  it('exposes every code through the schema', () => {
    for (const code of ERROR_CODES) {
      expect(ErrorCodeSchema.safeParse(code).success).toBe(true);
    }
  });

  it('contains no duplicates', () => {
    expect(new Set(ERROR_CODES).size).toBe(ERROR_CODES.length);
  });
});
