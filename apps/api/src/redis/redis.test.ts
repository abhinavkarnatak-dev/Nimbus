import { describe, expect, it } from 'vitest';

import { describeRedisUrl, retryDelay, RETRY_MAX_DELAY_MS } from './client.js';
import { InvalidKeySegmentError, buildKey, namespacePattern, NAMESPACES } from './keys.js';

describe('describeRedisUrl', () => {
  it('keeps host and database number for a plain local url', () => {
    expect(describeRedisUrl('redis://127.0.0.1:6379')).toBe('127.0.0.1:6379');
    expect(describeRedisUrl('redis://127.0.0.1:6379/3')).toBe('127.0.0.1:6379/3');
  });

  it('drops the username and password', () => {
    const description = describeRedisUrl('redis://default:hunter2@cache.example.com:6379');

    expect(description).toBe('cache.example.com:6379');
    expect(description).not.toContain('hunter2');
    expect(description).not.toContain('default');
  });

  it('drops a password containing an at sign', () => {
    const description = describeRedisUrl('redis://user:p%40ss@word@cache.example.com:6379/2');

    expect(description).toBe('cache.example.com:6379/2');
    expect(description).not.toContain('ss@word');
  });

  it('handles the tls scheme', () => {
    expect(describeRedisUrl('rediss://user:secret@cache.example.com:6380')).toBe(
      'cache.example.com:6380',
    );
  });

  it('drops query options that can carry secrets', () => {
    const description = describeRedisUrl('redis://u:secret@host:6379/0?password=alsosecret');

    expect(description).toBe('host:6379/0');
    expect(description).not.toContain('alsosecret');
  });

  it('never throws on unusable input', () => {
    expect(describeRedisUrl('')).toBe('unknown-host');
    expect(describeRedisUrl('redis://')).toBe('unknown-host');
  });
});

describe('retryDelay', () => {
  it('waits longer after each failed attempt', () => {
    expect(retryDelay(1)).toBeLessThan(retryDelay(2));
    expect(retryDelay(2)).toBeLessThan(retryDelay(5));
  });

  it('stops growing at a ceiling so a dead server is not hammered forever', () => {
    expect(retryDelay(1_000)).toBe(RETRY_MAX_DELAY_MS);
  });
});

describe('key building', () => {
  it('puts every key under the application namespace', () => {
    expect(buildKey(NAMESPACES.otp, 'req_abc')).toBe('nimbus:otp:req_abc');
    expect(buildKey(NAMESPACES.rateLimit, 'otp-request', 'usr_abc')).toBe(
      'nimbus:rate:otp-request:usr_abc',
    );
  });

  it('builds a pattern that matches only one namespace', () => {
    expect(namespacePattern(NAMESPACES.lease)).toBe('nimbus:lease:*');
  });

  const rejected = [
    ['an empty segment', ''],
    ['a segment with a colon that would fake a namespace', 'usr:admin'],
    ['a segment with a glob that would match other keys', 'usr_*'],
    ['a segment with a space', 'usr abc'],
    ['a segment with cluster hash braces', 'usr{abc}'],
  ] as const;

  for (const [label, segment] of rejected) {
    it(`refuses ${label}`, () => {
      expect(() => buildKey(NAMESPACES.session, segment)).toThrow(InvalidKeySegmentError);
    });
  }
});
