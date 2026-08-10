import type { Db } from 'mongodb';

import type { Logger } from '../logging/logger.js';
import { ALL_MODELS } from './models/index.js';
import type { ModelDefinition } from './models/shared.js';

const NAMESPACE_EXISTS_CODE = 48;

export interface ModelBootstrapResult {
  collection: string;
  created: boolean;
  indexesCreated: string[];
}

function hasErrorCode(error: unknown, code: number): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === code
  );
}

async function listIndexNames(db: Db, collection: string): Promise<string[]> {
  const indexes = await db.collection(collection).indexes();
  return indexes.map((index) => index.name ?? '').filter((name) => name !== '');
}

async function applyValidator(db: Db, model: ModelDefinition): Promise<boolean> {
  const validationOptions = {
    validator: model.validator,
    validationLevel: 'strict',
    validationAction: 'error',
  };

  const existing = await db.listCollections({ name: model.name }, { nameOnly: true }).toArray();

  if (existing.length > 0) {
    await db.command({ collMod: model.name, ...validationOptions });
    return false;
  }

  try {
    await db.createCollection(model.name, validationOptions);
    return true;
  } catch (error) {
    if (hasErrorCode(error, NAMESPACE_EXISTS_CODE)) {
      await db.command({ collMod: model.name, ...validationOptions });
      return false;
    }
    throw error;
  }
}

export async function ensureDatabaseSchema(
  db: Db,
  logger?: Logger,
): Promise<ModelBootstrapResult[]> {
  const results: ModelBootstrapResult[] = [];

  for (const model of ALL_MODELS) {
    const created = await applyValidator(db, model);
    const before = await listIndexNames(db, model.name);
    await db.collection(model.name).createIndexes([...model.indexes]);
    const after = await listIndexNames(db, model.name);
    const indexesCreated = after.filter((name) => !before.includes(name));

    results.push({ collection: model.name, created, indexesCreated });
  }

  logger?.info(
    {
      database: db.databaseName,
      collectionsCreated: results.filter((result) => result.created).length,
      indexesCreated: results.reduce((total, result) => total + result.indexesCreated.length, 0),
    },
    'Database schema ensured',
  );

  return results;
}
