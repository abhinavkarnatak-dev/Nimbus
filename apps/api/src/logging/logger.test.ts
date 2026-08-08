import { describe, expect, it } from 'vitest';

import { createLogger } from './logger.js';
import { REDACTED } from './redact.js';
import { newRequestId, runWithRequestContext } from './request-context.js';

interface LogLine {
  level?: string;
  msg?: string;
  time?: string;
  service?: string;
  environment?: string;
  requestId?: string;
  status?: string;
  step?: number;
  [key: string]: unknown;
}

interface Capture {
  stream: { write: (line: string) => void };
  lines: () => LogLine[];
  raw: () => string;
}

function capture(): Capture {
  const written: string[] = [];
  return {
    stream: {
      write: (line: string) => {
        written.push(line);
      },
    },
    lines: () =>
      written
        .join('')
        .split('\n')
        .filter((line) => line.trim() !== '')
        .map((line) => JSON.parse(line) as LogLine),
    raw: () => written.join(''),
  };
}

const build = (sink: Capture) =>
  createLogger({ level: 'debug', environment: 'test', destination: sink.stream });

describe('log output shape', () => {
  it('writes structured JSON with a level, time, and service', () => {
    const sink = capture();
    build(sink).info('server started');

    const [line] = sink.lines();
    expect(line?.level).toBe('info');
    expect(line?.msg).toBe('server started');
    expect(line?.service).toBe('nimbus-api');
    expect(line?.environment).toBe('test');
    expect(typeof line?.time).toBe('string');
  });

  it('honours the configured level', () => {
    const sink = capture();
    createLogger({ level: 'warn', environment: 'test', destination: sink.stream }).info('ignored');

    expect(sink.lines()).toHaveLength(0);
  });
});

describe('secrets never reach the output', () => {
  it('hides secret fields in a logged object', () => {
    const sink = capture();
    build(sink).info(
      { userId: 'usr_0123456789abcdefghijk', password: 'hunter2secret', apiKey: 'gsk_live_key' },
      'user loaded',
    );

    const raw = sink.raw();
    expect(raw).not.toContain('hunter2secret');
    expect(raw).not.toContain('gsk_live_key');
    expect(raw).toContain(REDACTED);
    expect(raw).toContain('usr_0123456789abcdefghijk');
  });

  it('hides request headers, which is the common accident', () => {
    const sink = capture();
    build(sink).info(
      {
        req: {
          method: 'POST',
          url: '/sessions',
          headers: {
            authorization: 'Bearer secrettokenvalue123',
            cookie: 'nimbus_session=abc123def456',
            'user-agent': 'Mozilla/5.0',
          },
        },
      },
      'incoming request',
    );

    const raw = sink.raw();
    expect(raw).not.toContain('secrettokenvalue123');
    expect(raw).not.toContain('abc123def456');
    expect(raw).toContain('/sessions');
    expect(raw).toContain('Mozilla/5.0');
  });

  it('hides a secret hiding inside the message text', () => {
    const sink = capture();
    build(sink).info('cloning https://octocat:hunter2secret@github.com/o/r.git');

    const raw = sink.raw();
    expect(raw).not.toContain('hunter2secret');
    expect(raw).toContain('github.com/o/r.git');
  });

  it('hides a GitHub token in the message text', () => {
    const sink = capture();
    build(sink).warn('push failed using ghs_abcdefghijklmnopqrstuvwxyz0123456789');

    expect(sink.raw()).not.toContain('ghs_abcdefghijklmnopqrstuvwxyz0123456789');
  });

  it('hides secrets inside a logged error', () => {
    const sink = capture();
    build(sink).error(
      { err: new Error('connect failed for mongodb://admin:dbpassword123@host/db') },
      'database unavailable',
    );

    expect(sink.raw()).not.toContain('dbpassword123');
  });

  it('keeps ordinary messages readable', () => {
    const sink = capture();
    build(sink).info({ status: 'working', step: 4 }, 'session advanced');

    const [line] = sink.lines();
    expect(line?.msg).toBe('session advanced');
    expect(line?.status).toBe('working');
    expect(line?.step).toBe(4);
  });
});

describe('request correlation', () => {
  it('adds the request id to every line written inside a request', () => {
    const sink = capture();
    const logger = build(sink);
    const requestId = newRequestId();

    runWithRequestContext({ requestId }, () => {
      logger.info('first');
      logger.info('second');
    });

    const lines = sink.lines();
    expect(lines).toHaveLength(2);
    expect(lines[0]?.requestId).toBe(requestId);
    expect(lines[1]?.requestId).toBe(requestId);
  });

  it('adds nothing when there is no request in progress', () => {
    const sink = capture();
    build(sink).info('background task');

    expect(sink.lines()[0]?.requestId).toBeUndefined();
  });

  it('keeps the request id across awaits', async () => {
    const sink = capture();
    const logger = build(sink);
    const requestId = newRequestId();

    await runWithRequestContext({ requestId }, async () => {
      await Promise.resolve();
      logger.info('after await');
    });

    expect(sink.lines()[0]?.requestId).toBe(requestId);
  });

  it('keeps two concurrent requests separate', async () => {
    const sink = capture();
    const logger = build(sink);
    const first = newRequestId();
    const second = newRequestId();

    await Promise.all([
      runWithRequestContext({ requestId: first }, async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        logger.info('from first');
      }),
      runWithRequestContext({ requestId: second }, async () => {
        await Promise.resolve();
        logger.info('from second');
      }),
    ]);

    const byMessage = new Map(sink.lines().map((line) => [line.msg, line.requestId]));
    expect(byMessage.get('from first')).toBe(first);
    expect(byMessage.get('from second')).toBe(second);
  });
});
