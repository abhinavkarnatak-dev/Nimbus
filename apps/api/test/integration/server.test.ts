import { testMongoUri, uniqueTestDatabaseName } from '@nimbus/test-utils';
import { HealthResponseSchema } from '@nimbus/contracts';
import { MongoClient } from 'mongodb';
import { afterEach, describe, expect, it } from 'vitest';

import { COLLECTIONS } from '../../src/db/collections.js';
import { closeDatabase } from '../../src/db/client.js';
import { closeRedis, getRedis } from '../../src/redis/client.js';
import { createTestLogger, testConfig, type CapturedLog } from '../../src/http/http.fixtures.js';
import { startApi, type RunningApi } from '../../src/server.js';

const started: RunningApi[] = [];
const createdDatabases: string[] = [];

async function bootApi(): Promise<{
  api: RunningApi;
  baseUrl: string;
  databaseName: string;
  lines: CapturedLog[];
}> {
  const databaseName = uniqueTestDatabaseName('nimbus_server');
  createdDatabases.push(databaseName);

  const { logger, lines } = createTestLogger();
  const config = testConfig({ MONGODB_URI: `${testMongoUri()}/${databaseName}` });

  const api = await startApi({ config, logger, port: 0 });
  started.push(api);

  return { api, baseUrl: `http://127.0.0.1:${String(api.port)}`, databaseName, lines };
}

afterEach(async () => {
  await Promise.all(started.splice(0).map((api) => api.shutdown('test cleanup')));
  await closeRedis();
  await closeDatabase();

  const client = new MongoClient(testMongoUri());
  await client.connect();
  await Promise.all(createdDatabases.splice(0).map((name) => client.db(name).dropDatabase()));
  await client.close();
});

describe('starting the api for real', () => {
  it('listens, serves health, and sets up the database on the way up', async () => {
    const { baseUrl, databaseName } = await bootApi();

    const health = await fetch(`${baseUrl}/health`);
    expect(health.status).toBe(200);
    expect(HealthResponseSchema.parse(await health.json()).status).toBe('ok');

    const client = new MongoClient(testMongoUri());
    await client.connect();
    const names = (await client.db(databaseName).listCollections().toArray()).map(
      (entry) => entry.name,
    );
    await client.close();

    expect(names.sort()).toEqual(Object.values(COLLECTIONS).sort());
  });

  it('reports ready because MongoDB and Redis really answer', async () => {
    const { baseUrl } = await bootApi();

    const response = await fetch(`${baseUrl}/ready`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ready' });
  });

  it('reports not ready when Redis stops answering, without saying why', async () => {
    const { baseUrl, lines } = await bootApi();

    getRedis().disconnect();

    const response = await fetch(`${baseUrl}/ready`);
    const body = await response.text();

    expect(response.status).toBe(503);
    expect(body).toBe(JSON.stringify({ status: 'not_ready' }));
    expect(body).not.toContain('redis');
    expect(JSON.stringify(lines)).toContain('redis');
  });

  it('returns the contract error shape for an unknown path', async () => {
    const { baseUrl } = await bootApi();

    const response = await fetch(`${baseUrl}/not-a-real-route`);
    const body = (await response.json()) as { error: { code: string; requestId: string } };

    expect(response.status).toBe(404);
    expect(body.error.code).toBe('NOT_FOUND');
    expect(body.error.requestId).toBe(response.headers.get('x-request-id'));
  });

  it('refuses to hand a cross origin allow header to another site', async () => {
    const { baseUrl } = await bootApi();

    const allowed = await fetch(`${baseUrl}/health`, {
      headers: { Origin: 'http://localhost:5173' },
    });
    const refused = await fetch(`${baseUrl}/health`, { headers: { Origin: 'http://evil.com' } });

    expect(allowed.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
    expect(refused.headers.get('access-control-allow-origin')).toBeNull();
  });
});

describe('shutting down', () => {
  it('stops accepting new connections', async () => {
    const { api, baseUrl } = await bootApi();

    expect((await fetch(`${baseUrl}/health`)).status).toBe(200);

    await api.shutdown('test');

    await expect(fetch(`${baseUrl}/health`)).rejects.toThrow();
  });

  it('is safe to call more than once', async () => {
    const { api } = await bootApi();

    await api.shutdown('first');
    await expect(api.shutdown('second')).resolves.toBeUndefined();
  });

  it('closes the database connection', async () => {
    const { api } = await bootApi();

    await api.shutdown('test');

    const { getDb } = await import('../../src/db/client.js');
    expect(() => getDb()).toThrow();
  });

  it('says why it is shutting down and that it finished', async () => {
    const { api, lines } = await bootApi();

    await api.shutdown('SIGTERM');

    const messages = lines.map((line) => line.msg);
    expect(messages).toContain('Shutting down');
    expect(messages).toContain('Shutdown complete');
    expect(lines.some((line) => line['reason'] === 'SIGTERM')).toBe(true);
  });
});
