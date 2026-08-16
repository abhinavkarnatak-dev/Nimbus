import { describe, expect, it } from 'vitest';

import { matchRoute, needsSignIn, normalisePath, pathFor, sessionPath } from './routes.js';

const SESSION_ID = `ses_${'a'.repeat(21)}`;
const MIXED_CASE_ID = `ses_${'aA1_-'.repeat(4)}b`;

describe('tidying a path before matching it', () => {
  it('drops a query and a hash', () => {
    expect(normalisePath('/dashboard?tab=history#top')).toBe('/dashboard');
  });

  it('drops a trailing slash without losing the root', () => {
    expect(normalisePath('/dashboard/')).toBe('/dashboard');
    expect(normalisePath('/')).toBe('/');
  });

  it('collapses repeated slashes', () => {
    expect(normalisePath('//sessions//abc')).toBe('/sessions/abc');
  });

  it('leaves the case alone, because an id is case sensitive', () => {
    expect(normalisePath('/sessions/AbC')).toBe('/sessions/AbC');
  });
});

describe('matching a path to a screen', () => {
  it('knows each of the fixed screens', () => {
    expect(matchRoute('/').name).toBe('landing');
    expect(matchRoute('/sign-in').name).toBe('sign_in');
    expect(matchRoute('/connect').name).toBe('connect');
    expect(matchRoute('/dashboard').name).toBe('dashboard');
  });

  it('reads a session id out of the path', () => {
    expect(matchRoute(sessionPath(SESSION_ID as never))).toStrictEqual({
      name: 'session',
      sessionId: SESSION_ID,
    });
  });

  it('reads an id with upper case letters in it', () => {
    expect(matchRoute(`/sessions/${MIXED_CASE_ID}`).name).toBe('session');
  });

  it('refuses something that only looks like a session id', () => {
    expect(matchRoute('/sessions/not-an-id').name).toBe('not_found');
    expect(matchRoute('/sessions/ses_short').name).toBe('not_found');
  });

  it('refuses a nested path under sessions', () => {
    expect(matchRoute(`/sessions/${SESSION_ID}/files`).name).toBe('not_found');
  });

  it('keeps the path it could not match, so the page can show it', () => {
    expect(matchRoute('/nowhere')).toStrictEqual({ name: 'not_found', path: '/nowhere' });
  });
});

describe('turning a screen back into a path', () => {
  it('round trips every fixed screen', () => {
    for (const path of ['/', '/sign-in', '/connect', '/dashboard']) {
      expect(pathFor(matchRoute(path))).toBe(path);
    }
  });

  it('round trips a session', () => {
    const path = sessionPath(SESSION_ID as never);

    expect(pathFor(matchRoute(path))).toBe(path);
  });
});

describe('which screens need somebody signed in', () => {
  it('lets the landing and sign in screens through', () => {
    expect(needsSignIn(matchRoute('/'))).toBe(false);
    expect(needsSignIn(matchRoute('/sign-in'))).toBe(false);
  });

  it('does not send a wrong path to sign in, because that hides the mistake', () => {
    expect(needsSignIn(matchRoute('/nowhere'))).toBe(false);
  });

  it('guards everything that shows somebody their own work', () => {
    expect(needsSignIn(matchRoute('/connect'))).toBe(true);
    expect(needsSignIn(matchRoute('/dashboard'))).toBe(true);
    expect(needsSignIn(matchRoute(sessionPath(SESSION_ID as never)))).toBe(true);
  });
});
