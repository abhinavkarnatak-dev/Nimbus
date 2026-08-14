import { redactSecrets } from '../../logging/redact.js';
import { AgentStateError } from './errors.js';
import { STATE_LIMITS } from './limits.js';

export const CONNECTION_STRING_PATTERN =
  /\b(?:mongodb(?:\+srv)?|redis|rediss|amqp|postgres(?:ql)?|mysql):\/\//i;

export function toJson(value: unknown): string | undefined {
  return JSON.stringify(value);
}

export const FORBIDDEN_KEYS: readonly string[] = [
  'token',
  'accesstoken',
  'apikey',
  'secret',
  'password',
  'credential',
  'credentials',
  'authorization',
  'cookie',
  'privatekey',
  'client',
  'connection',
  'socket',
  'db',
];

function normalize(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function forbiddenKeyIn(value: unknown, depth = 0): string | null {
  if (depth > 12 || typeof value !== 'object' || value === null) {
    return null;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = forbiddenKeyIn(item, depth + 1);

      if (found !== null) {
        return found;
      }
    }
    return null;
  }

  for (const [key, item] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.includes(normalize(key))) {
      return key;
    }

    const found = forbiddenKeyIn(item, depth + 1);

    if (found !== null) {
      return found;
    }
  }
  return null;
}

export function assertPlainData(value: unknown, depth = 0): void {
  if (depth > 12 || value === null) {
    return;
  }

  if (typeof value === 'function') {
    throw new AgentStateError('STATE_INVALID', 'Agent state cannot hold a function.');
  }

  if (typeof value !== 'object') {
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      assertPlainData(item, depth + 1);
    }
    return;
  }

  const prototype = Object.getPrototypeOf(value) as object | null;

  if (prototype !== Object.prototype && prototype !== null) {
    throw new AgentStateError(
      'STATE_INVALID',
      'Agent state can only hold plain data, not a live object.',
      { detail: (value as { constructor?: { name?: string } }).constructor?.name ?? 'unknown' },
    );
  }

  for (const item of Object.values(value)) {
    assertPlainData(item, depth + 1);
  }
}

export function assertNoCredentials(serialized: string): void {
  if (redactSecrets(serialized) !== serialized) {
    throw new AgentStateError(
      'STATE_HOLDS_CREDENTIAL',
      'Agent state cannot be stored because something in it looks like a credential.',
    );
  }

  if (CONNECTION_STRING_PATTERN.test(serialized)) {
    throw new AgentStateError(
      'STATE_HOLDS_CREDENTIAL',
      'Agent state cannot hold a connection string.',
    );
  }
}

export function assertWithinSize(serialized: string): void {
  const bytes = Buffer.byteLength(serialized, 'utf8');

  if (bytes > STATE_LIMITS.checkpointMaxBytes) {
    throw new AgentStateError('STATE_TOO_LARGE', 'That agent state is too large to store.', {
      detail: `${String(bytes)} bytes`,
    });
  }
}

export function assertStorable(value: unknown): string {
  assertPlainData(value);

  const forbidden = forbiddenKeyIn(value);

  if (forbidden !== null) {
    throw new AgentStateError(
      'STATE_HOLDS_CREDENTIAL',
      'Agent state cannot hold a field with that name.',
      { detail: forbidden },
    );
  }

  const serialized = toJson(value);

  if (serialized === undefined) {
    throw new AgentStateError('STATE_INVALID', 'That agent state cannot be written down.');
  }

  assertNoCredentials(serialized);
  assertWithinSize(serialized);
  return serialized;
}
