import type { AttachmentDocument } from '../db/models/attachment.js';
import type { ImageBytes } from './describe.js';

export const OWNER_ID = 'usr_routingroutingrouti';

let counter = 0;

export function attachment(overrides: Partial<AttachmentDocument> = {}): AttachmentDocument {
  counter += 1;
  const suffix = String(counter).padStart(3, '0');

  return {
    attachmentId: `att_routingroutingrout${suffix}`,
    userId: OWNER_ID,
    sessionId: null,
    kind: 'image',
    mimeType: 'image/png',
    byteSize: 1_024,
    originalName: `shot-${suffix}.png`,
    storageKey: `attachments/${OWNER_ID}/${suffix}`,
    checksum: 'a'.repeat(64),
    width: 400,
    height: 200,
    createdAt: new Date('2026-08-14T12:00:00Z'),
    expiresAt: null,
    ...overrides,
  };
}

export function textAttachment(overrides: Partial<AttachmentDocument> = {}): AttachmentDocument {
  return attachment({
    kind: 'text',
    mimeType: 'text/plain',
    originalName: 'build.log',
    width: null,
    height: null,
    ...overrides,
  });
}

export class FakeImageBytes implements ImageBytes {
  readonly reads: string[] = [];

  private readonly failFor: Set<string>;

  constructor(failFor: readonly string[] = []) {
    this.failFor = new Set(failFor);
  }

  async read(document: AttachmentDocument): Promise<Buffer> {
    this.reads.push(document.attachmentId);

    if (this.failFor.has(document.attachmentId)) {
      throw new Error('that image could not be read');
    }
    return await Promise.resolve(Buffer.from(`bytes for ${document.attachmentId}`));
  }
}

export const SAMPLE_TASK = 'the login redirect sends people to the wrong page';

export const SAMPLE_RETRIEVAL = [
  '[nimbus:begin:RetrievalNonce01 kind=file path=src/auth/redirect.ts lines=1-6]',
  'export function redirectAfterLogin(session) {',
  '  return session.returnTo;',
  '}',
  '[nimbus:end:RetrievalNonce01]',
].join('\n');
