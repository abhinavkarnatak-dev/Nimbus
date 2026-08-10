import { MongoClient, type Db, type MongoClientOptions } from 'mongodb';

import type { Logger } from '../logging/logger.js';

const DEFAULT_APP_NAME = 'nimbus-api';
const DEFAULT_MAX_POOL_SIZE = 10;
const DEFAULT_SERVER_SELECTION_TIMEOUT_MS = 10_000;

export interface DatabaseConnectionOptions {
  uri: string;
  databaseName?: string;
  appName?: string;
  logger?: Logger;
  maxPoolSize?: number;
  serverSelectionTimeoutMs?: number;
}

export interface DatabaseHandle {
  readonly client: MongoClient;
  readonly db: Db;
}

export class DatabaseNotConnectedError extends Error {
  constructor() {
    super('MongoDB is not connected. Call connectDatabase during startup before using getDb.');
    this.name = 'DatabaseNotConnectedError';
  }
}

export class DatabaseConnectionError extends Error {
  readonly target: string;

  constructor(target: string, cause: unknown) {
    super(`Could not connect to MongoDB at ${target}`, { cause });
    this.name = 'DatabaseConnectionError';
    this.target = target;
  }
}

export function describeMongoUri(uri: string): string {
  const withoutScheme = uri.replace(/^mongodb(?:\+srv)?:\/\//i, '');
  const credentialSeparator = withoutScheme.lastIndexOf('@');
  const authority =
    credentialSeparator === -1 ? withoutScheme : withoutScheme.slice(credentialSeparator + 1);
  const withoutOptions = authority.split('?')[0] ?? '';
  const pathSeparator = withoutOptions.indexOf('/');
  const hosts = pathSeparator === -1 ? withoutOptions : withoutOptions.slice(0, pathSeparator);
  const database = pathSeparator === -1 ? '' : withoutOptions.slice(pathSeparator + 1);

  if (hosts === '') {
    return 'unknown-host';
  }
  return database === '' ? hosts : `${hosts}/${database}`;
}

function buildClientOptions(options: DatabaseConnectionOptions): MongoClientOptions {
  return {
    appName: options.appName ?? DEFAULT_APP_NAME,
    ignoreUndefined: true,
    retryWrites: true,
    retryReads: true,
    maxPoolSize: options.maxPoolSize ?? DEFAULT_MAX_POOL_SIZE,
    serverSelectionTimeoutMS:
      options.serverSelectionTimeoutMs ?? DEFAULT_SERVER_SELECTION_TIMEOUT_MS,
  };
}

export async function createDatabaseConnection(
  options: DatabaseConnectionOptions,
): Promise<DatabaseHandle> {
  const target = describeMongoUri(options.uri);
  let client: MongoClient;

  try {
    client = new MongoClient(options.uri, buildClientOptions(options));
  } catch (error) {
    throw new DatabaseConnectionError(target, error);
  }

  try {
    await client.connect();
    const db = client.db(options.databaseName);
    await db.command({ ping: 1 });
    options.logger?.info(
      { mongoTarget: target, database: db.databaseName },
      'Connected to MongoDB',
    );
    return { client, db };
  } catch (error) {
    await client.close().catch(() => undefined);
    throw new DatabaseConnectionError(target, error);
  }
}

let handle: DatabaseHandle | undefined;
let pending: Promise<DatabaseHandle> | undefined;

export async function connectDatabase(options: DatabaseConnectionOptions): Promise<DatabaseHandle> {
  pending ??= createDatabaseConnection(options).then((connected) => {
    handle = connected;
    return connected;
  });

  try {
    return await pending;
  } catch (error) {
    pending = undefined;
    throw error;
  }
}

export function isDatabaseConnected(): boolean {
  return handle !== undefined;
}

export function getDb(): Db {
  if (handle === undefined) {
    throw new DatabaseNotConnectedError();
  }
  return handle.db;
}

export function getMongoClient(): MongoClient {
  if (handle === undefined) {
    throw new DatabaseNotConnectedError();
  }
  return handle.client;
}

export async function closeDatabase(): Promise<void> {
  const current = handle;
  handle = undefined;
  pending = undefined;
  if (current !== undefined) {
    await current.client.close();
  }
}
