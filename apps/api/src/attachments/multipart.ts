import busboy from 'busboy';
import type { Request } from 'express';

import { ApiError } from '../http/api-error.js';

export const FILE_FIELD = 'file';
export const MAX_FIELDS = 4;
export const MAX_FIELD_BYTES = 1024;
export const MAX_PARTS = 8;

export interface UploadedFile {
  originalName: string;
  declaredMimeType: string;
  bytes: Buffer;
}

const NOT_MULTIPART = 'Send the file as a multipart form upload.';
const UNREADABLE = 'That upload could not be read.';

export function readSingleUpload(request: Request, maxBytes: number): Promise<UploadedFile> {
  return new Promise<UploadedFile>((resolve, reject) => {
    let parser: ReturnType<typeof busboy>;

    try {
      parser = busboy({
        headers: request.headers,
        defParamCharset: 'utf8',
        limits: {
          files: 1,
          fileSize: maxBytes,
          fields: MAX_FIELDS,
          fieldSize: MAX_FIELD_BYTES,
          parts: MAX_PARTS,
        },
      });
    } catch {
      reject(new ApiError('UNSUPPORTED_MEDIA_TYPE', NOT_MULTIPART));
      return;
    }

    const chunks: Buffer[] = [];
    let total = 0;
    let originalName = '';
    let declaredMimeType = '';
    let sawFile = false;
    let settled = false;

    const stop = (): void => {
      request.unpipe(parser);
      parser.removeAllListeners();
      request.resume();
    };

    const fail = (error: ApiError): void => {
      if (settled) {
        return;
      }
      settled = true;
      stop();
      reject(error);
    };

    const tooLarge = (): void => {
      fail(
        new ApiError(
          'PAYLOAD_TOO_LARGE',
          `That file is larger than the ${String(Math.floor(maxBytes / 1_048_576))} MB limit.`,
        ),
      );
    };

    parser.on('file', (fieldName, stream, info) => {
      if (fieldName !== FILE_FIELD || sawFile) {
        stream.resume();
        return;
      }

      sawFile = true;
      originalName = info.filename;
      declaredMimeType = info.mimeType;

      stream.on('data', (chunk: Buffer) => {
        total += chunk.byteLength;
        if (total > maxBytes) {
          tooLarge();
          return;
        }
        chunks.push(chunk);
      });
      stream.on('limit', tooLarge);
      stream.on('error', () => {
        fail(new ApiError('ATTACHMENT_REJECTED', UNREADABLE));
      });
    });

    parser.on('filesLimit', () => {
      fail(new ApiError('ATTACHMENT_REJECTED', 'Please upload one file at a time.'));
    });

    parser.on('partsLimit', () => {
      fail(new ApiError('ATTACHMENT_REJECTED', UNREADABLE));
    });

    parser.on('error', () => {
      fail(new ApiError('ATTACHMENT_REJECTED', UNREADABLE));
    });

    parser.on('close', () => {
      if (settled) {
        return;
      }

      if (!sawFile) {
        fail(new ApiError('ATTACHMENT_REJECTED', 'No file was included in that upload.'));
        return;
      }

      settled = true;
      resolve({ originalName, declaredMimeType, bytes: Buffer.concat(chunks) });
    });

    request.pipe(parser);
  });
}
