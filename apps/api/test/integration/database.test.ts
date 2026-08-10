import { createTestDatabase, testMongoUri, type TestDatabase } from '@nimbus/test-utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ensureDatabaseSchema } from '../../src/db/bootstrap.js';
import {
  DatabaseConnectionError,
  createDatabaseConnection,
  describeMongoUri,
} from '../../src/db/client.js';
import { COLLECTIONS } from '../../src/db/collections.js';
import { ALL_MODELS } from '../../src/db/models/index.js';

let testDatabase: TestDatabase;

beforeAll(async () => {
  testDatabase = await createTestDatabase('nimbus_db');
});

afterAll(async () => {
  await testDatabase.cleanup();
});

describe('createDatabaseConnection', () => {
  it('connects and answers a real ping', async () => {
    const handle = await createDatabaseConnection({
      uri: testMongoUri(),
      databaseName: testDatabase.databaseName,
    });

    const result = await handle.db.command({ ping: 1 });
    expect(result['ok']).toBe(1);

    await handle.client.close();
  });

  it('fails with a safe error when the server is not there', async () => {
    const attempt = createDatabaseConnection({
      uri: 'mongodb://user:hunter2@127.0.0.1:1/nimbus',
      serverSelectionTimeoutMs: 500,
    });

    await expect(attempt).rejects.toBeInstanceOf(DatabaseConnectionError);
    await attempt.catch((error: unknown) => {
      const failure = error as DatabaseConnectionError;
      expect(failure.message).not.toContain('hunter2');
      expect(failure.target).toBe(describeMongoUri('mongodb://user:hunter2@127.0.0.1:1/nimbus'));
    });
  });
});

describe('ensureDatabaseSchema', () => {
  it('creates every collection with a validator on the first run', async () => {
    const results = await ensureDatabaseSchema(testDatabase.db);

    expect(results.map((result) => result.collection).sort()).toEqual(
      Object.values(COLLECTIONS).sort(),
    );
    expect(results.every((result) => result.created)).toBe(true);

    const collections = await testDatabase.db.listCollections({}, { nameOnly: false }).toArray();
    for (const model of ALL_MODELS) {
      const info = collections.find((entry) => entry.name === model.name);
      expect(info?.options?.['validator']).toBeDefined();
      expect(info?.options?.['validationAction']).toBe('error');
      expect(info?.options?.['validationLevel']).toBe('strict');
    }
  });

  it('is idempotent, so a second run changes nothing', async () => {
    const before = await indexNamesByCollection();
    const results = await ensureDatabaseSchema(testDatabase.db);
    const after = await indexNamesByCollection();

    expect(results.every((result) => !result.created)).toBe(true);
    expect(results.every((result) => result.indexesCreated.length === 0)).toBe(true);
    expect(after).toEqual(before);
  });

  it('creates the indexes each model declares', async () => {
    const names = await indexNamesByCollection();

    for (const model of ALL_MODELS) {
      const created = names[model.name] ?? [];
      for (const index of model.indexes) {
        expect(created).toContain(index.name);
      }
      expect(created).toContain('_id_');
    }
  });

  it('marks the expiring collections with a time to live index', async () => {
    const sessionIndexes = await testDatabase.db.collection(COLLECTIONS.auditEvents).indexes();
    const ttl = sessionIndexes.find((index) => index.name === 'audit_ttl');

    expect(ttl?.expireAfterSeconds).toBe(0);
  });
});

async function indexNamesByCollection(): Promise<Record<string, string[]>> {
  const entries: Record<string, string[]> = {};

  for (const model of ALL_MODELS) {
    const indexes = await testDatabase.db.collection(model.name).indexes();
    entries[model.name] = indexes.map((index) => index.name ?? '').sort();
  }

  return entries;
}
