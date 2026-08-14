import { describe, expect, it } from 'vitest';

import { ActionHashError, actionHash, canonical } from './hash.js';
import { POLICY_LIMITS } from './limits.js';

describe('canonical', () => {
  it('sorts keys, so the same action written two ways reads the same', () => {
    expect(canonical({ b: 2, a: 1 })).toBe(canonical({ a: 1, b: 2 }));
  });

  it('sorts keys at every depth', () => {
    expect(canonical({ outer: { z: 1, a: 2 } })).toBe(canonical({ outer: { a: 2, z: 1 } }));
  });

  it('keeps array order, because order is meaning in an array', () => {
    expect(canonical([1, 2])).not.toBe(canonical([2, 1]));
  });

  it('leaves out a field that is not there', () => {
    expect(canonical({ a: 1, b: undefined })).toBe(canonical({ a: 1 }));
  });

  it('keeps an explicit nothing, because null was written on purpose', () => {
    expect(canonical({ a: null })).not.toBe(canonical({}));
  });

  it('tells a number from the same number written as text', () => {
    expect(canonical({ a: 1 })).not.toBe(canonical({ a: '1' }));
  });

  it('refuses something it cannot hash', () => {
    expect(() => canonical({ run: () => undefined })).toThrow(ActionHashError);
  });

  it('refuses an action nested too deeply', () => {
    let nested: unknown = 'bottom';

    for (let depth = 0; depth <= POLICY_LIMITS.hashDepthMax + 2; depth += 1) {
      nested = { nested };
    }

    expect(() => canonical(nested)).toThrow(ActionHashError);
  });
});

describe('actionHash', () => {
  it('is the same for the same action', () => {
    expect(actionHash('read_file', { path: 'a.ts' })).toBe(
      actionHash('read_file', { path: 'a.ts' }),
    );
  });

  it('is the same when the arguments are written in a different order', () => {
    expect(actionHash('read_file', { path: 'a.ts', startLine: 1 })).toBe(
      actionHash('read_file', { startLine: 1, path: 'a.ts' }),
    );
  });

  it('changes when one argument changes', () => {
    expect(actionHash('read_file', { path: 'a.ts' })).not.toBe(
      actionHash('read_file', { path: 'b.ts' }),
    );
  });

  it('changes when an argument is added', () => {
    expect(actionHash('read_file', { path: 'a.ts' })).not.toBe(
      actionHash('read_file', { path: 'a.ts', startLine: 1 }),
    );
  });

  it('changes when the tool changes, even with the same arguments', () => {
    expect(actionHash('read_file', { path: 'a.ts' })).not.toBe(
      actionHash('create_file', { path: 'a.ts' }),
    );
  });

  it('notices a change buried deep in an argument', () => {
    expect(actionHash('apply_patch', { patch: 'a\nb\nc' })).not.toBe(
      actionHash('apply_patch', { patch: 'a\nb\nd' }),
    );
  });

  it('notices a single changed character in a long path', () => {
    const long = `src/${'deep/'.repeat(20)}file.ts`;

    expect(actionHash('read_file', { path: long })).not.toBe(
      actionHash('read_file', { path: `${long}x` }),
    );
  });

  it('looks like a sha256 digest', () => {
    expect(actionHash('read_file', { path: 'a.ts' })).toMatch(/^[0-9a-f]{64}$/);
  });
});
