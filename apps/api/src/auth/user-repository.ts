import type { AuthProvider, AuthenticatedUser } from '@nimbus/contracts';
import type { Db } from 'mongodb';

import { newPrefixedId } from '../lib/id.js';
import {
  USER_ID_PREFIX,
  normalizeEmail,
  toAuthenticatedUser,
  usersCollection,
  type UserDocument,
} from '../db/models/user.js';

const DUPLICATE_KEY = 11_000;

function isDuplicateKey(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === DUPLICATE_KEY
  );
}

function displayNameFromEmail(email: string): string {
  const local = email.slice(0, email.lastIndexOf('@'));
  return local === '' ? 'Nimbus user' : local;
}

export class AccountDisabledError extends Error {
  constructor() {
    super('This account has been disabled.');
    this.name = 'AccountDisabledError';
  }
}

export interface FindOrCreateResult {
  user: AuthenticatedUser;
  created: boolean;
}

export async function findOrCreateUserByEmail(
  db: Db,
  rawEmail: string,
  provider: AuthProvider,
): Promise<FindOrCreateResult> {
  const email = normalizeEmail(rawEmail);
  const collection = usersCollection(db);
  const now = new Date();

  const existing = await collection.findOne({ email });

  if (existing !== null) {
    if (existing.disabledAt !== undefined) {
      throw new AccountDisabledError();
    }

    await collection.updateOne(
      { email },
      {
        $set: { updatedAt: now, lastLoginAt: now },
        $addToSet: { authProviders: provider },
      },
    );

    const providers = existing.authProviders.includes(provider)
      ? existing.authProviders
      : [...existing.authProviders, provider];

    return {
      user: toAuthenticatedUser({ ...existing, authProviders: providers, lastLoginAt: now }),
      created: false,
    };
  }

  const document: UserDocument = {
    userId: newPrefixedId(USER_ID_PREFIX),
    email,
    displayName: displayNameFromEmail(email),
    authProviders: [provider],
    createdAt: now,
    updatedAt: now,
    lastLoginAt: now,
  };

  try {
    await collection.insertOne(document);
    return { user: toAuthenticatedUser(document), created: true };
  } catch (error) {
    if (!isDuplicateKey(error)) {
      throw error;
    }

    const raced = await collection.findOne({ email });
    if (raced === null) {
      throw error;
    }
    if (raced.disabledAt !== undefined) {
      throw new AccountDisabledError();
    }
    return { user: toAuthenticatedUser(raced), created: false };
  }
}
