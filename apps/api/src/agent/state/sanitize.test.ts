import { describe, expect, it } from 'vitest';

import { REAL_LOOKING_TOKEN, sampleState } from './agent-state.fixtures.js';
import { STATE_LIMITS } from './limits.js';
import {
  assertNoCredentials,
  assertPlainData,
  assertStorable,
  assertWithinSize,
  forbiddenKeyIn,
} from './sanitize.js';

describe('forbiddenKeyIn', () => {
  it.each([
    ['a token', { token: 'x' }],
    ['an access token', { accessToken: 'x' }],
    ['an api key', { apiKey: 'x' }],
    ['a secret', { secret: 'x' }],
    ['a password', { password: 'x' }],
    ['credentials', { credentials: {} }],
    ['an authorization header', { authorization: 'x' }],
    ['a cookie', { cookie: 'x' }],
    ['a private key', { privateKey: 'x' }],
    ['a database handle', { db: {} }],
    ['a raw client', { client: {} }],
    ['a live connection', { connection: {} }],
    ['a socket', { socket: {} }],
    ['a snake case token', { access_token: 'x' }],
    ['a nested one', { sandbox: { inner: { apiKey: 'x' } } }],
    ['one inside an array', { items: [{ ok: 1 }, { token: 'x' }] }],
  ])('refuses %s', (_label, value) => {
    expect(forbiddenKeyIn(value)).not.toBeNull();
  });

  it.each([
    ['ordinary state', sampleState()],
    ['a token count, which is a number not a secret', { tokensUsed: 10, tokenLimit: 100 }],
    ['a tokenizer path', { path: 'src/parser/tokenizer.ts' }],
    ['nothing', {}],
    ['a plain value', 'hello'],
  ])('allows %s', (_label, value) => {
    expect(forbiddenKeyIn(value)).toBeNull();
  });
});

describe('assertPlainData', () => {
  it('allows plain data', () => {
    expect(() => {
      assertPlainData({ a: 1, b: ['x', { c: null }] });
    }).not.toThrow();
  });

  it('refuses a function', () => {
    expect(() => {
      assertPlainData({ run: () => undefined });
    }).toThrow(expect.objectContaining({ code: 'STATE_INVALID' }) as Error);
  });

  it('refuses a class instance, which is how a live handle gets in', () => {
    class Sandbox {
      readonly id = 'sbx_1';
    }

    expect(() => {
      assertPlainData({ sandbox: new Sandbox() });
    }).toThrow(expect.objectContaining({ code: 'STATE_INVALID' }) as Error);
  });

  it('refuses a date, because it is not what comes back from json', () => {
    expect(() => {
      assertPlainData({ at: new Date() });
    }).toThrow(expect.objectContaining({ code: 'STATE_INVALID' }) as Error);
  });

  it('refuses a map', () => {
    expect(() => {
      assertPlainData({ held: new Map() });
    }).toThrow(expect.objectContaining({ code: 'STATE_INVALID' }) as Error);
  });
});

describe('assertNoCredentials', () => {
  it.each([
    ['a github token', REAL_LOOKING_TOKEN],
    ['a groq key', 'gsk_abcdefghijklmnopqrstuvwxyz01234'],
    ['a google key', 'AIzaabcdefghijklmnopqrstuvwxyz0123456789'],
    ['a bearer header', 'Bearer abcdefghijklmnop'],
    ['a private key block', '-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----'],
    ['a mongo connection string', 'mongodb://user:pass@localhost:27017/nimbus'],
    ['a redis connection string', 'redis://127.0.0.1:6390'],
  ])('refuses %s', (_label, text) => {
    expect(() => {
      assertNoCredentials(`{"task":"${text}"}`);
    }).toThrow(expect.objectContaining({ code: 'STATE_HOLDS_CREDENTIAL' }) as Error);
  });

  it('allows ordinary text', () => {
    expect(() => {
      assertNoCredentials('{"task":"the login redirect sends people to the wrong page"}');
    }).not.toThrow();
  });

  it('allows a large state, which the logger helper would have refused', () => {
    const long = JSON.stringify({ notes: 'a'.repeat(20_000) });

    expect(long.length).toBeGreaterThan(4_096);
    expect(() => {
      assertNoCredentials(long);
    }).not.toThrow();
  });
});

describe('assertWithinSize', () => {
  it('allows a state within the cap', () => {
    expect(() => {
      assertWithinSize('a'.repeat(1_000));
    }).not.toThrow();
  });

  it('refuses one past it', () => {
    expect(() => {
      assertWithinSize('a'.repeat(STATE_LIMITS.checkpointMaxBytes + 1));
    }).toThrow(expect.objectContaining({ code: 'STATE_TOO_LARGE' }) as Error);
  });

  it('says how big it was', () => {
    let detail = '';

    try {
      assertWithinSize('a'.repeat(STATE_LIMITS.checkpointMaxBytes + 1));
    } catch (error) {
      detail = (error as { detail: string }).detail;
    }

    expect(detail).toContain('bytes');
  });
});

describe('assertStorable', () => {
  it('returns the bytes for a state it accepts', () => {
    expect(JSON.parse(assertStorable(sampleState()))).toEqual(sampleState());
  });

  it('refuses a forbidden field before it looks at anything else', () => {
    let detail = '';

    try {
      assertStorable({ ...sampleState(), apiKey: 'anything' });
    } catch (error) {
      detail = (error as { detail: string }).detail;
    }

    expect(detail).toBe('apiKey');
  });

  it('refuses a live handle', () => {
    expect(() => assertStorable({ sandbox: new Map() })).toThrow(
      expect.objectContaining({ code: 'STATE_INVALID' }) as Error,
    );
  });

  it('refuses a credential in a value', () => {
    expect(() => assertStorable({ ...sampleState(), task: REAL_LOOKING_TOKEN })).toThrow(
      expect.objectContaining({ code: 'STATE_HOLDS_CREDENTIAL' }) as Error,
    );
  });

  it('refuses something too big', () => {
    expect(() =>
      assertStorable({ notes: 'a'.repeat(STATE_LIMITS.checkpointMaxBytes + 10) }),
    ).toThrow(expect.objectContaining({ code: 'STATE_TOO_LARGE' }) as Error);
  });
});
