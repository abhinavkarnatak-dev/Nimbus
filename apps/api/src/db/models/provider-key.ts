import {
  LLM_PROVIDERS,
  PROVIDER_KEY_HINT_CHARS,
  ProviderKeySummarySchema,
  type LlmProviderName,
  type ProviderKeySummary,
} from '@nimbus/contracts';
import type { Collection, Db } from 'mongodb';

import { COLLECTIONS } from '../collections.js';
import type { SealedSecret } from '../../lib/secret-box.js';
import {
  OBJECT_ID_PROPERTY,
  publicIdPattern,
  toIsoTimestamp,
  toIsoTimestampOrNull,
  type ModelDefinition,
} from './shared.js';

export const PROVIDER_KEY_ID_PREFIX = 'pky';

export const SEALED_SECRET_MAX_CHARS = 512;

export interface ProviderKeyDocument {
  providerKeyId: string;
  userId: string;
  provider: LlmProviderName;
  hint: string;
  sealed: SealedSecret;
  createdAt: Date;
  updatedAt: Date;
  lastVerifiedAt: Date | null;
}

export function providerKeysCollection(db: Db): Collection<ProviderKeyDocument> {
  return db.collection<ProviderKeyDocument>(COLLECTIONS.providerKeys);
}

export function toProviderKeySummary(document: ProviderKeyDocument): ProviderKeySummary {
  return ProviderKeySummarySchema.parse({
    provider: document.provider,
    hint: document.hint,
    addedAt: toIsoTimestamp(document.createdAt),
    lastVerifiedAt: toIsoTimestampOrNull(document.lastVerifiedAt),
  });
}

export function sealedBinding(userId: string, provider: LlmProviderName): string {
  return `${COLLECTIONS.providerKeys}:${userId}:${provider}`;
}

export const providerKeyModel: ModelDefinition = {
  name: COLLECTIONS.providerKeys,
  validator: {
    $jsonSchema: {
      bsonType: 'object',
      additionalProperties: false,
      required: [
        'providerKeyId',
        'userId',
        'provider',
        'hint',
        'sealed',
        'createdAt',
        'updatedAt',
        'lastVerifiedAt',
      ],
      properties: {
        _id: OBJECT_ID_PROPERTY,
        providerKeyId: { bsonType: 'string', pattern: publicIdPattern(PROVIDER_KEY_ID_PREFIX) },
        userId: { bsonType: 'string', pattern: publicIdPattern('usr') },
        provider: { enum: [...LLM_PROVIDERS] },
        hint: { bsonType: 'string', minLength: 1, maxLength: PROVIDER_KEY_HINT_CHARS },
        sealed: {
          bsonType: 'object',
          additionalProperties: false,
          required: ['version', 'iv', 'ciphertext', 'authTag'],
          properties: {
            version: { bsonType: 'number', minimum: 1 },
            iv: { bsonType: 'string', minLength: 1, maxLength: SEALED_SECRET_MAX_CHARS },
            ciphertext: { bsonType: 'string', minLength: 1, maxLength: SEALED_SECRET_MAX_CHARS },
            authTag: { bsonType: 'string', minLength: 1, maxLength: SEALED_SECRET_MAX_CHARS },
          },
        },
        createdAt: { bsonType: 'date' },
        updatedAt: { bsonType: 'date' },
        lastVerifiedAt: { bsonType: ['date', 'null'] },
      },
    },
  },
  indexes: [
    { key: { providerKeyId: 1 }, name: 'provider_key_id_unique', unique: true },
    { key: { userId: 1, provider: 1 }, name: 'provider_key_user_provider_unique', unique: true },
  ],
};
