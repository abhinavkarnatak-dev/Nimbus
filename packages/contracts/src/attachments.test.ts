import { describe, expect, it } from 'vitest';

import {
  AttachmentMetadataSchema,
  AttachmentMimeTypeSchema,
  IMAGE_MIME_TYPES,
  TEXT_MIME_TYPES,
} from './attachments.js';
import { LIMITS } from './limits.js';
import { attachmentFixture } from './session.fixtures.js';

describe('attachment media types', () => {
  it('accepts the allowlisted text and image types', () => {
    for (const mimeType of [...TEXT_MIME_TYPES, ...IMAGE_MIME_TYPES]) {
      expect(AttachmentMimeTypeSchema.safeParse(mimeType).success).toBe(true);
    }
  });

  it('rejects active content and archives', () => {
    for (const mimeType of [
      'image/svg+xml',
      'text/html',
      'application/zip',
      'application/x-tar',
      'application/gzip',
      'application/pdf',
      'application/javascript',
      'application/octet-stream',
      'image/gif',
    ]) {
      expect(AttachmentMimeTypeSchema.safeParse(mimeType).success).toBe(false);
    }
  });

  it('rejects a media type carrying parameters, which is a classic bypass', () => {
    expect(AttachmentMimeTypeSchema.safeParse('image/png; charset=utf-8').success).toBe(false);
    expect(AttachmentMimeTypeSchema.safeParse('IMAGE/PNG').success).toBe(false);
  });
});

describe('attachment metadata', () => {
  it('accepts the fixture', () => {
    expect(AttachmentMetadataSchema.parse(attachmentFixture())).toEqual(attachmentFixture());
  });

  it('rejects a file at or beyond the size cap', () => {
    expect(
      AttachmentMetadataSchema.safeParse({
        ...attachmentFixture(),
        byteSize: LIMITS.maxAttachmentBytes + 1,
      }).success,
    ).toBe(false);
  });

  it('rejects an empty or negative size', () => {
    for (const byteSize of [0, -1, 1.5]) {
      expect(AttachmentMetadataSchema.safeParse({ ...attachmentFixture(), byteSize }).success).toBe(
        false,
      );
    }
  });

  it('rejects an empty or oversized original name', () => {
    expect(
      AttachmentMetadataSchema.safeParse({ ...attachmentFixture(), originalName: '' }).success,
    ).toBe(false);
    expect(
      AttachmentMetadataSchema.safeParse({
        ...attachmentFixture(),
        originalName: 'a'.repeat(256),
      }).success,
    ).toBe(false);
  });

  it('never exposes a storage path to the client', () => {
    expect(
      AttachmentMetadataSchema.safeParse({ ...attachmentFixture(), storagePath: '/var/uploads/a' })
        .success,
    ).toBe(false);
  });
});
