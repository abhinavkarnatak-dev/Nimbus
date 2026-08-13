import { describe, expect, it } from 'vitest';

import { REDACTED, redactSecrets } from '../logging/redact.js';
import {
  ENTROPY_MIN_LENGTH,
  findNamedSecrets,
  findRandomLookingText,
  looksRandom,
  shannonEntropy,
} from './secrets.js';

const SAMPLES: readonly string[] = [
  'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
  'github_pat_abcdefghijklmnopqrstuvwxyz',
  'AIzaSyA1234567890abcdefghijklmnopqrstuv',
  'gsk_abcdefghijklmnopqrstuvwxyz1234',
  'sk-abcdefghijklmnopqrstuvwx',
  'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.SflKxwRJSMeKKF2QT4fw',
  '-----BEGIN RSA PRIVATE KEY-----abc-----END RSA PRIVATE KEY-----',
  'postgres://user:hunter2pass@db.example.com/app',
];

describe('the two secret finders agree', () => {
  for (const sample of SAMPLES) {
    it(`both the log redactor and the patch scanner spot ${sample.slice(0, 16)}`, () => {
      expect(redactSecrets(sample)).toContain(REDACTED);
      expect(findNamedSecrets([sample])).not.toHaveLength(0);
    });
  }
});

describe('where the patch scanner is stricter than the log redactor', () => {
  it('spots the opening line of a private key on its own', () => {
    const opening = '-----BEGIN RSA PRIVATE KEY-----';

    expect(redactSecrets(opening)).not.toContain(REDACTED);
    expect(findNamedSecrets([opening])[0]?.name).toBe('private_key');
  });
});

describe('findNamedSecrets', () => {
  it('reports which line it was on', () => {
    const hits = findNamedSecrets(['ordinary', 'ghp_abcdefghijklmnopqrstuvwxyz0123456789']);

    expect(hits[0]).toMatchObject({ name: 'github_token', line: 2 });
  });

  it('never returns the value it found', () => {
    const secret = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
    expect(JSON.stringify(findNamedSecrets([secret]))).not.toContain(secret);
  });

  it('spots an aws key', () => {
    expect(findNamedSecrets(['AKIAIOSFODNN7EXAMPLE'])[0]?.name).toBe('aws_access_key');
  });

  it('leaves ordinary code alone', () => {
    const lines = [
      'const total = price * quantity;',
      'import { useState } from "react";',
      'export default function Button() {',
      '# Fix the login redirect',
    ];

    expect(findNamedSecrets(lines)).toHaveLength(0);
  });

  it('leaves a short assignment alone', () => {
    expect(findNamedSecrets(['const token = "abc";'])).toHaveLength(0);
  });
});

describe('shannonEntropy and looksRandom', () => {
  it('gives nothing for an empty string', () => {
    expect(shannonEntropy('')).toBe(0);
  });

  it('gives nothing for one repeated character', () => {
    expect(shannonEntropy('aaaaaaaa')).toBe(0);
  });

  it('rises as the characters vary', () => {
    expect(shannonEntropy('abcdefgh')).toBeGreaterThan(shannonEntropy('aaaaaaab'));
  });

  it('ignores anything shorter than the minimum', () => {
    expect(looksRandom('Zx9Qw3Rt7Yu1Ip4As'.slice(0, ENTROPY_MIN_LENGTH - 1))).toBe(false);
  });

  it('ignores a commit sha, which is only hex', () => {
    expect(looksRandom('a1b2c3d4e5f60718293a4b5c6d7e8f9012345678')).toBe(false);
  });

  it('ignores a long run of digits', () => {
    expect(looksRandom('1'.repeat(40))).toBe(false);
  });

  it('ignores ordinary english', () => {
    expect(looksRandom('the quick brown fox jumps over it')).toBe(false);
  });

  it('spots a mixed random looking value', () => {
    expect(looksRandom('Zx9Qw3Rt7Yu1Ip4As6Df8Gh0Jk2Lm5Nb')).toBe(true);
  });

  it('reports the line a random looking value was on', () => {
    expect(findRandomLookingText(['fine', 'seed = Zx9Qw3Rt7Yu1Ip4As6Df8Gh0Jk2Lm5Nb'])).toEqual([2]);
  });

  it('leaves an import path alone', () => {
    expect(
      findRandomLookingText(['import { thing } from "../../shared/components/button";']),
    ).toEqual([]);
  });
});
