import { z } from 'zod';

import { AttachmentIdSchema, IsoTimestampSchema } from './ids.js';
import { LIMITS } from './limits.js';

export const TEXT_MIME_TYPES = ['text/plain', 'text/markdown'] as const;
export const IMAGE_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;

export const AttachmentKindSchema = z.enum(['text', 'image']);

export const AttachmentMimeTypeSchema = z.enum([...TEXT_MIME_TYPES, ...IMAGE_MIME_TYPES]);

export const AttachmentMetadataSchema = z.strictObject({
  attachmentId: AttachmentIdSchema,
  kind: AttachmentKindSchema,
  mimeType: AttachmentMimeTypeSchema,
  byteSize: z.int().positive().max(LIMITS.maxAttachmentBytes),
  originalName: z.string().min(1).max(255),
  createdAt: IsoTimestampSchema,
});

export const AttachmentUploadResponseSchema = z.strictObject({
  attachment: AttachmentMetadataSchema,
});

export type AttachmentKind = z.infer<typeof AttachmentKindSchema>;
export type AttachmentMimeType = z.infer<typeof AttachmentMimeTypeSchema>;
export type AttachmentMetadata = z.infer<typeof AttachmentMetadataSchema>;
export type AttachmentUploadResponse = z.infer<typeof AttachmentUploadResponseSchema>;
