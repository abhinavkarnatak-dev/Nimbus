import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { createTestDatabase, type TestDatabase } from '@nimbus/test-utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  jpegBytes,
  newUserId,
  pngBytes,
  textBytes,
} from '../../src/attachments/attachment.fixtures.js';
import { MongoAttachmentRecords } from '../../src/attachments/repository.js';
import { S3AttachmentStore } from '../../src/attachments/s3-store.js';
import { AttachmentService } from '../../src/attachments/service.js';
import type { StorageConfig } from '../../src/config/load.js';
import { ensureDatabaseSchema } from '../../src/db/bootstrap.js';
import { attachmentsCollection } from '../../src/db/models/attachment.js';
import { ApiError } from '../../src/http/api-error.js';

const BUCKET = `nimbus-test-${String(Date.now())}`;

const storageConfig: StorageConfig = {
  endpoint: process.env['TEST_S3_ENDPOINT'] ?? 'http://127.0.0.1:9000',
  region: 'auto',
  bucket: BUCKET,
  accessKeyId: process.env['TEST_S3_ACCESS_KEY_ID'] ?? 'nimbus-local',
  secretAccessKey: process.env['TEST_S3_SECRET_ACCESS_KEY'] ?? 'nimbus-local-secret',
};

let testDatabase: TestDatabase;
let store: S3AttachmentStore;
let service: AttachmentService;
let records: MongoAttachmentRecords;
let clock: Date;

async function createBucket(): Promise<void> {
  const client = new S3Client({
    endpoint: storageConfig.endpoint,
    region: storageConfig.region,
    forcePathStyle: true,
    credentials: {
      accessKeyId: storageConfig.accessKeyId,
      secretAccessKey: storageConfig.secretAccessKey,
    },
  });

  try {
    await client.send(new CreateBucketCommand({ Bucket: BUCKET }));
  } finally {
    client.destroy();
  }
}

beforeAll(async () => {
  await createBucket();

  testDatabase = await createTestDatabase('nimbus_attachments');
  await ensureDatabaseSchema(testDatabase.db);

  const s3 = new S3Client({
    endpoint: storageConfig.endpoint,
    region: storageConfig.region,
    forcePathStyle: true,
    credentials: {
      accessKeyId: storageConfig.accessKeyId,
      secretAccessKey: storageConfig.secretAccessKey,
    },
  });

  store = new S3AttachmentStore(storageConfig, s3);
  records = new MongoAttachmentRecords(testDatabase.db);
  clock = new Date('2026-08-14T10:00:00.000Z');
  service = new AttachmentService({ records, store, now: () => clock });
});

afterAll(async () => {
  store.destroy();
  await testDatabase.cleanup();
});

describe('a real upload against real storage and a real database', () => {
  it('stores an image, reads it back byte for byte, and deletes it', async () => {
    const userId = newUserId();
    const attachment = await service.upload({
      userId,
      declaredMimeType: 'image/png',
      originalName: 'shot.png',
      bytes: await pngBytes(24, 16),
    });

    const found = await service.download(userId, attachment.attachmentId);

    expect(found.object.contentType).toBe('image/png');
    expect(found.object.bytes.byteLength).toBe(attachment.byteSize);
    expect(found.document.width).toBe(24);
    expect(found.document.height).toBe(16);

    await service.remove(userId, attachment.attachmentId);

    await expect(service.download(userId, attachment.attachmentId)).rejects.toBeInstanceOf(
      ApiError,
    );
    expect(await store.get(found.document.storageKey)).toBeNull();
  });

  it('writes a record the database validator accepts', async () => {
    const userId = newUserId();
    const attachment = await service.upload({
      userId,
      declaredMimeType: 'text/markdown',
      originalName: 'notes.md',
      bytes: textBytes('# what went wrong\n\nthe button did nothing'),
    });

    const stored = await attachmentsCollection(testDatabase.db).findOne({
      attachmentId: attachment.attachmentId,
    });

    expect(stored).toMatchObject({
      userId,
      sessionId: null,
      kind: 'text',
      mimeType: 'text/markdown',
      originalName: 'notes.md',
    });
    expect(stored?.checksum).toMatch(/^[0-9a-f]{64}$/);
  });

  it('refuses a spoofed type before anything reaches storage', async () => {
    const userId = newUserId();

    await expect(
      service.upload({
        userId,
        declaredMimeType: 'image/png',
        originalName: 'shot.png',
        bytes: await jpegBytes(),
      }),
    ).rejects.toBeInstanceOf(ApiError);

    expect(await records.countUnclaimed(userId)).toBe(0);
  });

  it('will not hand one person the attachment of another', async () => {
    const owner = newUserId();
    const stranger = newUserId();

    const attachment = await service.upload({
      userId: owner,
      declaredMimeType: 'image/png',
      originalName: 'shot.png',
      bytes: await pngBytes(),
    });

    await expect(service.download(stranger, attachment.attachmentId)).rejects.toBeInstanceOf(
      ApiError,
    );
  });

  it('sweeps away an upload nobody claimed, from both places', async () => {
    const userId = newUserId();
    const attachment = await service.upload({
      userId,
      declaredMimeType: 'image/png',
      originalName: 'shot.png',
      bytes: await pngBytes(),
    });

    const stored = await attachmentsCollection(testDatabase.db).findOne({
      attachmentId: attachment.attachmentId,
    });
    const key = stored?.storageKey ?? '';

    clock = new Date('2026-08-20T10:00:00.000Z');
    const removed = await service.removeExpired(50);
    clock = new Date('2026-08-14T10:00:00.000Z');

    expect(removed).toContain(attachment.attachmentId);
    expect(await store.get(key)).toBeNull();
    expect(
      await attachmentsCollection(testDatabase.db).findOne({
        attachmentId: attachment.attachmentId,
      }),
    ).toBeNull();
  });
});
