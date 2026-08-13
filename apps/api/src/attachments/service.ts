import { createHash } from 'node:crypto';

import {
  AttachmentMimeTypeSchema,
  LIMITS,
  type AttachmentKind,
  type AttachmentMetadata,
  type AttachmentMimeType,
} from '@nimbus/contracts';
import {
  ATTACHMENT_ID_PREFIX,
  UNCLAIMED_ATTACHMENT_HOURS,
  toUploadedAttachmentMetadata,
  type AttachmentDocument,
} from '../db/models/attachment.js';
import { ApiError } from '../http/api-error.js';
import { newPrefixedId } from '../lib/id.js';
import { rebuildImage } from './image.js';
import { safeOriginalName } from './names.js';
import type { AttachmentRecords } from './repository.js';
import {
  describeRefusedType,
  extensionMatches,
  isImageMimeType,
  isTextMimeType,
  sniffImageType,
} from './sniff.js';
import { storageKey, type AttachmentStore, type StoredObject } from './store.js';
import { checkText } from './text.js';

const ACCEPTED_TYPES = AttachmentMimeTypeSchema.options.join(', ');

export interface UploadRequest {
  userId: string;
  declaredMimeType: string;
  originalName: string;
  bytes: Buffer;
}

export interface DownloadResult {
  document: AttachmentDocument;
  object: StoredObject;
}

export interface AttachmentServiceOptions {
  records: AttachmentRecords;
  store: AttachmentStore;
  maxBytes?: number;
  now?: () => Date;
}

interface PreparedContent {
  bytes: Buffer;
  kind: AttachmentKind;
  width: number | null;
  height: number | null;
}

function checksumOf(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function parseMimeType(declared: string): AttachmentMimeType {
  const parsed = AttachmentMimeTypeSchema.safeParse(declared.split(';')[0]?.trim().toLowerCase());

  if (!parsed.success) {
    throw new ApiError(
      'UNSUPPORTED_MEDIA_TYPE',
      `That file type is not accepted. Please attach one of: ${ACCEPTED_TYPES}.`,
    );
  }

  return parsed.data;
}

export class AttachmentService {
  private readonly records: AttachmentRecords;

  private readonly store: AttachmentStore;

  private readonly maxBytes: number;

  private readonly now: () => Date;

  constructor(options: AttachmentServiceOptions) {
    this.records = options.records;
    this.store = options.store;
    this.maxBytes = options.maxBytes ?? LIMITS.maxAttachmentBytes;
    this.now = options.now ?? ((): Date => new Date());
  }

  private assertSizeWithinLimit(byteSize: number): void {
    if (byteSize > this.maxBytes) {
      throw new ApiError(
        'PAYLOAD_TOO_LARGE',
        `That file is larger than the ${String(Math.floor(this.maxBytes / 1_048_576))} MB limit.`,
      );
    }
  }

  private assertSignatureAgrees(bytes: Buffer, mimeType: AttachmentMimeType): void {
    const refused = describeRefusedType(bytes);

    if (refused !== null) {
      throw new ApiError(
        'UNSUPPORTED_MEDIA_TYPE',
        `That file looks like ${refused}, which is not accepted.`,
      );
    }

    const sniffed = sniffImageType(bytes);

    if (isImageMimeType(mimeType) && sniffed !== mimeType) {
      throw new ApiError(
        'UNSUPPORTED_MEDIA_TYPE',
        'That file does not match the image type it claims to be.',
      );
    }

    if (isTextMimeType(mimeType) && sniffed !== null) {
      throw new ApiError(
        'UNSUPPORTED_MEDIA_TYPE',
        'That file is not text. Please attach it as an image instead.',
      );
    }
  }

  private async prepare(bytes: Buffer, mimeType: AttachmentMimeType): Promise<PreparedContent> {
    if (isImageMimeType(mimeType)) {
      const rebuilt = await rebuildImage(bytes, mimeType);
      return {
        bytes: rebuilt.bytes,
        kind: 'image',
        width: rebuilt.width,
        height: rebuilt.height,
      };
    }

    const checked = checkText(bytes);
    return { bytes: checked.bytes, kind: 'text', width: null, height: null };
  }

  async upload(request: UploadRequest): Promise<AttachmentMetadata> {
    const mimeType = parseMimeType(request.declaredMimeType);
    const originalName = safeOriginalName(request.originalName);

    if (!extensionMatches(mimeType, originalName)) {
      throw new ApiError(
        'UNSUPPORTED_MEDIA_TYPE',
        'The file name does not match the file type it claims to be.',
      );
    }

    if (request.bytes.byteLength === 0) {
      throw new ApiError('ATTACHMENT_REJECTED', 'That file is empty.');
    }

    this.assertSizeWithinLimit(request.bytes.byteLength);
    this.assertSignatureAgrees(request.bytes, mimeType);

    const held = await this.records.countUnclaimed(request.userId);

    if (held >= LIMITS.maxAttachmentsPerSession) {
      throw new ApiError(
        'ATTACHMENT_REJECTED',
        `You can attach at most ${String(LIMITS.maxAttachmentsPerSession)} files. Please remove one first.`,
      );
    }

    const prepared = await this.prepare(request.bytes, mimeType);

    this.assertSizeWithinLimit(prepared.bytes.byteLength);

    const attachmentId = newPrefixedId(ATTACHMENT_ID_PREFIX);
    const key = storageKey(request.userId, attachmentId);
    const createdAt = this.now();

    const document: AttachmentDocument = {
      attachmentId,
      userId: request.userId,
      sessionId: null,
      kind: prepared.kind,
      mimeType,
      byteSize: prepared.bytes.byteLength,
      originalName,
      storageKey: key,
      checksum: checksumOf(prepared.bytes),
      width: prepared.width,
      height: prepared.height,
      createdAt,
      expiresAt: new Date(createdAt.getTime() + UNCLAIMED_ATTACHMENT_HOURS * 60 * 60 * 1000),
    };

    await this.store.put(key, prepared.bytes, mimeType);

    try {
      await this.records.insert(document);
    } catch (error) {
      await this.store.remove(key).catch(() => undefined);
      throw error;
    }

    return toUploadedAttachmentMetadata(document);
  }

  async download(userId: string, attachmentId: string): Promise<DownloadResult> {
    const document = await this.records.findOwned(userId, attachmentId);

    if (document === null) {
      throw new ApiError('NOT_FOUND', 'We could not find that attachment.');
    }

    const object = await this.store.get(document.storageKey);

    if (object === null) {
      throw new ApiError('NOT_FOUND', 'We could not find that attachment.');
    }

    return { document, object };
  }

  async remove(userId: string, attachmentId: string): Promise<void> {
    const document = await this.records.findOwned(userId, attachmentId);

    if (document === null) {
      throw new ApiError('NOT_FOUND', 'We could not find that attachment.');
    }

    await this.store.remove(document.storageKey);
    await this.records.remove(document.attachmentId);
  }

  async removeExpired(limit: number): Promise<string[]> {
    const expired = await this.records.findExpired(this.now(), limit);
    const removed: string[] = [];

    for (const document of expired) {
      await this.store.remove(document.storageKey);
      const deleted = await this.records.remove(document.attachmentId);
      if (deleted) {
        removed.push(document.attachmentId);
      }
    }

    return removed;
  }
}
