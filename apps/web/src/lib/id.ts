const ID_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';

export const ID_BODY_LENGTH = 21;

export function randomIdBody(): string {
  const bytes = new Uint8Array(ID_BODY_LENGTH);
  globalThis.crypto.getRandomValues(bytes);

  return [...bytes].map((one) => ID_ALPHABET[one % ID_ALPHABET.length] ?? 'a').join('');
}

export function newPrefixedId(prefix: string): string {
  return `${prefix}_${randomIdBody()}`;
}
