import {
  IMAGE_MIME_TYPES,
  LIMITS,
  TEXT_MIME_TYPES,
  type AttachmentKind,
  type AttachmentMetadata,
} from '@nimbus/contracts';

import { ApiError, NetworkError } from '../api/errors.js';

export const ACCEPTED_MIME_TYPES: readonly string[] = [...TEXT_MIME_TYPES, ...IMAGE_MIME_TYPES];

export const ACCEPT_ATTRIBUTE = ACCEPTED_MIME_TYPES.join(',');

export function kindOf(mimeType: string): AttachmentKind | null {
  if ((IMAGE_MIME_TYPES as readonly string[]).includes(mimeType)) {
    return 'image';
  }

  return (TEXT_MIME_TYPES as readonly string[]).includes(mimeType) ? 'text' : null;
}

export function sizeWords(bytes: number): string {
  if (bytes < 1_024) {
    return `${String(bytes)} B`;
  }

  if (bytes < 1_024 * 1_024) {
    return `${String(Math.round(bytes / 1_024))} KB`;
  }

  return `${(bytes / (1_024 * 1_024)).toFixed(1)} MB`;
}

export function refusalFor(
  file: File,
  maxBytes: number = LIMITS.maxAttachmentBytes,
): string | null {
  if (kindOf(file.type) === null) {
    return `${file.name} is not a kind Nimbus accepts. Use a png, jpeg, webp, txt or markdown file.`;
  }

  if (file.size === 0) {
    return `${file.name} is empty.`;
  }

  if (file.size > maxBytes) {
    return `${file.name} is ${sizeWords(file.size)}, over the ${sizeWords(maxBytes)} limit.`;
  }

  return null;
}

export function roomFor(
  held: number,
  wanted: number,
  most: number = LIMITS.maxAttachmentsPerSession,
): number {
  return Math.max(0, Math.min(wanted, most - held));
}

export function uploadProblem(error: unknown): string {
  if (error instanceof NetworkError) {
    return 'That upload did not reach Nimbus. Check your connection and try again.';
  }

  if (!(error instanceof ApiError)) {
    return 'That upload failed. Try again.';
  }

  if (error.code === 'ATTACHMENT_REJECTED') {
    return error.message;
  }

  const known: Partial<Record<string, string>> = {
    PAYLOAD_TOO_LARGE: `That file is over the ${sizeWords(LIMITS.maxAttachmentBytes)} limit.`,
    UNSUPPORTED_MEDIA_TYPE: 'Nimbus only accepts png, jpeg, webp, txt and markdown files.',
    VALIDATION_FAILED: 'Nimbus would not accept that file.',
    RATE_LIMITED: 'Too many uploads at once. Wait a moment and try again.',
  };

  return known[error.code] ?? 'That upload failed. Try again.';
}

export interface HeldAttachment {
  localId: string;
  name: string;
  byteSize: number;
  kind: AttachmentKind;
  previewUrl: string | null;
  progress: number;
  saved: AttachmentMetadata | null;
  problem: string | null;
}

export function isReady(one: HeldAttachment): boolean {
  return one.saved !== null;
}

export function allSettled(held: readonly HeldAttachment[]): boolean {
  return held.every((one) => one.saved !== null || one.problem !== null);
}

export function savedIds(held: readonly HeldAttachment[]): string[] {
  return held.flatMap((one) => (one.saved === null ? [] : [one.saved.attachmentId]));
}
