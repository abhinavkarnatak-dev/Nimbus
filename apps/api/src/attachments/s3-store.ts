import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';

import type { StorageConfig } from '../config/load.js';
import type { AttachmentStore, StoredObject } from './store.js';

export const DOWNLOAD_DISPOSITION = 'attachment';
export const OBJECT_CACHE_CONTROL = 'private, no-store';

const MISSING_CODES = new Set(['NoSuchKey', 'NotFound']);

function isMissing(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const named = error as { name?: unknown; $metadata?: { httpStatusCode?: unknown } };
  if (typeof named.name === 'string' && MISSING_CODES.has(named.name)) {
    return true;
  }
  return named.$metadata?.httpStatusCode === 404;
}

export class S3AttachmentStore implements AttachmentStore {
  private readonly client: S3Client;

  private readonly bucket: string;

  constructor(config: StorageConfig, client?: S3Client) {
    this.bucket = config.bucket;
    this.client =
      client ??
      new S3Client({
        endpoint: config.endpoint,
        region: config.region,
        credentials: {
          accessKeyId: config.accessKeyId,
          secretAccessKey: config.secretAccessKey,
        },
      });
  }

  async put(key: string, bytes: Buffer, contentType: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: bytes,
        ContentType: contentType,
        ContentLength: bytes.byteLength,
        ContentDisposition: DOWNLOAD_DISPOSITION,
        CacheControl: OBJECT_CACHE_CONTROL,
      }),
    );
  }

  async get(key: string): Promise<StoredObject | null> {
    try {
      const found = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      const body = await found.Body?.transformToByteArray();

      if (body === undefined) {
        return null;
      }

      return {
        bytes: Buffer.from(body),
        contentType: found.ContentType ?? 'application/octet-stream',
      };
    } catch (error) {
      if (isMissing(error)) {
        return null;
      }
      throw error;
    }
  }

  async remove(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  destroy(): void {
    this.client.destroy();
  }
}
