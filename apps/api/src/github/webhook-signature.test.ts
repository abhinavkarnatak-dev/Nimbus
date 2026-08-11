import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  computeSignature,
  isWellFormedDeliveryId,
  isWellFormedEventName,
  isWellFormedSignature,
  verifySignature,
} from './webhook-signature.js';

const SECRET = 'a-long-random-webhook-secret-value';
const BODY = Buffer.from('{"action":"suspend","installation":{"id":152879739}}', 'utf8');

function sign(secret: string, body: Buffer): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

describe('computing a webhook signature', () => {
  it('matches an independently computed hmac', () => {
    expect(computeSignature(SECRET, BODY)).toBe(sign(SECRET, BODY));
  });

  it('produces the documented shape', () => {
    expect(computeSignature(SECRET, BODY)).toMatch(/^sha256=[0-9a-f]{64}$/);
  });
});

describe('verifying a webhook signature', () => {
  it('accepts a signature GitHub would have sent', () => {
    expect(verifySignature(SECRET, BODY, sign(SECRET, BODY))).toBe(true);
  });

  it('refuses a body changed by a single byte', () => {
    const signature = sign(SECRET, BODY);
    const tampered = Buffer.from(BODY.toString('utf8').replace('152879739', '152879730'), 'utf8');

    expect(verifySignature(SECRET, tampered, signature)).toBe(false);
  });

  it('refuses a signature made with a different secret', () => {
    expect(verifySignature(SECRET, BODY, sign('another-secret-entirely', BODY))).toBe(false);
  });

  it('refuses a missing signature', () => {
    expect(verifySignature(SECRET, BODY, '')).toBe(false);
  });

  it('refuses an empty secret so a blank configuration cannot verify anything', () => {
    expect(verifySignature('', BODY, sign('', BODY))).toBe(false);
  });

  it('refuses without throwing when the signature is the wrong length', () => {
    for (const supplied of [
      'sha256=',
      'sha256=abc',
      `sha256=${'a'.repeat(63)}`,
      `sha256=${'a'.repeat(65)}`,
      'a'.repeat(64),
    ]) {
      expect(() => verifySignature(SECRET, BODY, supplied)).not.toThrow();
      expect(verifySignature(SECRET, BODY, supplied)).toBe(false);
    }
  });

  it('refuses a sha1 signature even when it is correct for the body', () => {
    const sha1 = `sha1=${createHmac('sha1', SECRET).update(BODY).digest('hex')}`;

    expect(verifySignature(SECRET, BODY, sha1)).toBe(false);
  });

  it('refuses a signature carrying non hex characters', () => {
    expect(verifySignature(SECRET, BODY, `sha256=${'g'.repeat(64)}`)).toBe(false);
  });

  it('verifies an empty body rather than treating it as a special case', () => {
    const empty = Buffer.alloc(0);

    expect(verifySignature(SECRET, empty, sign(SECRET, empty))).toBe(true);
    expect(verifySignature(SECRET, empty, sign(SECRET, BODY))).toBe(false);
  });

  it('is sensitive to byte level differences that json parsing would erase', () => {
    const spaced = Buffer.from('{"action":  "suspend","installation":{"id":152879739}}', 'utf8');

    expect(verifySignature(SECRET, spaced, sign(SECRET, BODY))).toBe(false);
    expect(verifySignature(SECRET, spaced, sign(SECRET, spaced))).toBe(true);
  });
});

describe('the signature header shape', () => {
  it('accepts what GitHub sends', () => {
    expect(isWellFormedSignature(`sha256=${'0123456789abcdef'.repeat(4)}`)).toBe(true);
  });

  it('refuses anything else', () => {
    for (const value of [
      '',
      'sha256',
      'sha256=',
      `sha1=${'a'.repeat(40)}`,
      `SHA256=${'a'.repeat(64)}`,
      `sha256=${'A'.repeat(64)}`,
      `sha256=${'a'.repeat(64)} `,
      ` sha256=${'a'.repeat(64)}`,
      `sha256=${'a'.repeat(64)}\n`,
    ]) {
      expect(isWellFormedSignature(value)).toBe(false);
    }
  });
});

describe('the delivery id shape', () => {
  it('accepts the uuid GitHub sends', () => {
    expect(isWellFormedDeliveryId('e1b0c2d4-1f2a-4b3c-8d4e-5f6a7b8c9d0e')).toBe(true);
  });

  it('refuses values that would break a redis key', () => {
    for (const value of ['', 'short', 'has space', 'colon:value', 'star*value', 'a'.repeat(65)]) {
      expect(isWellFormedDeliveryId(value)).toBe(false);
    }
  });
});

describe('the event name shape', () => {
  it('accepts the events this feature handles', () => {
    expect(isWellFormedEventName('installation')).toBe(true);
    expect(isWellFormedEventName('installation_repositories')).toBe(true);
  });

  it('refuses anything that is not a plain lowercase event name', () => {
    for (const value of ['', 'Installation', 'install-ation', 'install ation', 'a'.repeat(65)]) {
      expect(isWellFormedEventName(value)).toBe(false);
    }
  });
});
