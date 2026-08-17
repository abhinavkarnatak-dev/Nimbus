import type { z } from 'zod';

import { CSRF_HEADER, type CsrfSource } from './client.js';
import { ApiError, NetworkError, readErrorBody } from './errors.js';

export const UPLOAD_FIELD = 'file';

export interface UploadOptions<T> {
  baseUrl: string;
  path: string;
  csrf: CsrfSource;
  file: File;
  schema: z.ZodType<T>;
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
}

export async function uploadFile<T>(options: UploadOptions<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const request = new XMLHttpRequest();
    const body = new FormData();
    body.append(UPLOAD_FIELD, options.file, options.file.name);

    request.open('POST', `${options.baseUrl}${options.path}`);
    request.withCredentials = true;
    request.setRequestHeader('accept', 'application/json');

    const token = options.csrf.token();

    if (token !== null) {
      request.setRequestHeader(CSRF_HEADER, token);
    }

    request.upload.onprogress = (event): void => {
      if (event.lengthComputable && event.total > 0) {
        options.onProgress?.(event.loaded / event.total);
      }
    };

    request.onerror = (): void => {
      reject(new NetworkError(new Error('the upload could not be sent')));
    };

    request.onabort = (): void => {
      reject(new NetworkError(new Error('the upload was stopped')));
    };

    request.onload = (): void => {
      let payload: unknown;

      try {
        payload = JSON.parse(request.responseText) as unknown;
      } catch {
        payload = null;
      }

      if (request.status < 200 || request.status >= 300) {
        reject(readErrorBody(request.status, payload));
        return;
      }

      const parsed = options.schema.safeParse(payload);

      if (!parsed.success) {
        reject(
          new ApiError({
            code: 'INTERNAL_ERROR',
            message: 'Nimbus sent something this page could not read.',
            status: request.status,
          }),
        );
        return;
      }

      resolve(parsed.data);
    };

    options.signal?.addEventListener('abort', () => {
      request.abort();
    });

    request.send(body);
  });
}
