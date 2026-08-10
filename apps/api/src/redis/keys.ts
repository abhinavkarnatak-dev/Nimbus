export const KEY_PREFIX = 'nimbus';

export const NAMESPACES = {
  otp: 'otp',
  session: 'session',
  rateLimit: 'rate',
  nonce: 'nonce',
  lease: 'lease',
  idempotency: 'idem',
} as const;

export type Namespace = (typeof NAMESPACES)[keyof typeof NAMESPACES];

const UNSAFE_SEGMENT = /[\s{}[\]:*?]/;

export class InvalidKeySegmentError extends Error {
  constructor(segment: string) {
    super(`Key segment is empty or contains a reserved character: ${JSON.stringify(segment)}`);
    this.name = 'InvalidKeySegmentError';
  }
}

export function assertSafeSegment(segment: string): void {
  if (segment === '' || UNSAFE_SEGMENT.test(segment)) {
    throw new InvalidKeySegmentError(segment);
  }
}

export function buildKey(namespace: Namespace, ...segments: string[]): string {
  for (const segment of segments) {
    assertSafeSegment(segment);
  }
  return [KEY_PREFIX, namespace, ...segments].join(':');
}

export function namespacePattern(namespace: Namespace): string {
  return `${KEY_PREFIX}:${namespace}:*`;
}
