import {
  AttachmentIdSchema,
  AttachmentUploadResponseSchema,
  type AttachmentMetadata,
} from '@nimbus/contracts';
import { Router } from 'express';

import { readSingleUpload } from '../../attachments/multipart.js';
import { contentDisposition } from '../../attachments/names.js';
import type { DownloadResult } from '../../attachments/service.js';
import type { CsrfChecker } from '../../auth/session-service.js';
import { ApiError } from '../api-error.js';
import { createRequireAuth, createRequireCsrf, requireSession } from '../middleware/session.js';

export const DOWNLOAD_HEADERS: Readonly<Record<string, string>> = {
  'X-Content-Type-Options': 'nosniff',
  'Cache-Control': 'private, no-store',
  'Content-Security-Policy': "default-src 'none'; sandbox",
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Referrer-Policy': 'no-referrer',
};

export interface AttachmentUploader {
  upload(request: {
    userId: string;
    declaredMimeType: string;
    originalName: string;
    bytes: Buffer;
  }): Promise<AttachmentMetadata>;
  download(userId: string, attachmentId: string): Promise<DownloadResult>;
  remove(userId: string, attachmentId: string): Promise<void>;
}

export interface AttachmentsRouterOptions {
  attachments: AttachmentUploader;
  sessions: CsrfChecker;
  maxBytes: number;
}

function readAttachmentId(value: unknown): string {
  const parsed = AttachmentIdSchema.safeParse(value);

  if (!parsed.success) {
    throw new ApiError('NOT_FOUND', 'We could not find that attachment.');
  }

  return parsed.data;
}

export function createAttachmentsRouter(options: AttachmentsRouterOptions): Router {
  const router = Router();
  const requireAuth = createRequireAuth();
  const requireCsrf = createRequireCsrf(options.sessions);

  router.post('/attachments', requireAuth, requireCsrf, async (request, response) => {
    const session = requireSession(request);
    const uploaded = await readSingleUpload(request, options.maxBytes);

    const attachment = await options.attachments.upload({
      userId: session.user.userId,
      declaredMimeType: uploaded.declaredMimeType,
      originalName: uploaded.originalName,
      bytes: uploaded.bytes,
    });

    response.status(201).json(AttachmentUploadResponseSchema.parse({ attachment }));
  });

  router.get('/attachments/:attachmentId', requireAuth, async (request, response) => {
    const session = requireSession(request);
    const attachmentId = readAttachmentId(request.params['attachmentId']);

    const { document, object } = await options.attachments.download(
      session.user.userId,
      attachmentId,
    );

    response.set(DOWNLOAD_HEADERS);
    response.set('Content-Disposition', contentDisposition(document.originalName));
    response.type(document.mimeType);
    response.status(200).send(object.bytes);
  });

  router.delete(
    '/attachments/:attachmentId',
    requireAuth,
    requireCsrf,
    async (request, response) => {
      const session = requireSession(request);
      const attachmentId = readAttachmentId(request.params['attachmentId']);

      await options.attachments.remove(session.user.userId, attachmentId);

      response.status(204).end();
    },
  );

  return router;
}
