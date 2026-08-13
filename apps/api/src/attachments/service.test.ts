import { LIMITS } from '@nimbus/contracts';
import { beforeEach, describe, expect, it } from 'vitest';

import { ApiError } from '../http/api-error.js';
import {
  bytesOf,
  jpegBytes,
  newUserId,
  pngBytes,
  pngWithTrailer,
  textBytes,
  webpBytes,
} from './attachment.fixtures.js';
import { FakeAttachmentStore } from './fake-store.js';
import { InMemoryAttachmentRecords } from './repository.js';
import { AttachmentService, type UploadRequest } from './service.js';

let records: InMemoryAttachmentRecords;
let store: FakeAttachmentStore;
let service: AttachmentService;
let userId: string;
let clock: Date;

beforeEach(() => {
  records = new InMemoryAttachmentRecords();
  store = new FakeAttachmentStore();
  clock = new Date('2026-08-14T10:00:00.000Z');
  userId = newUserId();
  service = new AttachmentService({
    records,
    store,
    maxBytes: LIMITS.maxAttachmentBytes,
    now: () => clock,
  });
});

function upload(overrides: Partial<UploadRequest> & { bytes: Buffer }): Promise<unknown> {
  return service.upload({
    userId,
    declaredMimeType: 'image/png',
    originalName: 'shot.png',
    ...overrides,
  });
}

async function codeOf(work: () => Promise<unknown>): Promise<string> {
  try {
    await work();
  } catch (error) {
    return error instanceof ApiError ? error.code : 'NOT_AN_API_ERROR';
  }
  return 'NO_ERROR';
}

describe('accepting good uploads', () => {
  it('accepts a png and returns its metadata', async () => {
    const attachment = await service.upload({
      userId,
      declaredMimeType: 'image/png',
      originalName: 'shot.png',
      bytes: await pngBytes(),
    });

    expect(attachment).toMatchObject({
      kind: 'image',
      mimeType: 'image/png',
      originalName: 'shot.png',
      createdAt: '2026-08-14T10:00:00.000Z',
    });
    expect(store.putKeys).toHaveLength(1);
  });

  it('accepts a jpeg, a webp, plain text and markdown', async () => {
    await service.upload({
      userId,
      declaredMimeType: 'image/jpeg',
      originalName: 'a.jpg',
      bytes: await jpegBytes(),
    });
    await service.upload({
      userId,
      declaredMimeType: 'image/webp',
      originalName: 'b.webp',
      bytes: await webpBytes(),
    });
    await service.upload({
      userId,
      declaredMimeType: 'text/plain',
      originalName: 'c.txt',
      bytes: textBytes('an error happened'),
    });
    await service.upload({
      userId,
      declaredMimeType: 'text/markdown',
      originalName: 'd.md',
      bytes: textBytes('# notes'),
    });

    expect(records.documents).toHaveLength(4);
  });

  it('ignores extra parameters on the declared type', async () => {
    const attachment = await service.upload({
      userId,
      declaredMimeType: 'TEXT/Plain; charset=utf-8',
      originalName: 'c.txt',
      bytes: textBytes('hello'),
    });

    expect(attachment).toMatchObject({ mimeType: 'text/plain' });
  });

  it('records the size of the rebuilt file, not the uploaded one', async () => {
    const polyglot = await pngWithTrailer('x'.repeat(5000));
    await upload({ bytes: polyglot });

    const stored = records.documents[0];
    expect(stored?.byteSize).toBeLessThan(polyglot.byteLength);
    expect(stored?.byteSize).toBe(store.objects.get(stored?.storageKey ?? '')?.bytes.byteLength);
  });
});

describe('storage names', () => {
  it('never contains any part of the name the user chose', async () => {
    await upload({ originalName: 'secret-project-plan.png', bytes: await pngBytes() });

    const key = store.putKeys[0] ?? '';
    expect(key).not.toContain('secret');
    expect(key).toMatch(/^attachments\/usr_[0-9A-Za-z_-]{21}\/att_[0-9A-Za-z_-]{21}$/);
  });

  it('gives the same file two different names when uploaded twice', async () => {
    const bytes = await pngBytes();
    await upload({ bytes });
    await upload({ bytes });

    expect(store.putKeys[0]).not.toBe(store.putKeys[1]);
  });

  it('keeps the name the user chose only as escaped metadata', async () => {
    await upload({ originalName: '../../etc/passwd.png', bytes: await pngBytes() });
    expect(records.documents[0]?.originalName).toBe('passwd.png');
  });
});

describe('refusing bad uploads', () => {
  it('refuses a type that is not on the list', async () => {
    const png = await pngBytes();
    expect(
      await codeOf(() =>
        upload({ declaredMimeType: 'image/gif', originalName: 'a.gif', bytes: png }),
      ),
    ).toBe('UNSUPPORTED_MEDIA_TYPE');
  });

  it('refuses a png name and png type carrying jpeg bytes', async () => {
    const jpeg = await jpegBytes();
    expect(await codeOf(() => upload({ bytes: jpeg }))).toBe('UNSUPPORTED_MEDIA_TYPE');
  });

  it('refuses an image whose name disagrees with its type', async () => {
    const png = await pngBytes();
    expect(await codeOf(() => upload({ originalName: 'shot.jpg', bytes: png }))).toBe(
      'UNSUPPORTED_MEDIA_TYPE',
    );
  });

  it('refuses a name with no extension at all', async () => {
    const png = await pngBytes();
    expect(await codeOf(() => upload({ originalName: 'shot', bytes: png }))).toBe(
      'UNSUPPORTED_MEDIA_TYPE',
    );
  });

  it('refuses a png hidden behind a text type', async () => {
    const png = await pngBytes();
    expect(
      await codeOf(() =>
        upload({ declaredMimeType: 'text/plain', originalName: 'a.txt', bytes: png }),
      ),
    ).toBe('UNSUPPORTED_MEDIA_TYPE');
  });

  it('refuses an svg however it is labelled', async () => {
    expect(
      await codeOf(() =>
        upload({
          declaredMimeType: 'text/plain',
          originalName: 'logo.txt',
          bytes: textBytes('<svg onload="alert(1)"></svg>'),
        }),
      ),
    ).toBe('UNSUPPORTED_MEDIA_TYPE');
  });

  it('refuses an html page sent as markdown', async () => {
    expect(
      await codeOf(() =>
        upload({
          declaredMimeType: 'text/markdown',
          originalName: 'page.md',
          bytes: textBytes('<!DOCTYPE html><body>hi</body>'),
        }),
      ),
    ).toBe('UNSUPPORTED_MEDIA_TYPE');
  });

  it('refuses a zip archive renamed to png', async () => {
    expect(await codeOf(() => upload({ bytes: bytesOf([0x50, 0x4b, 0x03, 0x04, 0x00]) }))).toBe(
      'UNSUPPORTED_MEDIA_TYPE',
    );
  });

  it('refuses a program renamed to png', async () => {
    expect(await codeOf(() => upload({ bytes: bytesOf([0x7f, 0x45, 0x4c, 0x46, 0x02]) }))).toBe(
      'UNSUPPORTED_MEDIA_TYPE',
    );
  });

  it('refuses an empty file', async () => {
    expect(await codeOf(() => upload({ bytes: Buffer.alloc(0) }))).toBe('ATTACHMENT_REJECTED');
  });

  it('refuses a file over the size limit', async () => {
    const small = new AttachmentService({ records, store, maxBytes: 64, now: () => clock });
    const failed = await codeOf(() =>
      small.upload({
        userId,
        declaredMimeType: 'text/plain',
        originalName: 'a.txt',
        bytes: textBytes('x'.repeat(500)),
      }),
    );
    expect(failed).toBe('PAYLOAD_TOO_LARGE');
  });

  it('stores nothing at all when a file is refused', async () => {
    const jpeg = await jpegBytes();
    await codeOf(() => upload({ bytes: jpeg }));
    expect(store.putKeys).toHaveLength(0);
    expect(records.documents).toHaveLength(0);
  });
});

describe('how many a person may hold', () => {
  it('refuses once the cap is reached', async () => {
    for (let index = 0; index < LIMITS.maxAttachmentsPerSession; index += 1) {
      await upload({ bytes: await pngBytes() });
    }

    const extra = await pngBytes();
    expect(await codeOf(() => upload({ bytes: extra }))).toBe('ATTACHMENT_REJECTED');
    expect(records.documents).toHaveLength(LIMITS.maxAttachmentsPerSession);
  });

  it('counts each person separately', async () => {
    for (let index = 0; index < LIMITS.maxAttachmentsPerSession; index += 1) {
      await upload({ bytes: await pngBytes() });
    }

    const somebodyElse = newUserId();
    await service.upload({
      userId: somebodyElse,
      declaredMimeType: 'image/png',
      originalName: 'shot.png',
      bytes: await pngBytes(),
    });

    expect(records.documents).toHaveLength(LIMITS.maxAttachmentsPerSession + 1);
  });
});

describe('reading an attachment back', () => {
  it('returns the stored bytes to its owner', async () => {
    const attachment = (await upload({ bytes: await pngBytes() })) as { attachmentId: string };
    const found = await service.download(userId, attachment.attachmentId);

    expect(found.document.mimeType).toBe('image/png');
    expect(found.object.bytes.byteLength).toBeGreaterThan(0);
  });

  it('hides an attachment belonging to somebody else behind a not found', async () => {
    const attachment = (await upload({ bytes: await pngBytes() })) as { attachmentId: string };

    expect(await codeOf(() => service.download(newUserId(), attachment.attachmentId))).toBe(
      'NOT_FOUND',
    );
  });

  it('reports not found when the record exists but the file does not', async () => {
    const attachment = (await upload({ bytes: await pngBytes() })) as { attachmentId: string };
    store.objects.clear();

    expect(await codeOf(() => service.download(userId, attachment.attachmentId))).toBe('NOT_FOUND');
  });
});

describe('deleting an attachment', () => {
  it('removes both the file and the record', async () => {
    const attachment = (await upload({ bytes: await pngBytes() })) as { attachmentId: string };
    await service.remove(userId, attachment.attachmentId);

    expect(records.documents).toHaveLength(0);
    expect(store.objects.size).toBe(0);
  });

  it('refuses to delete an attachment belonging to somebody else', async () => {
    const attachment = (await upload({ bytes: await pngBytes() })) as { attachmentId: string };

    expect(await codeOf(() => service.remove(newUserId(), attachment.attachmentId))).toBe(
      'NOT_FOUND',
    );
    expect(records.documents).toHaveLength(1);
  });
});

describe('clearing up what nobody claimed', () => {
  it('leaves a fresh upload alone', async () => {
    await upload({ bytes: await pngBytes() });
    expect(await service.removeExpired(10)).toHaveLength(0);
  });

  it('removes an upload once its time has passed', async () => {
    await upload({ bytes: await pngBytes() });

    clock = new Date('2026-08-16T10:00:00.000Z');
    const removed = await service.removeExpired(10);

    expect(removed).toHaveLength(1);
    expect(records.documents).toHaveLength(0);
    expect(store.objects.size).toBe(0);
  });

  it('leaves an attachment that belongs to a session alone', async () => {
    await upload({ bytes: await pngBytes() });
    const held = records.documents[0];
    if (held !== undefined) {
      held.sessionId = 'ses_000000000000000000001';
    }

    clock = new Date('2026-09-01T10:00:00.000Z');
    expect(await service.removeExpired(10)).toHaveLength(0);
    expect(records.documents).toHaveLength(1);
  });

  it('never removes more than it was asked to', async () => {
    for (let index = 0; index < 4; index += 1) {
      await upload({ bytes: await pngBytes() });
    }

    clock = new Date('2026-08-16T10:00:00.000Z');
    expect(await service.removeExpired(2)).toHaveLength(2);
    expect(records.documents).toHaveLength(2);
  });
});

describe('when storage misbehaves', () => {
  it('does not write a record if the file could not be stored', async () => {
    const failing = new AttachmentService({
      records,
      store: new FakeAttachmentStore({ failOnPut: true }),
      now: () => clock,
    });

    await expect(
      failing.upload({
        userId,
        declaredMimeType: 'image/png',
        originalName: 'shot.png',
        bytes: await pngBytes(),
      }),
    ).rejects.toThrow();

    expect(records.documents).toHaveLength(0);
  });
});
