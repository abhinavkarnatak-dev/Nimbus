import { Redis } from 'ioredis';

const DEFAULT_TEST_URL = 'redis://127.0.0.1:6379';
const FIRST_TEST_DATABASE = 1;
const LAST_TEST_DATABASE = 15;

export interface TestRedis {
  client: Redis;
  database: number;
  cleanup: () => Promise<void>;
}

export function testRedisUrl(): string {
  const configured = process.env['REDIS_TEST_URL'] ?? process.env['REDIS_URL'];
  return configured === undefined || configured === '' ? DEFAULT_TEST_URL : configured;
}

export function pickTestDatabase(): number {
  const span = LAST_TEST_DATABASE - FIRST_TEST_DATABASE + 1;
  return FIRST_TEST_DATABASE + Math.floor(Math.random() * span);
}

export async function createTestRedis(database = pickTestDatabase()): Promise<TestRedis> {
  const client = new Redis(testRedisUrl(), { db: database, lazyConnect: true });

  await client.connect();
  await client.flushdb();

  return {
    client,
    database,
    cleanup: async () => {
      await client.flushdb();
      await client.quit();
    },
  };
}
