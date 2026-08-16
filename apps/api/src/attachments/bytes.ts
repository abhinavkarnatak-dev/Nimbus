import type { AttachmentDocument } from '../db/models/attachment.js';
import type { ImageBytes } from '../routing/describe.js';
import type { AttachmentStore } from './store.js';

export class MissingObjectError extends Error {
  readonly storageKey: string;

  constructor(storageKey: string) {
    super('That attachment is recorded but its stored bytes are gone.');
    this.name = 'MissingObjectError';
    this.storageKey = storageKey;
  }
}

export class StoredAttachmentBytes implements ImageBytes {
  readonly #store: AttachmentStore;

  constructor(store: AttachmentStore) {
    this.#store = store;
  }

  async read(document: AttachmentDocument): Promise<Buffer> {
    const found = await this.#store.get(document.storageKey);

    if (found === null) {
      throw new MissingObjectError(document.storageKey);
    }
    return found.bytes;
  }
}
