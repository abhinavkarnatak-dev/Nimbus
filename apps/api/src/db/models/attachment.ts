import {
  AttachmentKindSchema,
  AttachmentMetadataSchema,
  AttachmentMimeTypeSchema,
  LIMITS,
  type AttachmentKind,
  type AttachmentMetadata,
  type AttachmentMimeType,
} from '@nimbus/contracts';
import type { Collection, Db } from 'mongodb';

import { COLLECTIONS } from '../collections.js';
import { SESSION_ID_PREFIX } from './session.js';
import {
  OBJECT_ID_PROPERTY,
  publicIdPattern,
  toIsoTimestamp,
  type ModelDefinition,
} from './shared.js';
import { USER_ID_PREFIX } from './user.js';

export const ATTACHMENT_ID_PREFIX = 'att';

export const UNCLAIMED_ATTACHMENT_HOURS = 24;

export const STORAGE_KEY_PATTERN = '^attachments/[0-9A-Za-z_-]{1,64}/[0-9A-Za-z_-]{1,64}$';

export const SHA256_PATTERN = '^[0-9a-f]{64}$';

export interface AttachmentDocument {
  attachmentId: string;
  userId: string;
  sessionId: string | null;
  kind: AttachmentKind;
  mimeType: AttachmentMimeType;
  byteSize: number;
  originalName: string;
  storageKey: string;
  checksum: string;
  width: number | null;
  height: number | null;
  createdAt: Date;
  expiresAt: Date | null;
  description?: string | null;
  describedByModel?: string | null;
  describedAt?: Date | null;
}

export const DESCRIPTION_MAX_CHARS = 2_000;

export function attachmentsCollection(db: Db): Collection<AttachmentDocument> {
  return db.collection<AttachmentDocument>(COLLECTIONS.attachments);
}

export function toUploadedAttachmentMetadata(document: AttachmentDocument): AttachmentMetadata {
  return AttachmentMetadataSchema.parse({
    attachmentId: document.attachmentId,
    kind: document.kind,
    mimeType: document.mimeType,
    byteSize: document.byteSize,
    originalName: document.originalName,
    createdAt: toIsoTimestamp(document.createdAt),
  });
}

export const attachmentModel: ModelDefinition = {
  name: COLLECTIONS.attachments,
  validator: {
    $jsonSchema: {
      bsonType: 'object',
      additionalProperties: false,
      required: [
        'attachmentId',
        'userId',
        'sessionId',
        'kind',
        'mimeType',
        'byteSize',
        'originalName',
        'storageKey',
        'checksum',
        'width',
        'height',
        'createdAt',
        'expiresAt',
      ],
      properties: {
        _id: OBJECT_ID_PROPERTY,
        attachmentId: { bsonType: 'string', pattern: publicIdPattern(ATTACHMENT_ID_PREFIX) },
        userId: { bsonType: 'string', pattern: publicIdPattern(USER_ID_PREFIX) },
        sessionId: {
          oneOf: [
            { bsonType: 'string', pattern: publicIdPattern(SESSION_ID_PREFIX) },
            { bsonType: 'null' },
          ],
        },
        kind: { enum: [...AttachmentKindSchema.options] },
        mimeType: { enum: [...AttachmentMimeTypeSchema.options] },
        byteSize: { bsonType: 'number', minimum: 1, maximum: LIMITS.maxAttachmentBytes },
        originalName: { bsonType: 'string', minLength: 1, maxLength: 255 },
        storageKey: { bsonType: 'string', pattern: STORAGE_KEY_PATTERN },
        checksum: { bsonType: 'string', pattern: SHA256_PATTERN },
        width: { bsonType: ['number', 'null'], minimum: 1 },
        height: { bsonType: ['number', 'null'], minimum: 1 },
        createdAt: { bsonType: 'date' },
        expiresAt: { bsonType: ['date', 'null'] },
        description: {
          bsonType: ['string', 'null'],
          minLength: 1,
          maxLength: DESCRIPTION_MAX_CHARS,
        },
        describedByModel: { bsonType: ['string', 'null'], minLength: 1, maxLength: 100 },
        describedAt: { bsonType: ['date', 'null'] },
      },
    },
  },
  indexes: [
    { key: { attachmentId: 1 }, name: 'attachment_id_unique', unique: true },
    { key: { userId: 1, createdAt: -1 }, name: 'attachment_owner_recent' },
    { key: { sessionId: 1 }, name: 'attachment_session' },
    { key: { expiresAt: 1 }, name: 'attachment_expiry' },
  ],
};
