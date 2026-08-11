import { createHmac, timingSafeEqual } from 'node:crypto';

export const SIGNATURE_HEADER = 'x-hub-signature-256';
export const LEGACY_SIGNATURE_HEADER = 'x-hub-signature';
export const EVENT_HEADER = 'x-github-event';
export const DELIVERY_HEADER = 'x-github-delivery';
export const SIGNATURE_PREFIX = 'sha256=';

const SIGNATURE_PATTERN = /^sha256=[0-9a-f]{64}$/;
const DELIVERY_PATTERN = /^[0-9A-Za-z][0-9A-Za-z-]{7,63}$/;
const EVENT_PATTERN = /^[a-z][a-z_]{0,63}$/;

export function computeSignature(secret: string, body: Buffer): string {
  return `${SIGNATURE_PREFIX}${createHmac('sha256', secret).update(body).digest('hex')}`;
}

export function isWellFormedSignature(value: string): boolean {
  return SIGNATURE_PATTERN.test(value);
}

export function isWellFormedDeliveryId(value: string): boolean {
  return DELIVERY_PATTERN.test(value);
}

export function isWellFormedEventName(value: string): boolean {
  return EVENT_PATTERN.test(value);
}

export function verifySignature(secret: string, body: Buffer, supplied: string): boolean {
  if (secret === '' || !isWellFormedSignature(supplied)) {
    return false;
  }

  const expected = Buffer.from(computeSignature(secret, body), 'utf8');
  const actual = Buffer.from(supplied, 'utf8');

  if (expected.length !== actual.length) {
    return false;
  }

  return timingSafeEqual(expected, actual);
}
