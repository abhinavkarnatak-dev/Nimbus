import type { CallReport, DescribedImage } from '@nimbus/contracts';

import type { AttachmentRecords } from '../attachments/repository.js';
import { decodeUtf8 } from '../attachments/text.js';
import type { AttachmentDocument } from '../db/models/attachment.js';
import type { Logger } from '../logging/logger.js';
import type { AttachedText } from './context.js';
import type { ImageBytes, ImageDescriber } from './describe.js';
import { ROUTING_LIMITS } from './limits.js';

export interface AttachmentOwner {
  userId: string;
  attachmentIds: readonly string[];
}

export interface LoadedAttachments {
  images: readonly DescribedImage[];
  texts: readonly AttachedText[];
  reports: readonly CallReport[];
  lost: number;
}

export const NOTHING_ATTACHED: LoadedAttachments = {
  images: [],
  texts: [],
  reports: [],
  lost: 0,
};

export interface SessionAttachmentsOptions {
  records: AttachmentRecords;
  bytes: ImageBytes;
  describer: ImageDescriber;
  logger: Logger;
}

export class SessionAttachments {
  readonly #records: AttachmentRecords;

  readonly #bytes: ImageBytes;

  readonly #describer: ImageDescriber;

  readonly #logger: Logger;

  constructor(options: SessionAttachmentsOptions) {
    this.#records = options.records;
    this.#bytes = options.bytes;
    this.#describer = options.describer;
    this.#logger = options.logger;
  }

  async load(owner: AttachmentOwner): Promise<LoadedAttachments> {
    if (owner.attachmentIds.length === 0) {
      return NOTHING_ATTACHED;
    }

    const found = await this.#documents(owner);
    const described = await this.#describer.describeAll(
      found.documents.filter((one) => one.kind === 'image'),
    );
    const texts = await this.#texts(found.documents.filter((one) => one.kind === 'text'));

    return {
      images: described.images,
      texts: texts.texts,
      reports: described.reports,
      lost: found.lost + described.skipped + texts.lost,
    };
  }

  async #documents(
    owner: AttachmentOwner,
  ): Promise<{ documents: AttachmentDocument[]; lost: number }> {
    const documents: AttachmentDocument[] = [];
    let lost = 0;

    for (const attachmentId of owner.attachmentIds.slice(0, ROUTING_LIMITS.attachmentsMax)) {
      const document = await this.#records.findOwned(owner.userId, attachmentId);

      if (document === null) {
        lost += 1;
        this.#logger.warn(
          { attachmentId },
          'an attachment on a session no longer exists, the run carries on without it',
        );
        continue;
      }
      documents.push(document);
    }

    return { documents, lost };
  }

  async #texts(
    documents: readonly AttachmentDocument[],
  ): Promise<{ texts: AttachedText[]; lost: number }> {
    const texts: AttachedText[] = [];
    let lost = 0;

    for (const document of documents.slice(0, ROUTING_LIMITS.attachmentsMax)) {
      const contents = await this.#read(document);

      if (contents === null) {
        lost += 1;
        continue;
      }
      texts.push({ name: document.originalName, contents });
    }

    return { texts, lost };
  }

  async #read(document: AttachmentDocument): Promise<string | null> {
    try {
      const bytes = await this.#bytes.read(document);
      return decodeUtf8(bytes).slice(0, ROUTING_LIMITS.attachmentTextMaxChars);
    } catch {
      this.#logger.warn(
        { attachmentId: document.attachmentId },
        'an attached file could not be read, the run carries on without it',
      );
      return null;
    }
  }
}
