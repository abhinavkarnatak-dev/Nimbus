import { describe, expect, it } from 'vitest';

import { isSecretKey, redactSecrets, redactString, redactValue, REDACTED } from './redact.js';

describe('redacting without the log length cap', () => {
  it('still hides a secret far past where a log field would be cut', () => {
    const long = `${'x'.repeat(50_000)}\ntoken ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n`;

    expect(redactSecrets(long)).toContain(REDACTED);
    expect(redactSecrets(long)).not.toContain('ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  });

  it('keeps the whole string rather than trimming it', () => {
    const long = 'x'.repeat(50_000);

    expect(redactSecrets(long)).toHaveLength(50_000);
  });

  it('leaves clean text exactly as it was, so a caller can tell nothing was hidden', () => {
    const clean = 'all tests passed\n'.repeat(1_000);

    expect(redactSecrets(clean)).toBe(clean);
  });

  it('is what redactString does after the length cap, so logs are unchanged', () => {
    const long = `${'x'.repeat(50_000)} ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`;

    expect(redactString(long)).toContain('...[truncated]');
    expect(redactString(long).length).toBeLessThan(5_000);
  });
});

describe('secret key detection', () => {
  it('flags obvious secret keys in any casing style', () => {
    for (const key of [
      'password',
      'Password',
      'SMTP_PASSWORD',
      'accessToken',
      'access_token',
      'refreshToken',
      'apiKey',
      'API_KEY',
      'E2B_API_KEY',
      'authorization',
      'Authorization',
      'cookie',
      'Cookie',
      'set-cookie',
      'sessionSecret',
      'SESSION_SECRET',
      'GITHUB_WEBHOOK_SECRET',
      'privateKey',
      'GITHUB_APP_PRIVATE_KEY_BASE64',
      'otp',
      'otpCode',
      'clientSecret',
      'signature',
    ]) {
      expect(isSecretKey(key), `${key} should be treated as secret`).toBe(true);
    }
  });

  it('leaves harmless keys alone', () => {
    for (const key of [
      'sessionId',
      'session_id',
      'sessionTtlSeconds',
      'userId',
      'requestId',
      'actionHash',
      'headSha',
      'authProviders',
      'tokenCount',
      'totalTokens',
      'status',
      'repositoryId',
      'branch',
      'durationMs',
      'keyboardShortcut',
    ]) {
      expect(isSecretKey(key), `${key} should not be treated as secret`).toBe(false);
    }
  });
});

describe('secret patterns inside text', () => {
  it('removes GitHub tokens', () => {
    const output = redactString('cloning with ghs_abcdefghijklmnopqrstuvwxyz0123456789 now');
    expect(output).not.toContain('ghs_abcdefghijklmnopqrstuvwxyz0123456789');
    expect(output).toContain(REDACTED);
  });

  it('removes fine grained GitHub tokens', () => {
    const token = `github_pat_${'A'.repeat(40)}`;
    expect(redactString(`token=${token}`)).not.toContain(token);
  });

  it('removes credentials embedded in a URL but keeps the host', () => {
    const output = redactString('cloning https://octocat:hunter2secret@github.com/o/r.git');

    expect(output).not.toContain('hunter2secret');
    expect(output).toContain('github.com/o/r.git');
    expect(output).toContain('https://octocat');
  });

  it('removes bearer tokens but keeps the scheme', () => {
    const output = redactString('authorization header was Bearer abcdef1234567890xyz');

    expect(output).not.toContain('abcdef1234567890xyz');
    expect(output).toContain('Bearer');
  });

  it('removes JSON web tokens', () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
    expect(redactString(`cookie value ${jwt}`)).not.toContain(jwt);
  });

  it('removes private key blocks entirely', () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAKj34\n-----END RSA PRIVATE KEY-----';
    const output = redactString(`key is ${pem}`);

    expect(output).not.toContain('MIIBOgIBAAJBAKj34');
    expect(output).toBe(`key is ${REDACTED}`);
  });

  it('removes provider API keys', () => {
    for (const key of [`gsk_${'a'.repeat(40)}`, `AIza${'B'.repeat(35)}`, `sk-${'c'.repeat(32)}`]) {
      expect(redactString(`using ${key}`)).not.toContain(key);
    }
  });

  it('removes values written as key equals value', () => {
    expect(redactString('password=hunter2secret')).not.toContain('hunter2secret');
    expect(redactString('api_key: abcd1234efgh')).not.toContain('abcd1234efgh');
    expect(redactString('otp: 12345678')).not.toContain('12345678');
  });

  it('leaves ordinary sentences untouched', () => {
    for (const message of [
      'incoming request',
      'session moved from working to validating',
      'user authorization failed',
      'read 42 files from src/utils',
      'the token budget for this session is 100000',
      'https://github.com/octocat/hello-world',
      'commit 9f2c1a7b3d4e5f60718293a4b5c6d7e8f9012345',
    ]) {
      expect(redactString(message)).toBe(message);
    }
  });

  it('truncates very long text', () => {
    const output = redactString('x'.repeat(10_000));

    expect(output.length).toBeLessThan(10_000);
    expect(output).toContain('[truncated]');
  });
});

describe('redacting whole values', () => {
  it('replaces secret fields and keeps the rest', () => {
    const output = redactValue({
      userId: 'usr_0123456789abcdefghijk',
      password: 'hunter2',
      nested: { authorization: 'Bearer abcdefghijklmnop', status: 'ok' },
    }) as Record<string, unknown>;

    expect(output['userId']).toBe('usr_0123456789abcdefghijk');
    expect(output['password']).toBe(REDACTED);
    expect((output['nested'] as Record<string, unknown>)['authorization']).toBe(REDACTED);
    expect((output['nested'] as Record<string, unknown>)['status']).toBe('ok');
  });

  it('cleans an express style request object', () => {
    const output = JSON.stringify(
      redactValue({
        method: 'POST',
        url: '/sessions',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer secrettokenvalue123',
          cookie: 'nimbus_session=abc123def456',
        },
      }),
    );

    expect(output).not.toContain('secrettokenvalue123');
    expect(output).not.toContain('abc123def456');
    expect(output).toContain('/sessions');
    expect(output).toContain('application/json');
  });

  it('scans inside arrays', () => {
    const output = JSON.stringify(
      redactValue([{ token: 'abc' }, 'plain text', 'ghp_abcdefghijklmnopqrstuvwxyz012345']),
    );

    expect(output).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz012345');
    expect(output).toContain('plain text');
  });

  it('survives a circular object instead of crashing', () => {
    const circular: Record<string, unknown> = { name: 'loop' };
    circular['self'] = circular;

    expect(() => redactValue(circular)).not.toThrow();
    expect(JSON.stringify(redactValue(circular))).toContain('[circular]');
  });

  it('cleans error messages and keeps the error shape', () => {
    const output = redactValue(
      new Error('failed to clone https://user:secretpw@github.com/o/r'),
    ) as Record<string, unknown>;

    expect(output['name']).toBe('Error');
    expect(String(output['message'])).not.toContain('secretpw');
  });

  it('summarises buffers instead of dumping their contents', () => {
    expect(redactValue(Buffer.from('binary attachment content'))).toContain('[Buffer');
  });

  it('stops at a sensible depth', () => {
    let deep: Record<string, unknown> = { value: 'bottom' };
    for (let i = 0; i < 20; i += 1) {
      deep = { nested: deep };
    }

    expect(JSON.stringify(redactValue(deep))).toContain('[truncated]');
  });

  it('caps very long arrays', () => {
    const output = redactValue(Array.from({ length: 500 }, (_, i) => i)) as unknown[];

    expect(output.length).toBeLessThanOrEqual(101);
    expect(String(output.at(-1))).toContain('more items');
  });

  it('leaves plain values alone', () => {
    expect(redactValue(42)).toBe(42);
    expect(redactValue(true)).toBe(true);
    expect(redactValue(null)).toBeNull();
    expect(redactValue(undefined)).toBeUndefined();
  });
});
