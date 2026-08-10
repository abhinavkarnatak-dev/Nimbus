import { LIMITS } from '@nimbus/contracts';
import type { Collection, Db } from 'mongodb';

import { newPrefixedId } from '../../lib/id.js';
import { redactValue } from '../../logging/redact.js';
import { COLLECTIONS } from '../collections.js';
import {
  OBJECT_ID_PROPERTY,
  daysFromNow,
  publicIdPattern,
  type ModelDefinition,
} from './shared.js';

export const AUDIT_EVENT_ID_PREFIX = 'aud';

export const AUDIT_RETENTION_DAYS = 400;

export const AUDIT_ACTIONS = [
  'auth.otp.requested',
  'auth.otp.verified',
  'auth.otp.rejected',
  'auth.google.callback',
  'auth.login',
  'auth.logout',
  'auth.session.revoked',
  'github.installation.created',
  'github.installation.suspended',
  'github.installation.unsuspended',
  'github.installation.removed',
  'github.repositories.changed',
  'github.token.minted',
  'session.created',
  'session.cancelled',
  'session.failed',
  'policy.denied',
  'approval.requested',
  'approval.decided',
  'sandbox.created',
  'sandbox.destroyed',
  'patch.rejected',
  'branch.pushed',
  'pull_request.created',
  'admin.failure',
] as const;

export const AUDIT_OUTCOMES = ['success', 'failure', 'denied'] as const;

export const AUDIT_ACTOR_TYPES = ['user', 'system', 'webhook'] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];
export type AuditOutcome = (typeof AUDIT_OUTCOMES)[number];
export type AuditActorType = (typeof AUDIT_ACTOR_TYPES)[number];

export interface AuditEventDocument {
  auditEventId: string;
  action: AuditAction;
  outcome: AuditOutcome;
  actorType: AuditActorType;
  userId: string | null;
  sessionId: string | null;
  installationRecordId: string | null;
  repositoryId: number | null;
  requestId: string | null;
  ip: string | null;
  reason: string | null;
  metadata: Record<string, unknown>;
  createdAt: Date;
  expiresAt: Date;
}

export interface AuditEventInput {
  action: AuditAction;
  outcome: AuditOutcome;
  actorType: AuditActorType;
  userId?: string | null;
  sessionId?: string | null;
  installationRecordId?: string | null;
  repositoryId?: number | null;
  requestId?: string | null;
  ip?: string | null;
  reason?: string | null;
  metadata?: Record<string, unknown>;
  now?: Date;
}

export function auditEventsCollection(db: Db): Collection<AuditEventDocument> {
  return db.collection<AuditEventDocument>(COLLECTIONS.auditEvents);
}

export function buildAuditEvent(input: AuditEventInput): AuditEventDocument {
  const createdAt = input.now ?? new Date();
  const metadata =
    input.metadata === undefined ? {} : (redactValue(input.metadata) as Record<string, unknown>);

  return {
    auditEventId: newPrefixedId(AUDIT_EVENT_ID_PREFIX),
    action: input.action,
    outcome: input.outcome,
    actorType: input.actorType,
    userId: input.userId ?? null,
    sessionId: input.sessionId ?? null,
    installationRecordId: input.installationRecordId ?? null,
    repositoryId: input.repositoryId ?? null,
    requestId: input.requestId ?? null,
    ip: input.ip ?? null,
    reason: input.reason ?? null,
    metadata,
    createdAt,
    expiresAt: daysFromNow(AUDIT_RETENTION_DAYS, createdAt),
  };
}

export const auditEventModel: ModelDefinition = {
  name: COLLECTIONS.auditEvents,
  validator: {
    $jsonSchema: {
      bsonType: 'object',
      additionalProperties: false,
      required: [
        'auditEventId',
        'action',
        'outcome',
        'actorType',
        'userId',
        'sessionId',
        'installationRecordId',
        'repositoryId',
        'requestId',
        'ip',
        'reason',
        'metadata',
        'createdAt',
        'expiresAt',
      ],
      properties: {
        _id: OBJECT_ID_PROPERTY,
        auditEventId: { bsonType: 'string', pattern: publicIdPattern(AUDIT_EVENT_ID_PREFIX) },
        action: { enum: [...AUDIT_ACTIONS] },
        outcome: { enum: [...AUDIT_OUTCOMES] },
        actorType: { enum: [...AUDIT_ACTOR_TYPES] },
        userId: { bsonType: ['string', 'null'], pattern: publicIdPattern('usr') },
        sessionId: { bsonType: ['string', 'null'], pattern: publicIdPattern('ses') },
        installationRecordId: { bsonType: ['string', 'null'], pattern: publicIdPattern('ins') },
        repositoryId: { bsonType: ['number', 'null'], minimum: 1 },
        requestId: { bsonType: ['string', 'null'], pattern: publicIdPattern('req') },
        ip: { bsonType: ['string', 'null'], maxLength: 45 },
        reason: { bsonType: ['string', 'null'], maxLength: LIMITS.reasonMaxChars },
        metadata: { bsonType: 'object' },
        createdAt: { bsonType: 'date' },
        expiresAt: { bsonType: 'date' },
      },
    },
  },
  indexes: [
    { key: { auditEventId: 1 }, name: 'audit_event_id_unique', unique: true },
    { key: { createdAt: -1 }, name: 'audit_recent' },
    { key: { userId: 1, createdAt: -1 }, name: 'audit_user_recent' },
    { key: { action: 1, createdAt: -1 }, name: 'audit_action_recent' },
    { key: { sessionId: 1, createdAt: -1 }, name: 'audit_session_recent' },
    { key: { expiresAt: 1 }, name: 'audit_ttl', expireAfterSeconds: 0 },
  ],
};
