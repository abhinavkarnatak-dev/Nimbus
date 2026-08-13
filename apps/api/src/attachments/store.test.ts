import { describe, expect, it } from 'vitest';

import { ApiError } from '../http/api-error.js';
import { FakeAttachmentStore } from './fake-store.js';
import { KEY_PREFIX, storageKey } from './store.js';

function codeOf(work: () => unknown): string {
  try {
    work();
  } catch (error) {
    return error instanceof ApiError ? error.code : 'NOT_AN_API_ERROR';
  }
  return 'NO_ERROR';
}

describe('storageKey', () => {
  it('puts every file under one prefix, owned by one person', () => {
    expect(storageKey('usr_aaaaaaaaaaaaaaaaaaaaa', 'att_bbbbbbbbbbbbbbbbbbbbb')).toBe(
      `${KEY_PREFIX}/usr_aaaaaaaaaaaaaaaaaaaaa/att_bbbbbbbbbbbbbbbbbbbbb`,
    );
  });

  const rejected = [
    '../escape',
    'usr_a/b',
    'usr_a\\b',
    '',
    'usr a',
    'usr_a.b',
    '.',
    'a'.repeat(80),
  ];

  for (const value of rejected) {
    it(`refuses to build a key from ${JSON.stringify(value)}`, () => {
      expect(codeOf(() => storageKey(value, 'att_bbbbbbbbbbbbbbbbbbbbb'))).toBe('INTERNAL_ERROR');
      expect(codeOf(() => storageKey('usr_aaaaaaaaaaaaaaaaaaaaa', value))).toBe('INTERNAL_ERROR');
    });
  }
});

describe('FakeAttachmentStore', () => {
  it('keeps a copy rather than the caller buffer', async () => {
    const store = new FakeAttachmentStore();
    const bytes = Buffer.from('hello');

    await store.put('a', bytes, 'text/plain');
    bytes.write('xxxxx');

    expect((await store.get('a'))?.bytes.toString('utf8')).toBe('hello');
  });

  it('returns nothing for a key it never saw', async () => {
    expect(await new FakeAttachmentStore().get('missing')).toBeNull();
  });

  it('forgets a key once removed', async () => {
    const store = new FakeAttachmentStore();
    await store.put('a', Buffer.from('x'), 'text/plain');
    await store.remove('a');

    expect(await store.get('a')).toBeNull();
    expect(store.removedKeys).toEqual(['a']);
  });
});
