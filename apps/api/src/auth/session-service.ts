import { randomBytes } from 'node:crypto';

import {
  SessionContextSchema,
  type AuthenticatedUser,
  type SessionContext,
} from '@nimbus/contracts';
import type { Redis } from 'ioredis';
import type { Db } from 'mongodb';

import type { AppConfig } from '../config/load.js';
import { githubInstallationsCollection } from '../db/models/github-installation.js';
import { ACTIVE_SESSION_STATUSES, sessionsCollection } from '../db/models/session.js';
import { toAuthenticatedUser, usersCollection } from '../db/models/user.js';
import type { Logger } from '../logging/logger.js';
import {
  CSRF_KEY_INFO,
  SESSION_KEY_INFO,
  csrfTokenFor,
  deriveKey,
  hashSessionId,
  tokensMatch,
} from './csrf.js';
import { SessionStore, type SessionRecord } from './session-store.js';

export const SESSION_ID_BYTES = 32;
export const ABSOLUTE_LIFETIME_MULTIPLIER = 24;

export interface SessionServiceOptions {
  redis: Redis;
  db: Db;
  config: AppConfig;
  logger: Logger;
  absoluteLifetimeSeconds?: number;
}

export interface EstablishedSession {
  sessionId: string;
  csrfToken: string;
  expiresInSeconds: number;
}

export interface ActiveSession {
  sessionId: string;
  sessionKey: string;
  csrfToken: string;
  user: AuthenticatedUser;
  record: SessionRecord;
}

export interface SessionReader {
  load(sessionId: string): Promise<ActiveSession | null>;
}

export interface CsrfChecker {
  csrfMatches(session: ActiveSession, candidate: string): boolean;
}

export interface SessionIssuer extends SessionReader, CsrfChecker {
  start(userId: string, replacing?: string): Promise<EstablishedSession>;
  end(sessionId: string): Promise<boolean>;
  context(user: AuthenticatedUser, csrfToken: string): Promise<SessionContext>;
}

export function generateSessionId(): string {
  return randomBytes(SESSION_ID_BYTES).toString('base64url');
}

export class SessionService {
  private readonly db: Db;
  private readonly store: SessionStore;
  private readonly sessionKeyMaterial: Buffer;
  private readonly csrfKeyMaterial: Buffer;
  private readonly idleTtlSeconds: number;
  private readonly absoluteLifetimeSeconds: number;

  constructor(options: SessionServiceOptions) {
    this.db = options.db;
    this.idleTtlSeconds = options.config.session.ttlSeconds;
    this.absoluteLifetimeSeconds =
      options.absoluteLifetimeSeconds ?? this.idleTtlSeconds * ABSOLUTE_LIFETIME_MULTIPLIER;
    this.sessionKeyMaterial = deriveKey(options.config.session.secret, SESSION_KEY_INFO);
    this.csrfKeyMaterial = deriveKey(options.config.session.secret, CSRF_KEY_INFO);
    this.store = new SessionStore(options.redis, {
      idleTtlSeconds: this.idleTtlSeconds,
      logger: options.logger,
    });
  }

  keyFor(sessionId: string): string {
    return hashSessionId(this.sessionKeyMaterial, sessionId);
  }

  csrfTokenForKey(sessionKey: string): string {
    return csrfTokenFor(this.csrfKeyMaterial, sessionKey);
  }

  async start(userId: string, replacing?: string): Promise<EstablishedSession> {
    if (replacing !== undefined && replacing !== '') {
      await this.end(replacing);
    }

    const sessionId = generateSessionId();
    const sessionKey = this.keyFor(sessionId);
    const now = new Date();

    await this.store.save(sessionKey, {
      userId,
      createdAt: now.toISOString(),
      absoluteExpiresAt: new Date(
        now.getTime() + this.absoluteLifetimeSeconds * 1000,
      ).toISOString(),
    });

    return {
      sessionId,
      csrfToken: this.csrfTokenForKey(sessionKey),
      expiresInSeconds: this.idleTtlSeconds,
    };
  }

  async load(sessionId: string): Promise<ActiveSession | null> {
    if (sessionId === '') {
      return null;
    }

    const sessionKey = this.keyFor(sessionId);
    const record = await this.store.read(sessionKey);
    if (record === null) {
      return null;
    }

    if (new Date(record.absoluteExpiresAt).getTime() <= Date.now()) {
      await this.store.remove(sessionKey, record.userId);
      return null;
    }

    const document = await usersCollection(this.db).findOne({ userId: record.userId });
    if (document === null) {
      await this.store.remove(sessionKey, record.userId);
      return null;
    }

    if (document.disabledAt !== undefined) {
      await this.store.removeAllForUser(record.userId);
      return null;
    }

    await this.store.refresh(sessionKey);

    return {
      sessionId,
      sessionKey,
      csrfToken: this.csrfTokenForKey(sessionKey),
      record,
      user: toAuthenticatedUser(document),
    };
  }

  csrfMatches(session: ActiveSession, candidate: string): boolean {
    return tokensMatch(session.csrfToken, candidate);
  }

  async end(sessionId: string): Promise<boolean> {
    const sessionKey = this.keyFor(sessionId);
    const record = await this.store.read(sessionKey);

    return this.store.remove(sessionKey, record?.userId);
  }

  async endAllForUser(userId: string): Promise<number> {
    return this.store.removeAllForUser(userId);
  }

  async countForUser(userId: string): Promise<number> {
    return this.store.countForUser(userId);
  }

  async context(user: AuthenticatedUser, csrfToken: string): Promise<SessionContext> {
    const [installation, activeSession] = await Promise.all([
      githubInstallationsCollection(this.db).findOne({ userId: user.userId, status: 'active' }),
      sessionsCollection(this.db).findOne({
        userId: user.userId,
        status: { $in: [...ACTIVE_SESSION_STATUSES] },
      }),
    ]);

    return SessionContextSchema.parse({
      user,
      csrfToken,
      hasActiveInstallation: installation !== null,
      hasActiveSession: activeSession !== null,
    });
  }
}
