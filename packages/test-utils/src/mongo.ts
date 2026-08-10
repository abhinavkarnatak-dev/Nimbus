import { randomBytes } from 'node:crypto';

import { MongoClient, type Db } from 'mongodb';

const DEFAULT_TEST_URI = 'mongodb://127.0.0.1:27017';

export interface TestDatabase {
  client: MongoClient;
  db: Db;
  databaseName: string;
  cleanup: () => Promise<void>;
}

export function testMongoUri(): string {
  const configured = process.env['MONGODB_TEST_URI'] ?? process.env['MONGODB_URI'];
  return configured === undefined || configured === '' ? DEFAULT_TEST_URI : configured;
}

export function uniqueTestDatabaseName(prefix = 'nimbus_test'): string {
  return `${prefix}_${randomBytes(6).toString('hex')}`;
}

export async function createTestDatabase(prefix?: string): Promise<TestDatabase> {
  const databaseName = uniqueTestDatabaseName(prefix);
  const client = new MongoClient(testMongoUri(), {
    appName: 'nimbus-tests',
    ignoreUndefined: true,
    serverSelectionTimeoutMS: 10_000,
  });

  await client.connect();
  const db = client.db(databaseName);

  return {
    client,
    db,
    databaseName,
    cleanup: async () => {
      await db.dropDatabase();
      await client.close();
    },
  };
}
