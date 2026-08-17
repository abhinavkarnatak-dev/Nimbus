import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { SecretBox, SecretBoxError, SECRET_BOX_KEY_BYTES } from './secret-box.js';

const KEY = randomBytes(SECRET_BOX_KEY_BYTES);
const OTHER_KEY = randomBytes(SECRET_BOX_KEY_BYTES);
const SECRET = 'AIza-a-key-that-should-never-be-readable-in-the-database';

describe('a sealed secret', () => {
  it('comes back exactly as it went in', () => {
    const box = new SecretBox(KEY);
    const sealed = box.seal(SECRET, 'usr_one:gemini');

    expect(box.open(sealed, 'usr_one:gemini')).toBe(SECRET);
  });

  it('never carries the plain value in any of its parts', () => {
    const sealed = new SecretBox(KEY).seal(SECRET, 'usr_one:gemini');

    expect(JSON.stringify(sealed)).not.toContain(SECRET);
    expect(JSON.stringify(sealed)).not.toContain('AIza');
  });

  it('seals the same value differently every time', () => {
    const box = new SecretBox(KEY);

    expect(box.seal(SECRET, 'usr_one:gemini').ciphertext).not.toBe(
      box.seal(SECRET, 'usr_one:gemini').ciphertext,
    );
  });

  it('refuses to open under a different binding, so a row cannot be moved between accounts', () => {
    const box = new SecretBox(KEY);
    const sealed = box.seal(SECRET, 'usr_one:gemini');

    expect(() => box.open(sealed, 'usr_two:gemini')).toThrow(SecretBoxError);
    expect(() => box.open(sealed, 'usr_one:other')).toThrow(SecretBoxError);
  });

  it('refuses to open under a different key', () => {
    const sealed = new SecretBox(KEY).seal(SECRET, 'usr_one:gemini');

    expect(() => new SecretBox(OTHER_KEY).open(sealed, 'usr_one:gemini')).toThrow(SecretBoxError);
  });

  it('refuses a tampered ciphertext', () => {
    const box = new SecretBox(KEY);
    const sealed = box.seal(SECRET, 'usr_one:gemini');
    const flipped = Buffer.from(sealed.ciphertext, 'base64');
    flipped[0] = (flipped[0] ?? 0) ^ 0xff;

    expect(() =>
      box.open({ ...sealed, ciphertext: flipped.toString('base64') }, 'usr_one:gemini'),
    ).toThrow(SecretBoxError);
  });

  it('refuses a version it does not know', () => {
    const box = new SecretBox(KEY);
    const sealed = box.seal(SECRET, 'usr_one:gemini');

    expect(() => box.open({ ...sealed, version: 99 }, 'usr_one:gemini')).toThrow(SecretBoxError);
  });

  it('refuses a key of the wrong size', () => {
    expect(() => new SecretBox(randomBytes(16))).toThrow(SecretBoxError);
  });

  it('never repeats the secret in the error it throws', () => {
    const box = new SecretBox(KEY);
    const sealed = box.seal(SECRET, 'usr_one:gemini');

    try {
      box.open(sealed, 'usr_two:gemini');
      expect.unreachable('opening under the wrong binding should have thrown');
    } catch (error) {
      expect(JSON.stringify(error, Object.getOwnPropertyNames(error))).not.toContain(SECRET);
    }
  });
});
