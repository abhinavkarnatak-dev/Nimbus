import type { AuthenticatedUser } from '@nimbus/contracts';
import type { Redis } from 'ioredis';
import type { Db } from 'mongodb';

import { normalizeEmail } from '../db/models/user.js';
import { ApiError } from '../http/api-error.js';
import type { Logger } from '../logging/logger.js';
import { recordAuditEvent } from './audit.js';
import { GoogleIdentityError, type GoogleIdentityProvider } from './google-identity.js';
import { OauthStateStore, type StartedOauthFlow } from './oauth-state.js';
import { AccountDisabledError, findOrCreateUserByEmail } from './user-repository.js';

export interface GoogleServiceOptions {
  redis: Redis;
  db: Db;
  provider: GoogleIdentityProvider;
  logger: Logger;
  stateTtlSeconds?: number;
}

export interface BeginResult extends StartedOauthFlow {
  redirectUrl: string;
}

export interface CompleteInput {
  code: string;
  state: string;
  bindingValue: string;
  ip: string;
}

export interface CompleteResult {
  user: AuthenticatedUser;
  created: boolean;
}

export class GoogleService {
  private readonly db: Db;
  private readonly provider: GoogleIdentityProvider;
  private readonly logger: Logger;
  private readonly states: OauthStateStore;

  constructor(options: GoogleServiceOptions) {
    this.db = options.db;
    this.provider = options.provider;
    this.logger = options.logger;
    this.states = new OauthStateStore(options.redis, {
      logger: options.logger,
      ...(options.stateTtlSeconds === undefined ? {} : { ttlSeconds: options.stateTtlSeconds }),
    });
  }

  async begin(): Promise<BeginResult> {
    const started = await this.states.start();

    return {
      ...started,
      redirectUrl: this.provider.authorizeUrl({
        state: started.state,
        codeChallenge: started.codeChallenge,
      }),
    };
  }

  async complete(input: CompleteInput): Promise<CompleteResult> {
    const payload = await this.states.consume(input.state, input.bindingValue);

    if (payload === null) {
      await this.reject(input.ip, 'state_invalid_or_replayed');
      throw new ApiError('OAUTH_STATE_INVALID', 'That sign in link is no longer valid.');
    }

    let identity;
    try {
      identity = await this.provider.exchange({
        code: input.code,
        codeVerifier: payload.codeVerifier,
      });
    } catch (error) {
      if (error instanceof GoogleIdentityError) {
        await this.reject(input.ip, error.code.toLowerCase());
        throw new ApiError(
          error.code === 'GOOGLE_EMAIL_UNVERIFIED' ? 'FORBIDDEN' : 'OAUTH_STATE_INVALID',
          error.message,
        );
      }
      throw error;
    }

    const email = normalizeEmail(identity.email);

    let outcome;
    try {
      outcome = await findOrCreateUserByEmail(this.db, email, 'google');
    } catch (error) {
      if (error instanceof AccountDisabledError) {
        await this.reject(input.ip, 'account_disabled');
        throw new ApiError('ACCOUNT_DISABLED', 'This account has been disabled.');
      }
      throw error;
    }

    await recordAuditEvent(this.db, this.logger, {
      action: 'auth.google.callback',
      outcome: 'success',
      actorType: 'user',
      userId: outcome.user.userId,
      ip: input.ip,
      metadata: { accountCreated: outcome.created, linked: !outcome.created },
    });

    return outcome;
  }

  private async reject(ip: string, reason: string): Promise<void> {
    await recordAuditEvent(this.db, this.logger, {
      action: 'auth.google.callback',
      outcome: 'denied',
      actorType: 'user',
      ip,
      reason,
    });
  }
}
