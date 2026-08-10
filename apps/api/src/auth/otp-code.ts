import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';

import { LIMITS } from '@nimbus/contracts';

export const OTP_DIGITS = LIMITS.otpDigits;
export const OTP_KEY_INFO = 'nimbus:otp:v1';

const UPPER_BOUND = 10 ** OTP_DIGITS;

export function generateOtpCode(): string {
  return String(randomInt(0, UPPER_BOUND)).padStart(OTP_DIGITS, '0');
}

export function deriveOtpKey(sessionSecret: string): Buffer {
  return createHmac('sha256', sessionSecret).update(OTP_KEY_INFO).digest();
}

export function hashOtpCode(options: {
  key: Buffer;
  requestId: string;
  email: string;
  code: string;
}): string {
  return createHmac('sha256', options.key)
    .update(options.requestId)
    .update(String.fromCharCode(31))
    .update(options.email)
    .update(String.fromCharCode(31))
    .update(options.code)
    .digest('hex');
}

export function hashEmail(key: Buffer, email: string): string {
  return createHmac('sha256', key).update('email').update(email).digest('hex');
}

export function codeHashesMatch(expected: string, candidate: string): boolean {
  const expectedBytes = Buffer.from(expected, 'hex');
  const candidateBytes = Buffer.from(candidate, 'hex');

  if (expectedBytes.length !== candidateBytes.length || expectedBytes.length === 0) {
    return false;
  }
  return timingSafeEqual(expectedBytes, candidateBytes);
}

export function looksLikeOtpCode(value: string): boolean {
  if (value.length !== OTP_DIGITS) {
    return false;
  }
  for (const character of value) {
    if (character < '0' || character > '9') {
      return false;
    }
  }
  return true;
}
