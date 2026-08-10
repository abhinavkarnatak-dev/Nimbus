import { Redis, type RedisOptions } from 'ioredis';

import type { Logger } from '../logging/logger.js';

export const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
export const DEFAULT_COMMAND_TIMEOUT_MS = 5_000;
export const MAX_RETRIES_PER_REQUEST = 3;
export const RETRY_BASE_DELAY_MS = 100;
export const RETRY_MAX_DELAY_MS = 3_000;

export interface RedisConnectionOptions {
  url: string;
  logger?: Logger;
  database?: number;
  connectTimeoutMs?: number;
  commandTimeoutMs?: number;
}

export class RedisNotConnectedError extends Error {
  constructor() {
    super('Redis is not connected. Call connectRedis during startup before using getRedis.');
    this.name = 'RedisNotConnectedError';
  }
}

export class RedisConnectionError extends Error {
  readonly target: string;

  constructor(target: string, cause: unknown) {
    super(`Could not connect to Redis at ${target}`, { cause });
    this.name = 'RedisConnectionError';
    this.target = target;
  }
}

export function describeRedisUrl(url: string): string {
  const withoutScheme = url.replace(/^rediss?:\/\//i, '');
  const credentialSeparator = withoutScheme.lastIndexOf('@');
  const authority =
    credentialSeparator === -1 ? withoutScheme : withoutScheme.slice(credentialSeparator + 1);
  const withoutOptions = authority.split('?')[0] ?? '';
  const pathSeparator = withoutOptions.indexOf('/');
  const host = pathSeparator === -1 ? withoutOptions : withoutOptions.slice(0, pathSeparator);
  const database = pathSeparator === -1 ? '' : withoutOptions.slice(pathSeparator + 1);

  if (host === '') {
    return 'unknown-host';
  }
  return database === '' ? host : `${host}/${database}`;
}

export function retryDelay(attempt: number): number {
  return Math.min(attempt * RETRY_BASE_DELAY_MS, RETRY_MAX_DELAY_MS);
}

function buildOptions(options: RedisConnectionOptions): RedisOptions {
  return {
    lazyConnect: true,
    enableOfflineQueue: true,
    enableReadyCheck: true,
    maxRetriesPerRequest: MAX_RETRIES_PER_REQUEST,
    connectTimeout: options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
    commandTimeout: options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
    retryStrategy: retryDelay,
    ...(options.database === undefined ? {} : { db: options.database }),
  };
}

function attachLogging(client: Redis, logger: Logger, target: string): void {
  client.on('error', (error: Error) => {
    logger.error({ redisTarget: target, err: error }, 'Redis connection error');
  });
  client.on('reconnecting', () => {
    logger.warn({ redisTarget: target }, 'Redis reconnecting');
  });
  client.on('end', () => {
    logger.warn({ redisTarget: target }, 'Redis connection closed');
  });
}

export async function createRedisConnection(options: RedisConnectionOptions): Promise<Redis> {
  const target = describeRedisUrl(options.url);
  let client: Redis;

  try {
    client = new Redis(options.url, buildOptions(options));
  } catch (error) {
    throw new RedisConnectionError(target, error);
  }

  if (options.logger !== undefined) {
    attachLogging(client, options.logger, target);
  }

  try {
    await client.connect();
    await client.ping();
    options.logger?.info({ redisTarget: target }, 'Connected to Redis');
    return client;
  } catch (error) {
    client.disconnect();
    throw new RedisConnectionError(target, error);
  }
}

let current: Redis | undefined;
let pending: Promise<Redis> | undefined;

export async function connectRedis(options: RedisConnectionOptions): Promise<Redis> {
  pending ??= createRedisConnection(options).then((client) => {
    current = client;
    return client;
  });

  try {
    return await pending;
  } catch (error) {
    pending = undefined;
    throw error;
  }
}

export function isRedisConnected(): boolean {
  return current !== undefined;
}

export function getRedis(): Redis {
  if (current === undefined) {
    throw new RedisNotConnectedError();
  }
  return current;
}

export async function closeRedis(): Promise<void> {
  const client = current;
  current = undefined;
  pending = undefined;
  if (client !== undefined) {
    await client.quit().catch(() => {
      client.disconnect();
    });
  }
}
