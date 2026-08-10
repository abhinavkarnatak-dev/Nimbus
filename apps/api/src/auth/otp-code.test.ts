import { describe, expect, it } from 'vitest';

import {
  OTP_DIGITS,
  codeHashesMatch,
  deriveOtpKey,
  generateOtpCode,
  hashEmail,
  hashOtpCode,
  looksLikeOtpCode,
} from './otp-code.js';

const SECRET = 'z'.repeat(48);
const KEY = deriveOtpKey(SECRET);

describe('generating a code', () => {
  it('is always eight digits', () => {
    for (let i = 0; i < 500; i += 1) {
      const code = generateOtpCode();
      expect(code).toHaveLength(OTP_DIGITS);
      expect(code).toMatch(/^[0-9]{8}$/);
    }
  });

  it('keeps leading zeros rather than producing a shorter number', () => {
    const codes = Array.from({ length: 5_000 }, () => generateOtpCode());

    expect(codes.every((code) => code.length === OTP_DIGITS)).toBe(true);
    expect(codes.some((code) => code.startsWith('0'))).toBe(true);
  });

  it('does not repeat itself in any obvious way', () => {
    const codes = new Set(Array.from({ length: 2_000 }, () => generateOtpCode()));

    expect(codes.size).toBeGreaterThan(1_990);
  });

  it('spreads across the whole range rather than clustering', () => {
    const codes = Array.from({ length: 4_000 }, () => Number(generateOtpCode()));
    const half = codes.filter((code) => code < 50_000_000).length;

    expect(half).toBeGreaterThan(1_800);
    expect(half).toBeLessThan(2_200);
  });
});

describe('hashing a code', () => {
  it('produces the same hash for the same inputs', () => {
    const first = hashOtpCode({ key: KEY, requestId: 'req_1', email: 'a@b.com', code: '12345678' });
    const second = hashOtpCode({
      key: KEY,
      requestId: 'req_1',
      email: 'a@b.com',
      code: '12345678',
    });

    expect(first).toBe(second);
  });

  it('never contains the code itself', () => {
    const hash = hashOtpCode({ key: KEY, requestId: 'req_1', email: 'a@b.com', code: '12345678' });

    expect(hash).not.toContain('12345678');
  });

  it('binds the hash to the request, so one code cannot be replayed against another', () => {
    const first = hashOtpCode({ key: KEY, requestId: 'req_1', email: 'a@b.com', code: '12345678' });
    const second = hashOtpCode({
      key: KEY,
      requestId: 'req_2',
      email: 'a@b.com',
      code: '12345678',
    });

    expect(first).not.toBe(second);
  });

  it('binds the hash to the email', () => {
    const first = hashOtpCode({ key: KEY, requestId: 'req_1', email: 'a@b.com', code: '12345678' });
    const second = hashOtpCode({
      key: KEY,
      requestId: 'req_1',
      email: 'c@d.com',
      code: '12345678',
    });

    expect(first).not.toBe(second);
  });

  it('is useless without the server key', () => {
    const other = deriveOtpKey('a different secret entirely');
    const mine = hashOtpCode({ key: KEY, requestId: 'req_1', email: 'a@b.com', code: '12345678' });
    const theirs = hashOtpCode({
      key: other,
      requestId: 'req_1',
      email: 'a@b.com',
      code: '12345678',
    });

    expect(mine).not.toBe(theirs);
  });

  it('cannot be confused by moving a separator between fields', () => {
    const first = hashOtpCode({
      key: KEY,
      requestId: 'req_ab',
      email: 'c@d.com',
      code: '12345678',
    });
    const second = hashOtpCode({
      key: KEY,
      requestId: 'req_a',
      email: 'bc@d.com',
      code: '12345678',
    });

    expect(first).not.toBe(second);
  });
});

describe('deriving the key', () => {
  it('does not simply reuse the session secret', () => {
    expect(KEY.toString('hex')).not.toContain(Buffer.from(SECRET).toString('hex'));
  });

  it('is stable for one secret and different across secrets', () => {
    expect(deriveOtpKey(SECRET).equals(KEY)).toBe(true);
    expect(deriveOtpKey('another secret').equals(KEY)).toBe(false);
  });
});

describe('hashing an email for key names', () => {
  it('is stable and does not contain the address', () => {
    const hash = hashEmail(KEY, 'abhinav@example.com');

    expect(hash).toBe(hashEmail(KEY, 'abhinav@example.com'));
    expect(hash).not.toContain('abhinav');
    expect(hash).not.toContain('example.com');
  });

  it('differs between addresses', () => {
    expect(hashEmail(KEY, 'a@example.com')).not.toBe(hashEmail(KEY, 'b@example.com'));
  });
});

describe('comparing hashes', () => {
  it('accepts an identical hash', () => {
    const hash = hashOtpCode({ key: KEY, requestId: 'req_1', email: 'a@b.com', code: '12345678' });

    expect(codeHashesMatch(hash, hash)).toBe(true);
  });

  it('rejects a different hash', () => {
    const right = hashOtpCode({ key: KEY, requestId: 'req_1', email: 'a@b.com', code: '12345678' });
    const wrong = hashOtpCode({ key: KEY, requestId: 'req_1', email: 'a@b.com', code: '87654321' });

    expect(codeHashesMatch(right, wrong)).toBe(false);
  });

  it('rejects an empty or truncated hash instead of accepting it', () => {
    const hash = hashOtpCode({ key: KEY, requestId: 'req_1', email: 'a@b.com', code: '12345678' });

    expect(codeHashesMatch(hash, '')).toBe(false);
    expect(codeHashesMatch('', '')).toBe(false);
    expect(codeHashesMatch(hash, hash.slice(0, 32))).toBe(false);
  });
});

describe('recognising a code shape', () => {
  it('accepts eight digits', () => {
    expect(looksLikeOtpCode('01234567')).toBe(true);
  });

  it('rejects anything else', () => {
    expect(looksLikeOtpCode('1234567')).toBe(false);
    expect(looksLikeOtpCode('123456789')).toBe(false);
    expect(looksLikeOtpCode('1234567a')).toBe(false);
    expect(looksLikeOtpCode('        ')).toBe(false);
    expect(looksLikeOtpCode('')).toBe(false);
  });
});
