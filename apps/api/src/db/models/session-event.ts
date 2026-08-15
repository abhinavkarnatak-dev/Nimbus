import {
  SERVER_EVENT_TYPES,
  SessionEventEnvelopeSchema,
  type ServerEvent,
  type ServerEventType,
  type SessionEventEnvelope,
} from '@nimbus/contracts';
import type { Collection, Db } from 'mongodb';

import { COLLECTIONS } from '../collections.js';
import {
  OBJECT_ID_PROPERTY,
  publicIdPattern,
  toIsoTimestamp,
  type ModelDefinition,
} from './shared.js';
import { SESSION_ID_PREFIX } from './session.js';

export const EVENT_RETENTION_DAYS = 30;

export interface SessionEventDocument {
  sessionId: string;
  userId: string;
  sequence: number;
  type: ServerEventType;
  event: ServerEvent;
  emittedAt: Date;
  expiresAt: Date;
}

export function sessionEventsCollection(db: Db): Collection<SessionEventDocument> {
  return db.collection<SessionEventDocument>(COLLECTIONS.sessionEvents);
}

export function toEventEnvelope(document: SessionEventDocument): SessionEventEnvelope {
  return SessionEventEnvelopeSchema.parse({
    v: 1,
    sequence: document.sequence,
    sessionId: document.sessionId,
    emittedAt: toIsoTimestamp(document.emittedAt),
    event: document.event,
  });
}

export const sessionEventModel: ModelDefinition = {
  name: COLLECTIONS.sessionEvents,
  validator: {
    $jsonSchema: {
      bsonType: 'object',
      additionalProperties: false,
      required: ['sessionId', 'userId', 'sequence', 'type', 'event', 'emittedAt', 'expiresAt'],
      properties: {
        _id: OBJECT_ID_PROPERTY,
        sessionId: { bsonType: 'string', pattern: publicIdPattern(SESSION_ID_PREFIX) },
        userId: { bsonType: 'string', pattern: publicIdPattern('usr') },
        sequence: { bsonType: 'number', minimum: 1 },
        type: { enum: [...SERVER_EVENT_TYPES] },
        event: { bsonType: 'object' },
        emittedAt: { bsonType: 'date' },
        expiresAt: { bsonType: 'date' },
      },
    },
  },
  indexes: [
    {
      key: { sessionId: 1, sequence: 1 },
      name: 'session_event_sequence_unique',
      unique: true,
    },
    { key: { expiresAt: 1 }, name: 'session_event_expiry', expireAfterSeconds: 0 },
  ],
};
