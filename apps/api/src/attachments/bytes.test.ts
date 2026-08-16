import { describe, expect, it } from 'vitest';

import { attachment } from '../routing/routing.fixtures.js';
import { MissingObjectError, StoredAttachmentBytes } from './bytes.js';
import { FakeAttachmentStore } from './fake-store.js';

describe('reading the bytes a person uploaded', () => {
  it('hands back exactly what was stored under that key', async () => {
    const document = attachment();
    const store = new FakeAttachmentStore();
    await store.put(document.storageKey, Buffer.from('a screenshot'), document.mimeType);

    const read = await new StoredAttachmentBytes(store).read(document);

    expect(read.toString('utf8')).toBe('a screenshot');
  });

  it('says the object is gone rather than handing back nothing', async () => {
    const document = attachment();

    await expect(
      new StoredAttachmentBytes(new FakeAttachmentStore()).read(document),
    ).rejects.toThrow(MissingObjectError);
  });

  it('names the key it could not find, so the record can be traced', async () => {
    const document = attachment();

    try {
      await new StoredAttachmentBytes(new FakeAttachmentStore()).read(document);
      expect.unreachable('reading a missing object should throw');
    } catch (error) {
      expect((error as MissingObjectError).storageKey).toBe(document.storageKey);
    }
  });
});
