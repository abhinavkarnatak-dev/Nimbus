import type { AttachmentStore, StoredObject } from './store.js';

export interface FakeStoreOptions {
  failOnPut?: boolean;
  failOnRemove?: boolean;
}

export class FakeAttachmentStore implements AttachmentStore {
  readonly objects = new Map<string, StoredObject>();
  readonly putKeys: string[] = [];
  readonly removedKeys: string[] = [];

  private readonly options: FakeStoreOptions;

  constructor(options: FakeStoreOptions = {}) {
    this.options = options;
  }

  async put(key: string, bytes: Buffer, contentType: string): Promise<void> {
    if (this.options.failOnPut === true) {
      throw new Error('storage refused the upload');
    }
    this.objects.set(key, { bytes: Buffer.from(bytes), contentType });
    this.putKeys.push(key);
    return Promise.resolve();
  }

  async get(key: string): Promise<StoredObject | null> {
    const found = this.objects.get(key);
    return Promise.resolve(found ?? null);
  }

  async remove(key: string): Promise<void> {
    if (this.options.failOnRemove === true) {
      throw new Error('storage refused the deletion');
    }
    this.objects.delete(key);
    this.removedKeys.push(key);
    return Promise.resolve();
  }
}
