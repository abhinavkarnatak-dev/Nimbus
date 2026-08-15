import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';

import { ClientMessageSchema, type SessionEventEnvelope } from '@nimbus/contracts';
import type { Redis } from 'ioredis';
import { WebSocketServer, type WebSocket } from 'ws';

import type { ActiveSession, SessionReader } from '../auth/session-service.js';
import type { Logger } from '../logging/logger.js';
import type { SessionRecords } from '../sessions/repository.js';
import { checkHandshake, REFUSAL_STATUS } from './handshake.js';
import { CLOSE_CODES, SOCKET_LIMITS } from './limits.js';
import { EVENT_CHANNEL, readEnvelope } from './publisher.js';
import type { EventStore } from './store.js';
import { Subscription } from './subscription.js';

export const SOCKET_PATH = '/events';

export interface EventHubOptions {
  server: Server;
  redis: Redis;
  store: EventStore;
  sessions: SessionReader;
  records: SessionRecords;
  logger: Logger;
  allowedOrigin: string;
  isProduction: boolean;
  revalidateMs?: number;
}

interface Connection {
  socket: WebSocket;
  session: ActiveSession;
  subscriptions: Map<string, Subscription>;
  sentAt: number[];
  badPayloads: number;
}

export class EventHub {
  readonly #options: EventHubOptions;

  readonly #wss: WebSocketServer;

  readonly #connections = new Set<Connection>();

  #timer: NodeJS.Timeout | null = null;

  #onUpgrade: ((request: IncomingMessage, socket: Duplex, head: Buffer) => void) | null = null;

  constructor(options: EventHubOptions) {
    this.#options = options;
    this.#wss = new WebSocketServer({
      noServer: true,
      maxPayload: SOCKET_LIMITS.maxPayloadBytes,
    });
  }

  get connections(): number {
    return this.#connections.size;
  }

  start(): void {
    if (this.#onUpgrade !== null) {
      return;
    }

    this.#onUpgrade = (request, socket, head): void => {
      void this.#upgrade(request, socket, head);
    };

    this.#options.server.on('upgrade', this.#onUpgrade);

    this.#timer = setInterval(() => {
      void this.#revalidate();
    }, this.#options.revalidateMs ?? SOCKET_LIMITS.revalidateMs);

    this.#timer.unref();
  }

  async stop(): Promise<void> {
    if (this.#onUpgrade !== null) {
      this.#options.server.off('upgrade', this.#onUpgrade);
      this.#onUpgrade = null;
    }

    if (this.#timer !== null) {
      clearInterval(this.#timer);
      this.#timer = null;
    }

    for (const connection of [...this.#connections]) {
      this.#drop(connection, CLOSE_CODES.goingAway);
    }

    await new Promise<void>((resolve) => {
      this.#wss.close(() => {
        resolve();
      });
    });
  }

  deliver(envelope: SessionEventEnvelope): void {
    for (const connection of this.#connections) {
      connection.subscriptions.get(envelope.sessionId)?.offer(envelope);
    }
  }

  async #upgrade(request: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    if (new URL(request.url ?? '/', 'http://placeholder').pathname !== SOCKET_PATH) {
      return;
    }

    const checked = await checkHandshake(request, {
      sessions: this.#options.sessions,
      allowedOrigin: this.#options.allowedOrigin,
      isProduction: this.#options.isProduction,
    });

    if (!checked.ok) {
      const status = REFUSAL_STATUS[checked.refusal];

      this.#options.logger.warn(
        { refusal: checked.refusal, origin: request.headers.origin ?? null },
        'a socket handshake was refused',
      );

      socket.write(`HTTP/1.1 ${String(status)} ${checked.refusal}\r\nConnection: close\r\n\r\n`);
      socket.destroy();
      return;
    }

    this.#wss.handleUpgrade(request, socket, head, (websocket) => {
      this.#accept(websocket, checked.session);
    });
  }

  #accept(socket: WebSocket, session: ActiveSession): void {
    const connection: Connection = {
      socket,
      session,
      subscriptions: new Map(),
      sentAt: [],
      badPayloads: 0,
    };

    this.#connections.add(connection);

    socket.on('message', (raw: Buffer) => {
      void this.#onMessage(connection, raw.toString('utf8'));
    });

    socket.on('close', () => {
      this.#forget(connection);
    });

    socket.on('error', () => {
      this.#forget(connection);
    });
  }

  async #onMessage(connection: Connection, raw: string): Promise<void> {
    if (this.#tooFast(connection)) {
      this.#drop(connection, CLOSE_CODES.tooManyMessages);
      return;
    }

    let parsed: unknown;

    try {
      parsed = JSON.parse(raw);
    } catch {
      this.#nonsense(connection);
      return;
    }

    const checked = ClientMessageSchema.safeParse(parsed);

    if (!checked.success) {
      this.#nonsense(connection);
      return;
    }

    const message = checked.data;

    if (message.type === 'session.subscribe') {
      await this.#subscribe(
        connection,
        message.payload.sessionId,
        message.payload.lastEventSequence,
      );
      return;
    }

    connection.subscriptions.get(message.payload.sessionId)?.close();
    connection.subscriptions.delete(message.payload.sessionId);
  }

  async #subscribe(connection: Connection, sessionId: string, from: number): Promise<void> {
    if (connection.subscriptions.has(sessionId)) {
      return;
    }

    if (connection.subscriptions.size >= SOCKET_LIMITS.maxSubscriptions) {
      this.#nonsense(connection);
      return;
    }

    const owned = await this.#options.records.findOwned(connection.session.user.userId, sessionId);

    if (owned === null) {
      this.#options.logger.warn(
        { userId: connection.session.user.userId, sessionId },
        'a socket asked for a session that is not theirs',
      );
      this.#nonsense(connection);
      return;
    }

    const subscription = new Subscription({
      sessionId,
      from,
      store: this.#options.store,
      deliver: (envelope) => {
        this.#write(connection, envelope);
      },
    });

    connection.subscriptions.set(sessionId, subscription);
    await subscription.replay();
  }

  #write(connection: Connection, envelope: SessionEventEnvelope): void {
    if (connection.socket.readyState !== connection.socket.OPEN) {
      return;
    }
    connection.socket.send(JSON.stringify(envelope));
  }

  #tooFast(connection: Connection): boolean {
    const now = Date.now();
    connection.sentAt = connection.sentAt.filter((at) => now - at < SOCKET_LIMITS.windowMs);
    connection.sentAt.push(now);

    return connection.sentAt.length > SOCKET_LIMITS.messagesPerWindow;
  }

  #nonsense(connection: Connection): void {
    connection.badPayloads += 1;

    if (connection.badPayloads > SOCKET_LIMITS.badPayloadsAllowed) {
      this.#drop(connection, CLOSE_CODES.tooMuchNonsense);
    }
  }

  #drop(connection: Connection, code: number): void {
    try {
      connection.socket.close(code);
    } catch {
      connection.socket.terminate();
    }
    this.#forget(connection);
  }

  #forget(connection: Connection): void {
    for (const subscription of connection.subscriptions.values()) {
      subscription.close();
    }

    connection.subscriptions.clear();
    this.#connections.delete(connection);
  }

  async #revalidate(): Promise<void> {
    for (const connection of [...this.#connections]) {
      const still = await this.#options.sessions.load(connection.session.sessionId);

      if (still === null) {
        this.#options.logger.info(
          { userId: connection.session.user.userId },
          'a socket was closed because its login is gone',
        );
        this.#drop(connection, CLOSE_CODES.loggedOut);
      }
    }
  }
}

export async function listenForEvents(redis: Redis, hub: EventHub, logger: Logger): Promise<Redis> {
  const listener = redis.duplicate();

  await listener.subscribe(EVENT_CHANNEL);

  listener.on('message', (_channel: string, payload: string) => {
    const envelope = readEnvelope(payload);

    if (envelope === null) {
      logger.warn({}, 'an event arrived on the channel that could not be read');
      return;
    }
    hub.deliver(envelope);
  });

  return listener;
}
