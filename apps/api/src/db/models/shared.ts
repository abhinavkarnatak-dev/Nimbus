import type { Document, IndexDescription } from 'mongodb';

export interface ModelDefinition {
  readonly name: string;
  readonly validator: Document;
  readonly indexes: readonly IndexDescription[];
}

export function publicIdPattern(prefix: string): string {
  return `^${prefix}_[0-9A-Za-z_-]{21}$`;
}

export const COMMIT_SHA_PATTERN = '^[0-9a-f]{40}$';
export const ACTION_HASH_PATTERN = '^[0-9a-f]{64}$';

export const OBJECT_ID_PROPERTY = { bsonType: 'objectId' } as const;

export function toIsoTimestamp(value: Date): string {
  return value.toISOString();
}

export function toIsoTimestampOrNull(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

export function daysFromNow(days: number, from: Date = new Date()): Date {
  return new Date(from.getTime() + days * 24 * 60 * 60 * 1000);
}
