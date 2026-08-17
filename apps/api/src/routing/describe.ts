import { DescribedImageSchema, type CallReport, type DescribedImage } from '@nimbus/contracts';

import type { AttachmentRecords } from '../attachments/repository.js';
import type { AttachmentDocument } from '../db/models/attachment.js';
import { isLlmError } from '../llm/errors.js';
import type { DescribeImageResult, VisionMimeType, VisionProvider } from '../llm/provider.js';
import type { VisionProviderSource } from '../llm/sources.js';
import type { Logger } from '../logging/logger.js';
import { ROUTING_LIMITS } from './limits.js';

export interface ImageBytes {
  read(document: AttachmentDocument): Promise<Buffer>;
}

export interface DescriberOptions {
  vision: VisionProvider;
  records: AttachmentRecords;
  bytes: ImageBytes;
  logger: Logger;
  model?: string;
}

export interface DescribeResult {
  images: DescribedImage[];
  reports: CallReport[];
  skipped: number;
}

export function storedDescription(document: AttachmentDocument): string | null {
  const held = document.description;
  return typeof held === 'string' && held.trim() !== '' ? held : null;
}

export class ImageDescriber {
  private readonly vision: VisionProvider;

  private readonly records: AttachmentRecords;

  private readonly bytes: ImageBytes;

  private readonly logger: Logger;

  private readonly model: string | undefined;

  constructor(options: DescriberOptions) {
    this.vision = options.vision;
    this.records = options.records;
    this.bytes = options.bytes;
    this.logger = options.logger;
    this.model = options.model;
  }

  async describeAll(documents: readonly AttachmentDocument[]): Promise<DescribeResult> {
    const images: DescribedImage[] = [];
    const reports: CallReport[] = [];
    let skipped = 0;

    for (const document of documents.slice(0, ROUTING_LIMITS.imagesMax)) {
      if (document.kind !== 'image') {
        continue;
      }

      const held = storedDescription(document);

      if (held !== null) {
        images.push(
          DescribedImageSchema.parse({
            attachmentId: document.attachmentId,
            name: document.originalName,
            description: held,
            model: document.describedByModel ?? this.vision.defaultModel,
            reused: true,
          }),
        );
        continue;
      }

      const made = await this.describeOne(document);

      if (made === null) {
        skipped += 1;
        continue;
      }
      images.push(made.image);
      reports.push(made.report);
    }

    return { images, reports, skipped };
  }

  private async describeOne(
    document: AttachmentDocument,
  ): Promise<{ image: DescribedImage; report: CallReport } | null> {
    let result: DescribeImageResult;

    try {
      const bytes = await this.bytes.read(document);
      result = await this.vision.describeImage({
        bytes,
        mimeType: document.mimeType as VisionMimeType,
        ...(this.model === undefined ? {} : { model: this.model }),
      });
    } catch (error) {
      this.logger.warn(
        {
          attachmentId: document.attachmentId,
          code: isLlmError(error) ? error.code : 'UNKNOWN',
        },
        'an image could not be described, carrying on without it',
      );
      return null;
    }

    const description = result.description.slice(0, ROUTING_LIMITS.descriptionMaxChars);
    const image = DescribedImageSchema.parse({
      attachmentId: document.attachmentId,
      name: document.originalName,
      description,
      model: result.report.model,
      reused: false,
    });

    await this.records.saveDescription(document.attachmentId, description, result.report.model);
    return { image, report: result.report };
  }
}

export interface DescriberSource {
  for(userId: string): Promise<ImageDescriber | null>;
}

export interface UserImageDescribersOptions {
  vision: VisionProviderSource;
  records: AttachmentRecords;
  bytes: ImageBytes;
  logger: Logger;
}

export class UserImageDescribers implements DescriberSource {
  readonly #options: UserImageDescribersOptions;

  constructor(options: UserImageDescribersOptions) {
    this.#options = options;
  }

  async for(userId: string): Promise<ImageDescriber | null> {
    const vision = await this.#options.vision.for(userId);

    if (vision === null) {
      return null;
    }

    return new ImageDescriber({
      vision,
      records: this.#options.records,
      bytes: this.#options.bytes,
      logger: this.#options.logger,
    });
  }
}

export function fixedDescriber(describer: ImageDescriber | null): DescriberSource {
  return { for: (): Promise<ImageDescriber | null> => Promise.resolve(describer) };
}
