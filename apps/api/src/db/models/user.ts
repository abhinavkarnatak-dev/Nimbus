import {
  AuthProviderSchema,
  AuthenticatedUserSchema,
  LIMITS,
  type AuthProvider,
  type AuthenticatedUser,
} from '@nimbus/contracts';
import type { Collection, Db } from 'mongodb';

import { COLLECTIONS } from '../collections.js';
import {
  OBJECT_ID_PROPERTY,
  publicIdPattern,
  toIsoTimestamp,
  type ModelDefinition,
} from './shared.js';

export const USER_ID_PREFIX = 'usr';

export interface UserDocument {
  userId: string;
  email: string;
  displayName: string;
  avatarUrl?: string;
  authProviders: AuthProvider[];
  createdAt: Date;
  updatedAt: Date;
  lastLoginAt: Date;
  disabledAt?: Date;
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function usersCollection(db: Db): Collection<UserDocument> {
  return db.collection<UserDocument>(COLLECTIONS.users);
}

export function toAuthenticatedUser(document: UserDocument): AuthenticatedUser {
  return AuthenticatedUserSchema.parse({
    userId: document.userId,
    email: document.email,
    displayName: document.displayName,
    ...(document.avatarUrl === undefined ? {} : { avatarUrl: document.avatarUrl }),
    authProviders: document.authProviders,
    createdAt: toIsoTimestamp(document.createdAt),
    lastLoginAt: toIsoTimestamp(document.lastLoginAt),
  });
}

export const userModel: ModelDefinition = {
  name: COLLECTIONS.users,
  validator: {
    $jsonSchema: {
      bsonType: 'object',
      additionalProperties: false,
      required: [
        'userId',
        'email',
        'displayName',
        'authProviders',
        'createdAt',
        'updatedAt',
        'lastLoginAt',
      ],
      properties: {
        _id: OBJECT_ID_PROPERTY,
        userId: { bsonType: 'string', pattern: publicIdPattern(USER_ID_PREFIX) },
        email: {
          bsonType: 'string',
          maxLength: LIMITS.emailMaxChars,
          pattern: '^[^\\sA-Z@]+@[^\\sA-Z@]+$',
        },
        displayName: { bsonType: 'string', minLength: 1, maxLength: LIMITS.displayNameMaxChars },
        avatarUrl: { bsonType: 'string', maxLength: 2048 },
        authProviders: {
          bsonType: 'array',
          minItems: 1,
          uniqueItems: true,
          items: { enum: [...AuthProviderSchema.options] },
        },
        createdAt: { bsonType: 'date' },
        updatedAt: { bsonType: 'date' },
        lastLoginAt: { bsonType: 'date' },
        disabledAt: { bsonType: 'date' },
      },
    },
  },
  indexes: [
    { key: { userId: 1 }, name: 'user_id_unique', unique: true },
    { key: { email: 1 }, name: 'user_email_unique', unique: true },
    { key: { createdAt: -1 }, name: 'user_created_at' },
  ],
};
