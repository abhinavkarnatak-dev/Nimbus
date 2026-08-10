import express from 'express';
import { describe, expect, it } from 'vitest';

import {
  HEADERS_TIMEOUT_MS,
  KEEP_ALIVE_TIMEOUT_MS,
  REQUEST_TIMEOUT_MS,
  closeHttpServer,
  createHttpServer,
  listenAsync,
} from './server.js';

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

function deferred(): Deferred {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((settle) => {
    resolve = () => {
      settle();
    };
  });
  return { promise, resolve };
}

describe('server timeouts', () => {
  it('replaces the generous defaults that allow a slow request to hold a slot', async () => {
    const server = createHttpServer(express());

    expect(server.headersTimeout).toBe(HEADERS_TIMEOUT_MS);
    expect(server.requestTimeout).toBe(REQUEST_TIMEOUT_MS);
    expect(server.keepAliveTimeout).toBe(KEEP_ALIVE_TIMEOUT_MS);

    await closeHttpServer(server);
  });
});

describe('draining on shutdown', () => {
  it('finishes a request that was already running, then refuses new ones', async () => {
    const handlerEntered = deferred();
    const allowFinish = deferred();

    const app = express();
    app.get('/slow', (_request, response) => {
      handlerEntered.resolve();
      void allowFinish.promise.then(() => {
        response.json({ finished: true });
      });
    });

    const server = createHttpServer(app);
    const port = await listenAsync(server, 0, '127.0.0.1');
    const baseUrl = `http://127.0.0.1:${String(port)}`;

    const inFlight = fetch(`${baseUrl}/slow`);
    await handlerEntered.promise;

    const closing = closeHttpServer(server);

    allowFinish.resolve();
    const response = await inFlight;
    await closing;

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ finished: true });

    await expect(fetch(`${baseUrl}/slow`)).rejects.toThrow();
  });

  it('gives up and cuts connections if draining takes too long', async () => {
    const handlerEntered = deferred();

    const app = express();
    app.get('/never', () => {
      handlerEntered.resolve();
    });

    const server = createHttpServer(app);
    const port = await listenAsync(server, 0, '127.0.0.1');

    const inFlight = fetch(`http://127.0.0.1:${String(port)}/never`);
    await handlerEntered.promise;

    const startedAt = Date.now();
    await closeHttpServer(server, 300);
    const elapsed = Date.now() - startedAt;

    expect(elapsed).toBeLessThan(3_000);
    await expect(inFlight).rejects.toThrow();
  });

  it('resolves even when nothing is connected', async () => {
    const server = createHttpServer(express());
    await listenAsync(server, 0, '127.0.0.1');

    await expect(closeHttpServer(server)).resolves.toBeUndefined();
  });
});

describe('listenAsync', () => {
  it('reports the port the operating system actually picked', async () => {
    const server = createHttpServer(express());
    const port = await listenAsync(server, 0, '127.0.0.1');

    expect(port).toBeGreaterThan(0);

    await closeHttpServer(server);
  });

  it('rejects rather than hanging when the port is taken', async () => {
    const first = createHttpServer(express());
    const port = await listenAsync(first, 0, '127.0.0.1');

    const second = createHttpServer(express());
    await expect(listenAsync(second, port, '127.0.0.1')).rejects.toThrow();

    await closeHttpServer(first);
  });
});
