import type { AppConfig } from '../config/load.js';
import type { RateLimitPolicy } from '../redis/rate-limit.js';

export const RESEND_COOLDOWN_SECONDS = 60;
export const IP_REQUEST_MULTIPLIER = 4;
export const IP_VERIFY_MULTIPLIER = 10;
export const ONE_HOUR_SECONDS = 3_600;

export interface OtpPolicies {
  ttlSeconds: number;
  maxAttempts: number;
  resendCooldownSeconds: number;
  requestPerAccount: RateLimitPolicy;
  requestPerIp: RateLimitPolicy;
  verifyPerIp: RateLimitPolicy;
}

export function buildOtpPolicies(config: AppConfig): OtpPolicies {
  const perHour = config.otp.requestLimitPerHour;

  return {
    ttlSeconds: config.otp.ttlSeconds,
    maxAttempts: config.otp.maxAttempts,
    resendCooldownSeconds: RESEND_COOLDOWN_SECONDS,
    requestPerAccount: {
      name: 'otp-request-account',
      capacity: perHour,
      refillWindowSeconds: ONE_HOUR_SECONDS,
    },
    requestPerIp: {
      name: 'otp-request-ip',
      capacity: perHour * IP_REQUEST_MULTIPLIER,
      refillWindowSeconds: ONE_HOUR_SECONDS,
    },
    verifyPerIp: {
      name: 'otp-verify-ip',
      capacity: config.otp.maxAttempts * IP_VERIFY_MULTIPLIER,
      refillWindowSeconds: ONE_HOUR_SECONDS,
    },
  };
}
