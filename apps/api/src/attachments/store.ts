import { ApiError } from '../http/api-error.js';

export const KEY_PREFIX = 'attachments';

const KEY_SEGMENT = /^[0-9A-Za-z][0-9A-Za-z_-]{0,63}$/;

export interface StoredObject {
  bytes: Buffer;
  contentType: string;
}

export interface AttachmentStore {
  put(key: string, bytes: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<StoredObject | null>;
  remove(key: string): Promise<void>;
}

export function storageKey(userId: string, attachmentId: string): string {
  if (!KEY_SEGMENT.test(userId) || !KEY_SEGMENT.test(attachmentId)) {
    throw new ApiError('INTERNAL_ERROR', 'Something went wrong. Please try again.');
  }
  return `${KEY_PREFIX}/${userId}/${attachmentId}`;
}
