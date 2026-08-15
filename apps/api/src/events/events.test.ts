import type { ServerEvent, SessionEventEnvelope } from '@nimbus/contracts';
import type { IncomingMessage } from 'node:http';
import { describe, expect, it } from 'vitest';

import type { ActiveSession, SessionReader } from '../auth/session-service.js';
import { sessionCookieName } from '../http/cookies.js';
import { checkHandshake, originAllowed, readCookie } from './handshake.js';
import { CollectingEventPublisher, readEnvelope } from './publisher.js';
import { InMemoryEventStore } from './store.js';
import { Subscription } from './subscription.js';

const ORIGIN = 'https://nimbus.local';
const SESSION_ID = 'ses_wwwwwwwwwwwwwwwwwwwww';
const USER_ID = 'usr_ownerownerownerowne';

function message(event: ServerEvent = { type: 'agent.message', message: 'hello' }): ServerEvent {
  return event;
}

function upgrade(headers: Record<string, string>): IncomingMessage {
  return { headers } as unknown as IncomingMessage;
}

function login(): ActiveSession {
  return {
    sessionId: 'login-id',
    sessionKey: 'hashed',
    csrfToken: 'csrf',
    user: {
      userId: USER_ID,
      email: 'person@example.com',
      displayName: 'person',
      authProviders: ['email_otp'],
      createdAt: '2026-08-14T00:00:00.000Z',
      lastLoginAt: '2026-08-14T00:00:00.000Z',
    },
    record: {
      userId: USER_ID,
      createdAt: '2026-08-14T00:00:00.000Z',
      absoluteExpiresAt: '2026-08-15T00:00:00.000Z',
    },
  } as ActiveSession;
}

function reader(session: ActiveSession | null): SessionReader {
  return { load: async () => Promise.resolve(session) };
}

describe('the origin check, which is the whole defence for a socket', () => {
  it('accepts only the exact origin we published', () => {
    expect(originAllowed(ORIGIN, ORIGIN)).toBe(true);
  });

  it('refuses one that merely starts the same way', () => {
    expect(originAllowed('https://nimbus.local.evil.com', ORIGIN)).toBe(false);
  });

  it('refuses one that merely ends the same way', () => {
    expect(originAllowed('https://evil.com/https://nimbus.local', ORIGIN)).toBe(false);
  });

  it('refuses a missing origin, because a browser always sends one', () => {
    expect(originAllowed(undefined, ORIGIN)).toBe(false);
  });

  it('refuses a different scheme or port on the same host', () => {
    expect(originAllowed('http://nimbus.local', ORIGIN)).toBe(false);
    expect(originAllowed('https://nimbus.local:8443', ORIGIN)).toBe(false);
  });
});

describe('reading the cookie off a handshake', () => {
  const name = sessionCookieName(false);

  it('finds it among others', () => {
    expect(readCookie(`other=1; ${name}=abc; more=2`, name)).toBe('abc');
  });

  it('does not match a cookie whose name merely contains it', () => {
    expect(readCookie(`x${name}=abc`, name)).toBe('');
  });

  it('is empty when there are no cookies at all', () => {
    expect(readCookie(undefined, name)).toBe('');
  });
});

describe('checkHandshake', () => {
  const options = { sessions: reader(login()), allowedOrigin: ORIGIN, isProduction: false };

  it('lets a signed in person through', async () => {
    const request = upgrade({
      origin: ORIGIN,
      cookie: `${sessionCookieName(false)}=login-id`,
    });

    expect((await checkHandshake(request, options)).ok).toBe(true);
  });

  it('refuses another site holding the same cookie', async () => {
    const request = upgrade({
      origin: 'https://evil.example',
      cookie: `${sessionCookieName(false)}=login-id`,
    });
    const result = await checkHandshake(request, options);

    expect(result.ok).toBe(false);
    expect(result.ok ? null : result.refusal).toBe('wrong_origin');
  });

  it('refuses a request with no cookie', async () => {
    const result = await checkHandshake(upgrade({ origin: ORIGIN }), options);

    expect(result.ok ? null : result.refusal).toBe('no_cookie');
  });

  it('refuses a cookie whose login has gone', async () => {
    const request = upgrade({
      origin: ORIGIN,
      cookie: `${sessionCookieName(false)}=login-id`,
    });

    const result = await checkHandshake(request, {
      ...options,
      sessions: reader(null),
    });

    expect(result.ok ? null : result.refusal).toBe('no_login');
  });

  it('checks the origin before it ever looks at the cookie', async () => {
    let asked = false;
    const watching: SessionReader = {
      load: async () => {
        asked = true;
        return Promise.resolve(login());
      },
    };

    await checkHandshake(upgrade({ origin: 'https://evil.example', cookie: 'x=1' }), {
      ...options,
      sessions: watching,
    });

    expect(asked).toBe(false);
  });
});

describe('sequences', () => {
  it('start at one and increase by one', async () => {
    const store = new InMemoryEventStore();

    const first = await store.append(SESSION_ID, USER_ID, message());
    const second = await store.append(SESSION_ID, USER_ID, message());

    expect(first.sequence).toBe(1);
    expect(second.sequence).toBe(2);
  });

  it('are counted per session, not across all of them', async () => {
    const store = new InMemoryEventStore();
    const other = 'ses_bbbbbbbbbbbbbbbbbbbbb';

    await store.append(SESSION_ID, USER_ID, message());
    const theirs = await store.append(other, USER_ID, message());

    expect(theirs.sequence).toBe(1);
  });

  it('are remembered, so a reader can ask what the latest is', async () => {
    const store = new InMemoryEventStore();
    await store.append(SESSION_ID, USER_ID, message());
    await store.append(SESSION_ID, USER_ID, message());

    expect(await store.lastSequence(SESSION_ID)).toBe(2);
  });
});

describe('asking for everything after a sequence', () => {
  async function filled(): Promise<InMemoryEventStore> {
    const store = new InMemoryEventStore();

    for (let index = 0; index < 5; index += 1) {
      await store.append(SESSION_ID, USER_ID, message());
    }
    return store;
  }

  it('gives the whole history when asked from nothing', async () => {
    expect(await (await filled()).since(SESSION_ID, 0)).toHaveLength(5);
  });

  it('gives only what came after', async () => {
    const page = await (await filled()).since(SESSION_ID, 3);

    expect(page.map((one) => one.sequence)).toEqual([4, 5]);
  });

  it('gives nothing when there is nothing newer', async () => {
    expect(await (await filled()).since(SESSION_ID, 99)).toHaveLength(0);
  });

  it('never mixes in another session', async () => {
    const store = await filled();
    await store.append('ses_bbbbbbbbbbbbbbbbbbbbb', USER_ID, message());

    const page = await store.since(SESSION_ID, 0);

    expect(page.every((one) => one.sessionId === SESSION_ID)).toBe(true);
  });
});

describe('a subscription joining history to live', () => {
  function held(from: number): {
    store: InMemoryEventStore;
    delivered: SessionEventEnvelope[];
    subscription: Subscription;
  } {
    const store = new InMemoryEventStore();
    const delivered: SessionEventEnvelope[] = [];

    return {
      store,
      delivered,
      subscription: new Subscription({
        sessionId: SESSION_ID,
        from,
        store,
        deliver: (envelope) => delivered.push(envelope),
      }),
    };
  }

  it('replays in order', async () => {
    const one = held(0);

    for (let index = 0; index < 4; index += 1) {
      await one.store.append(SESSION_ID, USER_ID, message());
    }

    await one.subscription.replay();

    expect(one.delivered.map((each) => each.sequence)).toEqual([1, 2, 3, 4]);
  });

  it('holds live events until the replay is done, then sends them', async () => {
    const one = held(0);
    await one.store.append(SESSION_ID, USER_ID, message());

    const live = await one.store.append(SESSION_ID, USER_ID, message());
    one.subscription.offer(live);

    expect(one.delivered).toHaveLength(0);

    await one.subscription.replay();

    expect(one.delivered.map((each) => each.sequence)).toEqual([1, 2]);
  });

  it('never sends the same event twice across that join', async () => {
    const one = held(0);
    const first = await one.store.append(SESSION_ID, USER_ID, message());

    one.subscription.offer(first);
    await one.subscription.replay();

    expect(one.delivered.map((each) => each.sequence)).toEqual([1]);
  });

  it('sends live events straight through once it has caught up', async () => {
    const one = held(0);
    await one.subscription.replay();

    one.subscription.offer(await one.store.append(SESSION_ID, USER_ID, message()));

    expect(one.delivered).toHaveLength(1);
  });

  it('starts from where a reconnecting client left off', async () => {
    const one = held(2);

    for (let index = 0; index < 4; index += 1) {
      await one.store.append(SESSION_ID, USER_ID, message());
    }

    await one.subscription.replay();

    expect(one.delivered.map((each) => each.sequence)).toEqual([3, 4]);
  });

  it('ignores an event belonging to another session', async () => {
    const one = held(0);
    await one.subscription.replay();

    one.subscription.offer(await one.store.append('ses_bbbbbbbbbbbbbbbbbbbbb', USER_ID, message()));

    expect(one.delivered).toHaveLength(0);
  });

  it('sends nothing once it is closed', async () => {
    const one = held(0);
    await one.subscription.replay();
    one.subscription.close();

    one.subscription.offer(await one.store.append(SESSION_ID, USER_ID, message()));

    expect(one.delivered).toHaveLength(0);
  });

  it('walks past a page boundary rather than stopping at one', async () => {
    const store = new InMemoryEventStore();
    const delivered: SessionEventEnvelope[] = [];

    for (let index = 0; index < 7; index += 1) {
      await store.append(SESSION_ID, USER_ID, message());
    }

    const subscription = new Subscription({
      sessionId: SESSION_ID,
      from: 0,
      store,
      deliver: (envelope) => delivered.push(envelope),
      pageSize: 2,
    });

    await subscription.replay();

    expect(delivered.map((each) => each.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });
});

describe('reading an envelope off the channel', () => {
  it('accepts one we wrote', async () => {
    const store = new InMemoryEventStore();
    const envelope = await store.append(SESSION_ID, USER_ID, message());

    expect(readEnvelope(JSON.stringify(envelope))).toEqual(envelope);
  });

  it('refuses something that is not JSON', () => {
    expect(readEnvelope('not json at all')).toBeNull();
  });

  it('refuses an envelope that is the wrong shape', () => {
    expect(readEnvelope(JSON.stringify({ sequence: 1 }))).toBeNull();
  });

  it('refuses one carrying an event nobody defined', () => {
    const bogus = {
      v: 1,
      sequence: 1,
      sessionId: SESSION_ID,
      emittedAt: '2026-08-15T10:00:00.000Z',
      event: { type: 'session.explode' },
    };

    expect(readEnvelope(JSON.stringify(bogus))).toBeNull();
  });
});

describe('the collecting publisher, which the tests use', () => {
  it('remembers what a run said', async () => {
    const publisher = new CollectingEventPublisher();

    await publisher.publish(SESSION_ID, USER_ID, message());
    await publisher.publish(SESSION_ID, USER_ID, { type: 'files.changed', files: [] });

    expect(publisher.typesFor(SESSION_ID)).toEqual(['agent.message', 'files.changed']);
  });
});
