export const REDACTED = '[redacted]';

const MAX_DEPTH = 8;
const MAX_ARRAY_ITEMS = 100;
const MAX_STRING_LENGTH = 4096;

const SECRET_SEGMENT_PATTERN =
  /(?:^|_)(?:password|passwd|secret|token|apikey|api_key|authorization|cookie|credential|credentials|privatekey|private_key|otp|passcode|pin|jwt|bearer|signature|salt)(?:_|$)/;

const ALLOWED_KEYS = new Set([
  'session_id',
  'token_count',
  'tokens_used',
  'total_tokens',
  'prompt_tokens',
  'completion_tokens',
  'csrf_token_present',
]);

const STRING_PATTERNS: readonly { pattern: RegExp; replacement: string }[] = [
  {
    pattern: /-----BEGIN[^-]*PRIVATE KEY-----[\s\S]*?-----END[^-]*PRIVATE KEY-----/g,
    replacement: REDACTED,
  },
  { pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}/g, replacement: REDACTED },
  {
    pattern: /\bgh[psour]_[A-Za-z0-9_-]{20,}(?:\.[A-Za-z0-9_-]+)*/g,
    replacement: REDACTED,
  },
  { pattern: /\bgsk_[A-Za-z0-9]{20,}/g, replacement: REDACTED },
  { pattern: /\bAIza[A-Za-z0-9_-]{30,}/g, replacement: REDACTED },
  { pattern: /\b(?:sk|rk)-[A-Za-z0-9_-]{16,}/g, replacement: REDACTED },
  {
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
    replacement: REDACTED,
  },
  {
    pattern: /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
    replacement: `$1 ${REDACTED}`,
  },
  {
    pattern: /\b([a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s:@/]+):[^\s@/]+@/g,
    replacement: `$1:${REDACTED}@`,
  },
  {
    pattern:
      /\b(password|passwd|secret|token|api[_-]?key|authorization|otp|passcode)\s*[=:]\s*("[^"]{4,}"|'[^']{4,}'|[^\s,;&})\]]{4,})/gi,
    replacement: `$1=${REDACTED}`,
  },
];

function normalizeKey(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

export function isSecretKey(key: string): boolean {
  const normalized = normalizeKey(key);
  if (ALLOWED_KEYS.has(normalized)) {
    return false;
  }
  return SECRET_SEGMENT_PATTERN.test(normalized);
}

export function redactString(value: string): string {
  let output =
    value.length > MAX_STRING_LENGTH ? `${value.slice(0, MAX_STRING_LENGTH)}...[truncated]` : value;
  for (const { pattern, replacement } of STRING_PATTERNS) {
    output = output.replace(pattern, replacement);
  }
  return output;
}

function redactAt(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (typeof value === 'string') {
    return redactString(value);
  }

  if (typeof value === 'bigint') {
    return value.toString();
  }

  if (value === null || typeof value !== 'object') {
    return value;
  }

  if (depth >= MAX_DEPTH) {
    return '[truncated]';
  }

  if (seen.has(value)) {
    return '[circular]';
  }
  seen.add(value);

  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactString(value.message),
      ...(value.stack === undefined ? {} : { stack: redactString(value.stack) }),
    };
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (Buffer.isBuffer(value)) {
    return `[Buffer ${String(value.byteLength)} bytes]`;
  }

  if (value instanceof Map || value instanceof Set) {
    return `[${value.constructor.name} ${String(value.size)} entries]`;
  }

  if (Array.isArray(value)) {
    const items: unknown[] = value
      .slice(0, MAX_ARRAY_ITEMS)
      .map((item) => redactAt(item, depth + 1, seen));
    if (value.length > MAX_ARRAY_ITEMS) {
      items.push(`[${String(value.length - MAX_ARRAY_ITEMS)} more items]`);
    }
    return items;
  }

  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    output[key] = isSecretKey(key) ? REDACTED : redactAt(item, depth + 1, seen);
  }
  return output;
}

export function redactValue(value: unknown): unknown {
  return redactAt(value, 0, new WeakSet());
}
