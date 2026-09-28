import type { Collection, Db } from 'mongodb';

import { COLLECTIONS } from '../collections.js';
import type { SealedSecret } from '../../lib/secret-box.js';
import { OBJECT_ID_PROPERTY, publicIdPattern, type ModelDefinition } from './shared.js';

export interface CodexCredentialDocument {
  userId: string;
  sealed: SealedSecret;
  createdAt: Date;
  updatedAt: Date;
  lastSeenAt: Date;
}

export function codexCredentialsCollection(db: Db): Collection<CodexCredentialDocument> {
  return db.collection<CodexCredentialDocument>(COLLECTIONS.codexCredentials);
}

export function codexCredentialBinding(userId: string): string {
  return `${COLLECTIONS.codexCredentials}:${userId}`;
}

export const codexCredentialModel: ModelDefinition = {
  name: COLLECTIONS.codexCredentials,
  validator: {
    $jsonSchema: {
      bsonType: 'object',
      additionalProperties: false,
      required: ['userId', 'sealed', 'createdAt', 'updatedAt', 'lastSeenAt'],
      properties: {
        _id: OBJECT_ID_PROPERTY,
        userId: { bsonType: 'string', pattern: publicIdPattern('usr') },
        sealed: {
          bsonType: 'object',
          additionalProperties: false,
          required: ['version', 'iv', 'ciphertext', 'authTag'],
          properties: {
            version: { bsonType: 'number', minimum: 1 },
            iv: { bsonType: 'string', minLength: 1, maxLength: 512 },
            ciphertext: { bsonType: 'string', minLength: 1, maxLength: 2_000_000 },
            authTag: { bsonType: 'string', minLength: 1, maxLength: 512 },
          },
        },
        createdAt: { bsonType: 'date' },
        updatedAt: { bsonType: 'date' },
        lastSeenAt: { bsonType: 'date' },
      },
    },
  },
  indexes: [{ key: { userId: 1 }, name: 'codex_credential_user_unique', unique: true }],
};
