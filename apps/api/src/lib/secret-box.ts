import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export const SECRET_BOX_ALGORITHM = 'aes-256-gcm';
export const SECRET_BOX_IV_BYTES = 12;
export const SECRET_BOX_KEY_BYTES = 32;
export const SECRET_BOX_VERSION = 1;

export interface SealedSecret {
  version: number;
  iv: string;
  ciphertext: string;
  authTag: string;
}

export class SecretBoxError extends Error {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'SecretBoxError';
  }
}

export class SecretBox {
  readonly #key: Buffer;

  constructor(key: Buffer) {
    if (key.byteLength !== SECRET_BOX_KEY_BYTES) {
      throw new SecretBoxError('A secret box needs a 32 byte key.');
    }
    this.#key = key;
  }

  seal(plaintext: string, boundTo: string): SealedSecret {
    const iv = randomBytes(SECRET_BOX_IV_BYTES);
    const cipher = createCipheriv(SECRET_BOX_ALGORITHM, this.#key, iv);
    cipher.setAAD(Buffer.from(boundTo, 'utf8'));

    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);

    return {
      version: SECRET_BOX_VERSION,
      iv: iv.toString('base64'),
      ciphertext: ciphertext.toString('base64'),
      authTag: cipher.getAuthTag().toString('base64'),
    };
  }

  open(sealed: SealedSecret, boundTo: string): string {
    if (sealed.version !== SECRET_BOX_VERSION) {
      throw new SecretBoxError('That secret was sealed by a version Nimbus cannot open.');
    }

    try {
      const decipher = createDecipheriv(
        SECRET_BOX_ALGORITHM,
        this.#key,
        Buffer.from(sealed.iv, 'base64'),
      );
      decipher.setAAD(Buffer.from(boundTo, 'utf8'));
      decipher.setAuthTag(Buffer.from(sealed.authTag, 'base64'));

      return Buffer.concat([
        decipher.update(Buffer.from(sealed.ciphertext, 'base64')),
        decipher.final(),
      ]).toString('utf8');
    } catch (error) {
      throw new SecretBoxError('That secret could not be opened.', { cause: error });
    }
  }
}
