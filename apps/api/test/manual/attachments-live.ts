import { HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import sharp from 'sharp';

import {
  jpegWithLocation,
  newUserId,
  pngBytes,
  textBytes,
} from '../../src/attachments/attachment.fixtures.js';
import { InMemoryAttachmentRecords } from '../../src/attachments/repository.js';
import { S3AttachmentStore } from '../../src/attachments/s3-store.js';
import { AttachmentService } from '../../src/attachments/service.js';
import type { StorageConfig } from '../../src/config/load.js';
import { ApiError } from '../../src/http/api-error.js';

const names = [
  'S3_ENDPOINT',
  'S3_REGION',
  'S3_BUCKET',
  'S3_ACCESS_KEY_ID',
  'S3_SECRET_ACCESS_KEY',
] as const;

function required(): StorageConfig | null {
  const missing = names.filter((name) => (process.env[name] ?? '').trim() === '');

  if (process.env['ATTACHMENTS_LIVE'] !== '1') {
    process.stdout.write('Set ATTACHMENTS_LIVE=1 to run this against real storage.\n');
    return null;
  }

  if (missing.length > 0) {
    process.stdout.write(`Missing in the environment: ${missing.join(', ')}\n`);
    return null;
  }

  const read = (name: (typeof names)[number]): string => process.env[name] ?? '';

  return {
    endpoint: read('S3_ENDPOINT'),
    region: read('S3_REGION'),
    bucket: read('S3_BUCKET'),
    accessKeyId: read('S3_ACCESS_KEY_ID'),
    secretAccessKey: read('S3_SECRET_ACCESS_KEY'),
  };
}

function heading(title: string): void {
  process.stdout.write(`\n${title}\n${'-'.repeat(title.length)}\n`);
}

function line(label: string, value: unknown): void {
  process.stdout.write(`${label.padEnd(34)}${String(value)}\n`);
}

async function outcomeOf(work: () => Promise<unknown>): Promise<string> {
  try {
    await work();
    return 'accepted';
  } catch (error) {
    return error instanceof ApiError ? `refused ${error.code}` : 'failed unexpectedly';
  }
}

async function main(): Promise<void> {
  const storage = required();

  if (storage === null) {
    return;
  }

  const store = new S3AttachmentStore(storage);
  const records = new InMemoryAttachmentRecords();
  let clock = new Date();
  const service = new AttachmentService({ records, store, now: () => clock });
  const userId = newUserId();

  const audit = new S3Client({
    endpoint: storage.endpoint,
    region: storage.region,
    credentials: {
      accessKeyId: storage.accessKeyId,
      secretAccessKey: storage.secretAccessKey,
    },
  });

  try {
    heading('Where this is going');
    line('endpoint host', new URL(storage.endpoint).host);
    line('bucket', storage.bucket);

    heading('A screenshot, uploaded for real');
    const shot = await service.upload({
      userId,
      declaredMimeType: 'image/png',
      originalName: 'bug shot.png',
      bytes: await pngBytes(640, 400),
    });
    line('attachment id', shot.attachmentId);
    line('kind and type', `${shot.kind} ${shot.mimeType}`);
    line('bytes stored', shot.byteSize);

    const storedShot = records.documents.find((held) => held.attachmentId === shot.attachmentId);
    line('storage name', storedShot?.storageKey);
    line('name holds nothing of the user', storedShot?.storageKey.includes('bug') === false);

    heading('What the bucket itself reports');
    const head = await audit.send(
      new HeadObjectCommand({ Bucket: storage.bucket, Key: storedShot?.storageKey ?? '' }),
    );
    line('content type', head.ContentType);
    line('content disposition', head.ContentDisposition);
    line('cache control', head.CacheControl);

    heading('Read back, byte for byte');
    const fetched = await service.download(userId, shot.attachmentId);
    line('bytes returned', fetched.object.bytes.byteLength);
    line('matches what we stored', fetched.object.bytes.byteLength === shot.byteSize);

    heading('Location data does not survive');
    const withGps = await jpegWithLocation();
    line('before, has exif', (await sharp(withGps).metadata()).exif !== undefined);
    const cleaned = await service.upload({
      userId,
      declaredMimeType: 'image/jpeg',
      originalName: 'holiday.jpg',
      bytes: withGps,
    });
    const cleanedBytes = (await service.download(userId, cleaned.attachmentId)).object.bytes;
    line('after, has exif', (await sharp(cleanedBytes).metadata()).exif !== undefined);

    heading('Things that are refused');
    line(
      'jpeg bytes calling itself a png',
      await outcomeOf(() =>
        service.upload({
          userId,
          declaredMimeType: 'image/png',
          originalName: 'shot.png',
          bytes: withGps,
        }),
      ),
    );
    line(
      'an svg',
      await outcomeOf(() =>
        service.upload({
          userId,
          declaredMimeType: 'text/plain',
          originalName: 'logo.txt',
          bytes: textBytes('<svg onload="alert(1)"/>'),
        }),
      ),
    );
    line(
      'a program renamed to png',
      await outcomeOf(() =>
        service.upload({
          userId,
          declaredMimeType: 'image/png',
          originalName: 'shot.png',
          bytes: Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01]),
        }),
      ),
    );
    line(
      'somebody else asking for it',
      await outcomeOf(() => service.download(newUserId(), shot.attachmentId)),
    );

    heading('Clearing up');
    clock = new Date(Date.now() + 48 * 60 * 60 * 1000);
    const swept = await service.removeExpired(50);
    line('removed by the sweeper', swept.length);
    line('records left', records.documents.length);

    let stillThere = true;
    try {
      await audit.send(
        new HeadObjectCommand({ Bucket: storage.bucket, Key: storedShot?.storageKey ?? '' }),
      );
    } catch {
      stillThere = false;
    }
    line('the object is gone from r2', !stillThere);
  } finally {
    for (const held of records.documents) {
      await store.remove(held.storageKey).catch(() => undefined);
    }
    store.destroy();
    audit.destroy();
  }
}

await main();
