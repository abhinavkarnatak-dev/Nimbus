import type { Collection, Db } from 'mongodb';

import { COLLECTIONS } from '../collections.js';
import { SESSION_ID_PREFIX } from './session.js';
import { OBJECT_ID_PROPERTY, publicIdPattern, type ModelDefinition } from './shared.js';

export const CHECKPOINT_MAX_BYTES = 262_144;

export interface CheckpointWriteDocument {
  taskId: string;
  channel: string;
  index: number;
  type: string;
  value: string;
}

export interface CheckpointDocument {
  threadId: string;
  namespace: string;
  checkpointId: string;
  parentCheckpointId: string | null;
  stateVersion: number;
  baseCommitSha: string;
  checkpoint: string;
  metadata: string;
  writes: CheckpointWriteDocument[];
  byteSize: number;
  createdAt: Date;
  expiresAt: Date;
}

export function checkpointsCollection(db: Db): Collection<CheckpointDocument> {
  return db.collection<CheckpointDocument>(COLLECTIONS.checkpoints);
}

export const checkpointModel: ModelDefinition = {
  name: COLLECTIONS.checkpoints,
  validator: {
    $jsonSchema: {
      bsonType: 'object',
      additionalProperties: false,
      required: [
        'threadId',
        'namespace',
        'checkpointId',
        'parentCheckpointId',
        'stateVersion',
        'baseCommitSha',
        'checkpoint',
        'metadata',
        'writes',
        'byteSize',
        'createdAt',
        'expiresAt',
      ],
      properties: {
        _id: OBJECT_ID_PROPERTY,
        threadId: { bsonType: 'string', pattern: publicIdPattern(SESSION_ID_PREFIX) },
        namespace: { bsonType: 'string', maxLength: 120 },
        checkpointId: { bsonType: 'string', minLength: 1, maxLength: 120 },
        parentCheckpointId: {
          oneOf: [{ bsonType: 'string', minLength: 1, maxLength: 120 }, { bsonType: 'null' }],
        },
        stateVersion: { bsonType: 'number', minimum: 1 },
        baseCommitSha: { bsonType: 'string', pattern: '^[0-9a-f]{40}$' },
        checkpoint: { bsonType: 'string', maxLength: CHECKPOINT_MAX_BYTES },
        metadata: { bsonType: 'string', maxLength: 8192 },
        writes: {
          bsonType: 'array',
          maxItems: 200,
          items: {
            bsonType: 'object',
            additionalProperties: false,
            required: ['taskId', 'channel', 'index', 'type', 'value'],
            properties: {
              taskId: { bsonType: 'string', minLength: 1, maxLength: 120 },
              channel: { bsonType: 'string', minLength: 1, maxLength: 120 },
              index: { bsonType: 'number' },
              type: { bsonType: 'string', minLength: 1, maxLength: 40 },
              value: { bsonType: 'string', maxLength: CHECKPOINT_MAX_BYTES },
            },
          },
        },
        byteSize: { bsonType: 'number', minimum: 0, maximum: CHECKPOINT_MAX_BYTES },
        createdAt: { bsonType: 'date' },
        expiresAt: { bsonType: 'date' },
      },
    },
  },
  indexes: [
    {
      key: { threadId: 1, namespace: 1, checkpointId: 1 },
      name: 'checkpoint_identity_unique',
      unique: true,
    },
    {
      key: { threadId: 1, namespace: 1, createdAt: -1, checkpointId: -1 },
      name: 'checkpoint_thread_recent',
    },
    { key: { expiresAt: 1 }, name: 'checkpoint_expiry', expireAfterSeconds: 0 },
  ],
};
