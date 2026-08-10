import { RequestIdSchema, type AuthenticatedUser } from '@nimbus/contracts';
import type { Redis } from 'ioredis';
import type { Db } from 'mongodb';

import type { AppConfig } from '../config/load.js';
import { normalizeEmail } from '../db/models/user.js';
import type { MailService } from '../email/mail-service.js';
import { ApiError } from '../http/api-error.js';
import type { Logger } from '../logging/logger.js';
import { newRequestId } from '../logging/request-context.js';
import { RateLimiter, type RateLimitResult } from '../redis/rate-limit.js';
import { recordAuditEvent } from './audit.js';
import {
  codeHashesMatch,
  deriveOtpKey,
  generateOtpCode,
  hashEmail,
  hashOtpCode,
  looksLikeOtpCode,
} from './otp-code.js';
import { buildOtpPolicies, type OtpPolicies } from './otp-policies.js';
import { OTP_PURPOSE, OtpStore } from './otp-store.js';
import { AccountDisabledError, findOrCreateUserByEmail } from './user-repository.js';

export interface OtpServiceOptions {
  redis: Redis;
  db: Db;
  mail: MailService;
  logger: Logger;
  config: AppConfig;
}

export interface RequestCodeInput {
  email: string;
  ip: string;
}

export interface RequestCodeResult {
  requestId: string;
  expiresInSeconds: number;
  resendAvailableInSeconds: number;
}

export interface VerifyCodeInput {
  requestId: string;
  email: string;
  code: string;
  ip: string;
}

export interface VerifyCodeResult {
  user: AuthenticatedUser;
  created: boolean;
}

function auditableRequestId(value: string): string | null {
  return RequestIdSchema.safeParse(value).success ? value : null;
}

function rateLimited(result: RateLimitResult): ApiError {
  const seconds = Math.max(1, Math.ceil(result.retryAfterMs / 1000));
  return new ApiError(
    'RATE_LIMITED',
    `Too many attempts. Try again in about ${String(seconds)} seconds.`,
  );
}

export class OtpService {
  private readonly db: Db;
  private readonly mail: MailService;
  private readonly logger: Logger;
  private readonly policies: OtpPolicies;
  private readonly store: OtpStore;
  private readonly key: Buffer;
  private readonly requestPerAccount: RateLimiter;
  private readonly requestPerIp: RateLimiter;
  private readonly verifyPerIp: RateLimiter;

  constructor(options: OtpServiceOptions) {
    this.db = options.db;
    this.mail = options.mail;
    this.logger = options.logger;
    this.policies = buildOtpPolicies(options.config);
    this.key = deriveOtpKey(options.config.session.secret);
    this.store = new OtpStore(options.redis, {
      ttlSeconds: this.policies.ttlSeconds,
      logger: options.logger,
    });
    this.requestPerAccount = new RateLimiter(options.redis, this.policies.requestPerAccount);
    this.requestPerIp = new RateLimiter(options.redis, this.policies.requestPerIp);
    this.verifyPerIp = new RateLimiter(options.redis, this.policies.verifyPerIp);
  }

  async requestCode(input: RequestCodeInput): Promise<RequestCodeResult> {
    const email = normalizeEmail(input.email);
    const emailHash = hashEmail(this.key, email);

    const cooling = await this.store.cooldownRemainingSeconds(emailHash);
    if (cooling > 0) {
      throw new ApiError(
        'RATE_LIMITED',
        `A code was already sent. You can ask for another in ${String(cooling)} seconds.`,
      );
    }

    const perAccount = await this.requestPerAccount.consume(emailHash);
    if (!perAccount.allowed) {
      throw rateLimited(perAccount);
    }

    const perIp = await this.requestPerIp.consume(input.ip);
    if (!perIp.allowed) {
      throw rateLimited(perIp);
    }

    await this.store.startCooldown(emailHash, this.policies.resendCooldownSeconds);

    const requestId = newRequestId();
    const code = generateOtpCode();

    await this.store.replaceOutstanding(emailHash, {
      requestId,
      email,
      codeHash: hashOtpCode({ key: this.key, requestId, email, code }),
      purpose: OTP_PURPOSE,
      issuedAt: new Date().toISOString(),
    });

    try {
      await this.mail.sendSignInCode(email, {
        code,
        expiresInMinutes: Math.max(1, Math.round(this.policies.ttlSeconds / 60)),
      });
    } catch (error) {
      await this.store.discard(requestId);
      await this.store.clearActive(emailHash);
      await this.store.clearCooldown(emailHash);

      this.logger.error({ requestId, err: error }, 'Could not send a sign in code');
      await recordAuditEvent(this.db, this.logger, {
        action: 'auth.otp.requested',
        outcome: 'failure',
        actorType: 'user',
        requestId,
        ip: input.ip,
        reason: 'mail_send_failed',
      });

      throw new ApiError(
        'PROVIDER_UNAVAILABLE',
        'We could not send the email just now. Please try again.',
      );
    }

    await recordAuditEvent(this.db, this.logger, {
      action: 'auth.otp.requested',
      outcome: 'success',
      actorType: 'user',
      requestId,
      ip: input.ip,
    });

    return {
      requestId,
      expiresInSeconds: this.policies.ttlSeconds,
      resendAvailableInSeconds: this.policies.resendCooldownSeconds,
    };
  }

  async verifyCode(input: VerifyCodeInput): Promise<VerifyCodeResult> {
    const email = normalizeEmail(input.email);

    const perIp = await this.verifyPerIp.consume(input.ip);
    if (!perIp.allowed) {
      await this.reject(input, 'ip_rate_limited');
      throw rateLimited(perIp);
    }

    if (!looksLikeOtpCode(input.code)) {
      await this.reject(input, 'malformed_code');
      throw new ApiError('OTP_INVALID', 'That code is not correct.');
    }

    const record = await this.store.read(input.requestId);
    if (record === null) {
      await this.reject(input, 'no_outstanding_code');
      throw new ApiError('OTP_EXPIRED', 'That code has expired. Please ask for a new one.');
    }

    if (record.email !== email) {
      await this.reject(input, 'email_mismatch');
      throw new ApiError('OTP_INVALID', 'That code is not correct.');
    }

    const attempts = await this.store.countAttempt(input.requestId);
    if (attempts > this.policies.maxAttempts) {
      await this.store.discard(input.requestId);
      await this.reject(input, 'attempts_exhausted');
      throw new ApiError(
        'OTP_ATTEMPTS_EXCEEDED',
        'Too many wrong codes. Please ask for a new one.',
      );
    }

    const candidate = hashOtpCode({
      key: this.key,
      requestId: record.requestId,
      email,
      code: input.code,
    });

    if (!codeHashesMatch(record.codeHash, candidate)) {
      await this.reject(input, 'wrong_code');
      throw new ApiError('OTP_INVALID', 'That code is not correct.');
    }

    const claimed = await this.store.claim(input.requestId);
    if (!claimed) {
      await this.reject(input, 'already_used');
      throw new ApiError('OTP_INVALID', 'That code is not correct.');
    }

    await this.store.discard(input.requestId);
    await this.store.clearActive(hashEmail(this.key, email));

    let outcome: { user: AuthenticatedUser; created: boolean };
    try {
      outcome = await findOrCreateUserByEmail(this.db, email, 'email_otp');
    } catch (error) {
      if (error instanceof AccountDisabledError) {
        await this.reject(input, 'account_disabled');
        throw new ApiError('ACCOUNT_DISABLED', 'This account has been disabled.');
      }
      throw error;
    }

    await recordAuditEvent(this.db, this.logger, {
      action: 'auth.otp.verified',
      outcome: 'success',
      actorType: 'user',
      userId: outcome.user.userId,
      requestId: input.requestId,
      ip: input.ip,
      metadata: { accountCreated: outcome.created },
    });

    return outcome;
  }

  private async reject(input: VerifyCodeInput, reason: string): Promise<void> {
    await recordAuditEvent(this.db, this.logger, {
      action: 'auth.otp.rejected',
      outcome: 'denied',
      actorType: 'user',
      requestId: auditableRequestId(input.requestId),
      ip: input.ip,
      reason,
    });
  }
}
