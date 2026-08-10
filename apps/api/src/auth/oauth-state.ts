import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import type { Redis } from 'ioredis';
import { z } from 'zod';

import type { Logger } from '../logging/logger.js';
import { NonceStore } from '../redis/nonce.js';

export const OAUTH_STATE_TTL_SECONDS = 600;
export const CODE_VERIFIER_BYTES = 32;
export const BINDING_BYTES = 32;
export const GOOGLE_STATE_PURPOSE = 'google-sign-in';

export const OAUTH_BINDING_COOKIE = 'nimbus_oauth';
export const SECURE_OAUTH_BINDING_COOKIE = '__Host-nimbus_oauth';

export const OauthStatePayloadSchema = z.strictObject({
  codeVerifier: z.string().min(20),
  bindingHash: z.string().min(1),
  createdAt: z.string().min(1),
});

export type OauthStatePayload = z.infer<typeof OauthStatePayloadSchema>;

export function bindingCookieName(isProduction: boolean): string {
  return isProduction ? SECURE_OAUTH_BINDING_COOKIE : OAUTH_BINDING_COOKIE;
}

export function generateCodeVerifier(): string {
  return randomBytes(CODE_VERIFIER_BYTES).toString('base64url');
}

export function codeChallengeFor(codeVerifier: string): string {
  return createHash('sha256').update(codeVerifier).digest('base64url');
}

export function generateBindingValue(): string {
  return randomBytes(BINDING_BYTES).toString('base64url');
}

export function hashBindingValue(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function bindingMatches(expectedHash: string, candidate: string): boolean {
  if (candidate === '') {
    return false;
  }

  const expected = Buffer.from(expectedHash, 'hex');
  const actual = Buffer.from(hashBindingValue(candidate), 'hex');

  if (expected.length !== actual.length || expected.length === 0) {
    return false;
  }
  return timingSafeEqual(expected, actual);
}

export interface StartedOauthFlow {
  state: string;
  codeVerifier: string;
  codeChallenge: string;
  bindingValue: string;
}

export interface OauthStateStoreOptions {
  ttlSeconds?: number;
  logger?: Logger;
}

export class OauthStateStore {
  private readonly nonces: NonceStore<OauthStatePayload>;
  private readonly ttlSeconds: number;

  constructor(client: Redis, options: OauthStateStoreOptions = {}) {
    this.ttlSeconds = options.ttlSeconds ?? OAUTH_STATE_TTL_SECONDS;
    this.nonces = new NonceStore(client, {
      purpose: GOOGLE_STATE_PURPOSE,
      schema: OauthStatePayloadSchema,
      ttlSeconds: this.ttlSeconds,
      ...(options.logger === undefined ? {} : { logger: options.logger }),
    });
  }

  async start(): Promise<StartedOauthFlow> {
    const codeVerifier = generateCodeVerifier();
    const bindingValue = generateBindingValue();

    const state = await this.nonces.issue({
      codeVerifier,
      bindingHash: hashBindingValue(bindingValue),
      createdAt: new Date().toISOString(),
    });

    return {
      state,
      codeVerifier,
      codeChallenge: codeChallengeFor(codeVerifier),
      bindingValue,
    };
  }

  async consume(state: string, bindingValue: string): Promise<OauthStatePayload | null> {
    if (state === '') {
      return null;
    }

    const payload = await this.nonces.consume(state);
    if (payload === null) {
      return null;
    }

    if (!bindingMatches(payload.bindingHash, bindingValue)) {
      return null;
    }
    return payload;
  }
}
