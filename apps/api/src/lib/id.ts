import { randomBytes } from 'node:crypto';

const ID_BODY_LENGTH = 21;

export function randomIdBody(): string {
  return randomBytes(24).toString('base64url').slice(0, ID_BODY_LENGTH);
}

export function newPrefixedId(prefix: string): string {
  return `${prefix}_${randomIdBody()}`;
}
