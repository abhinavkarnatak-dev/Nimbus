import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { SessionEventEnvelope } from '@nimbus/contracts';
import {
  createTestDatabase,
  createTestRedis,
  type TestDatabase,
  type TestRedis,
} from '@nimbus/test-utils';
import WebSocket from 'ws';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { ActiveSession, SessionReader } from '../../src/auth/session-service.js';
import { ensureDatabaseSchema } from '../../src/db/bootstrap.js';
import { sessionEventsCollection } from '../../src/db/models/session-event.js';
import { sessionsCollection } from '../../src/db/models/session.js';
import { EventHub, SOCKET_PATH, listenForEvents } from '../../src/events/hub.js';
import { CLOSE_CODES } from '../../src/events/limits.js';
import { LiveEventPublisher } from '../../src/events/publisher.js';
import { MongoEventStore } from '../../src/events/store.js';
import { sessionCookieName } from '../../src/http/cookies.js';
import { capturingLogger } from '../../src/llm/llm.fixtures.js';
import { sessionDocument } from '../../src/orchestrator/orchestrator.fixtures.js';
import { MongoSessionRecords } from '../../src/sessions/repository.js';
import { testId } from '../../src/sessions/sessions.fixtures.js';

const ORIGIN = 'https://nimbus.local';
const COOKIE_NAME = sessionCookieName(false);
const OWNER = testId('usr', 'owner');
const STRANGER = testId('usr', 'other');

let testDatabase: TestDatabase;
let redis: TestRedis;
let listener: Awaited<ReturnType<typeof listenForEvents>>;
let server: Server;
let hub: EventHub;
let store: MongoEventStore;
let publisher: LiveEventPublisher;
let port: number;
let liveLogins: Set<string>;

const sockets: WebSocket[] = [];

function readerFor(): SessionReader {
  return {
    load: async (loginId: string): Promise<ActiveSession | null> => {
      if (!liveLogins.has(loginId)) {
        return Promise.resolve(null);
      }

      const userId = loginId === 'stranger' ? STRANGER : OWNER;

      return Promise.resolve({
        sessionId: loginId,
        sessionKey: 'hashed',
        csrfToken: 'csrf',
        user: {
          userId,
          email: 'person@example.com',
          displayName: 'person',
          authProviders: ['email_otp'],
          createdAt: '2026-08-14T00:00:00.000Z',
          lastLoginAt: '2026-08-14T00:00:00.000Z',
        },
        record: {
          userId,
          createdAt: '2026-08-14T00:00:00.000Z',
          absoluteExpiresAt: '2026-08-15T00:00:00.000Z',
        },
      } as ActiveSession);
    },
  };
}

async function connect(
  options: { origin?: string; login?: string | null } = {},
): Promise<WebSocket> {
  const headers: Record<string, string> = {};
  const origin = options.origin ?? ORIGIN;
  const login = options.login === undefined ? 'owner' : options.login;

  headers['origin'] = origin;

  if (login !== null) {
    headers['cookie'] = `${COOKIE_NAME}=${login}`;
  }

  const socket = new WebSocket(`ws://127.0.0.1:${String(port)}${SOCKET_PATH}`, { headers });
  sockets.push(socket);

  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => {
      resolve();
    });
    socket.once('error', reject);
  });

  return socket;
}

function subscribe(sessionId: string, lastEventSequence: number): string {
  return JSON.stringify({
    type: 'session.subscribe',
    payload: { v: 1, sessionId, lastEventSequence },
  });
}

function collect(socket: WebSocket, into: SessionEventEnvelope[]): void {
  socket.on('message', (raw: Buffer) => {
    into.push(JSON.parse(raw.toString('utf8')) as SessionEventEnvelope);
  });
}

async function waitFor(check: () => boolean, tries = 200): Promise<void> {
  for (let round = 0; round < tries; round += 1) {
    if (check()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function refused(options: { origin?: string; login?: string | null }): Promise<number> {
  const socket = new WebSocket(`ws://127.0.0.1:${String(port)}${SOCKET_PATH}`, {
    headers: {
      origin: options.origin ?? ORIGIN,
      ...(options.login === null ? {} : { cookie: `${COOKIE_NAME}=${options.login ?? 'owner'}` }),
    },
  });

  return new Promise<number>((resolve) => {
    socket.on('unexpected-response', (_request, response) => {
      resolve(response.statusCode ?? 0);
      socket.terminate();
    });
    socket.on('open', () => {
      socket.close();
      resolve(200);
    });
    socket.on('error', () => {
      resolve(0);
    });
  });
}

beforeAll(async () => {
  const { logger } = capturingLogger();

  testDatabase = await createTestDatabase();
  await ensureDatabaseSchema(testDatabase.db, logger);
  redis = await createTestRedis();

  store = new MongoEventStore(testDatabase.db);
  publisher = new LiveEventPublisher({ store, redis: redis.client, logger });

  server = createServer();
  hub = new EventHub({
    server,
    redis: redis.client,
    store,
    sessions: readerFor(),
    records: new MongoSessionRecords(testDatabase.db),
    logger,
    allowedOrigin: ORIGIN,
    isProduction: false,
    revalidateMs: 50,
  });

  hub.start();
  listener = await listenForEvents(redis.client, hub, logger);

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve();
    });
  });
  port = (server.address() as AddressInfo).port;
}, 60_000);

afterAll(async () => {
  await hub.stop();
  listener.disconnect();
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
  await testDatabase.cleanup();
  await redis.cleanup();
});

beforeEach(async () => {
  liveLogins = new Set(['owner', 'stranger']);
  await sessionsCollection(testDatabase.db).deleteMany({});
  await sessionEventsCollection(testDatabase.db).deleteMany({});
});

afterEach(() => {
  for (const socket of sockets.splice(0)) {
    socket.terminate();
  }
});

describe('the handshake', () => {
  it('lets a signed in person in', async () => {
    const socket = await connect();

    expect(socket.readyState).toBe(WebSocket.OPEN);
  });

  it('refuses another site holding the same cookie, before accepting anything', async () => {
    expect(await refused({ origin: 'https://evil.example' })).toBe(403);
  });

  it('refuses a handshake with no origin at all', async () => {
    const socket = new WebSocket(`ws://127.0.0.1:${String(port)}${SOCKET_PATH}`, {
      headers: { cookie: `${COOKIE_NAME}=owner` },
    });

    const status = await new Promise<number>((resolve) => {
      socket.on('unexpected-response', (_request, response) => {
        resolve(response.statusCode ?? 0);
        socket.terminate();
      });
      socket.on('open', () => {
        socket.close();
        resolve(200);
      });
      socket.on('error', () => {
        resolve(0);
      });
    });

    expect(status).toBe(403);
  });

  it('refuses a request with no cookie', async () => {
    expect(await refused({ login: null })).toBe(401);
  });

  it('refuses a cookie whose login is gone', async () => {
    liveLogins.delete('owner');

    expect(await refused({})).toBe(401);
  });
});

describe('subscribing', () => {
  it('replays what already happened, in order', async () => {
    const session = sessionDocument({ userId: OWNER });
    await sessionsCollection(testDatabase.db).insertOne({ ...session });

    for (const text of ['one', 'two', 'three']) {
      await publisher.publish(session.sessionId, OWNER, { type: 'agent.message', message: text });
    }

    const socket = await connect();
    const seen: SessionEventEnvelope[] = [];
    collect(socket, seen);

    socket.send(subscribe(session.sessionId, 0));

    await waitFor(() => seen.length === 3);

    expect(seen.map((one) => one.sequence)).toEqual([1, 2, 3]);
  });

  it('carries on live once it has caught up', async () => {
    const session = sessionDocument({ userId: OWNER });
    await sessionsCollection(testDatabase.db).insertOne({ ...session });

    const socket = await connect();
    const seen: SessionEventEnvelope[] = [];
    collect(socket, seen);

    socket.send(subscribe(session.sessionId, 0));
    await waitFor(() => hub.connections === 1);

    await publisher.publish(session.sessionId, OWNER, { type: 'agent.message', message: 'live' });
    await waitFor(() => seen.length === 1);

    expect(seen[0]?.event).toMatchObject({ type: 'agent.message', message: 'live' });
  });

  it('gives a reconnecting client only what it missed', async () => {
    const session = sessionDocument({ userId: OWNER });
    await sessionsCollection(testDatabase.db).insertOne({ ...session });

    for (const text of ['one', 'two', 'three']) {
      await publisher.publish(session.sessionId, OWNER, { type: 'agent.message', message: text });
    }

    const socket = await connect();
    const seen: SessionEventEnvelope[] = [];
    collect(socket, seen);

    socket.send(subscribe(session.sessionId, 2));
    await waitFor(() => seen.length === 1);

    expect(seen.map((one) => one.sequence)).toEqual([3]);
  });

  it("sends nothing at all for somebody else's session", async () => {
    const session = sessionDocument({ userId: STRANGER });
    await sessionsCollection(testDatabase.db).insertOne({ ...session });
    await publisher.publish(session.sessionId, STRANGER, {
      type: 'agent.message',
      message: 'private',
    });

    const socket = await connect();
    const seen: SessionEventEnvelope[] = [];
    collect(socket, seen);

    socket.send(subscribe(session.sessionId, 0));
    await waitFor(() => seen.length > 0, 30);

    expect(seen).toHaveLength(0);
  });
});

describe('what a client may send', () => {
  it('survives a payload that is not JSON', async () => {
    const socket = await connect();
    socket.send('not json at all');

    await waitFor(() => false, 20);

    expect(socket.readyState).toBe(WebSocket.OPEN);
  });

  it('survives a payload of the wrong shape', async () => {
    const socket = await connect();
    socket.send(JSON.stringify({ type: 'session.subscribe', payload: { sessionId: 'nope' } }));

    await waitFor(() => false, 20);

    expect(socket.readyState).toBe(WebSocket.OPEN);
  });

  it('closes a connection that keeps sending nonsense', async () => {
    const socket = await connect();

    for (let index = 0; index < 15; index += 1) {
      socket.send('rubbish');
    }

    const code = await new Promise<number>((resolve) => {
      socket.on('close', (closeCode) => {
        resolve(closeCode);
      });
    });

    expect(code).toBe(CLOSE_CODES.tooMuchNonsense);
  });
});

describe('a socket outliving its login', () => {
  it('is closed without the client asking', async () => {
    const socket = await connect();
    liveLogins.delete('owner');

    const code = await new Promise<number>((resolve) => {
      socket.on('close', (closeCode) => {
        resolve(closeCode);
      });
    });

    expect(code).toBe(CLOSE_CODES.loggedOut);
  });
});

describe('sequences under concurrent writes', () => {
  it('never hands the same number to two events', async () => {
    const session = sessionDocument({ userId: OWNER });
    await sessionsCollection(testDatabase.db).insertOne({ ...session });

    await Promise.all(
      Array.from({ length: 25 }, async (_value, index) =>
        publisher.publish(session.sessionId, OWNER, {
          type: 'agent.message',
          message: `one ${String(index)}`,
        }),
      ),
    );

    const stored = await store.since(session.sessionId, 0, 100);
    const sequences = stored.map((one) => one.sequence);

    expect(sequences).toHaveLength(25);
    expect(new Set(sequences).size).toBe(25);
    expect(sequences).toEqual([...sequences].sort((left, right) => left - right));
  });
});
