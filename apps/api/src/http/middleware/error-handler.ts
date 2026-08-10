import { ApiErrorBodySchema, type ApiErrorBody, type ErrorCode } from '@nimbus/contracts';
import type { ErrorRequestHandler, Request, Response } from 'express';

import type { Logger } from '../../logging/logger.js';
import { getRequestId, newRequestId } from '../../logging/request-context.js';
import { ApiError, GENERIC_ERROR_MESSAGE, isApiError } from '../api-error.js';

interface BodyParserError {
  type?: string;
  status?: number;
}

function bodyParserType(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }
  const candidate = (error as BodyParserError).type;
  return typeof candidate === 'string' ? candidate : undefined;
}

export function translateError(error: unknown): ApiError {
  if (isApiError(error)) {
    return error;
  }

  switch (bodyParserType(error)) {
    case 'entity.parse.failed':
      return new ApiError('VALIDATION_FAILED', 'The request body is not valid JSON.', {
        cause: error,
      });
    case 'entity.too.large':
      return new ApiError('PAYLOAD_TOO_LARGE', 'The request body is too large.', { cause: error });
    case 'encoding.unsupported':
    case 'charset.unsupported':
      return new ApiError('UNSUPPORTED_MEDIA_TYPE', 'That content encoding is not supported.', {
        cause: error,
      });
    default:
      break;
  }

  return new ApiError('INTERNAL_ERROR', GENERIC_ERROR_MESSAGE, { cause: error });
}

export function buildErrorBody(code: ErrorCode, message: string): ApiErrorBody {
  return ApiErrorBodySchema.parse({
    error: {
      code,
      message,
      requestId: getRequestId() ?? newRequestId(),
    },
  });
}

function describeCause(apiError: ApiError): string {
  const cause = apiError.cause;
  if (cause instanceof Error) {
    return cause.message;
  }
  return apiError.message;
}

function logError(logger: Logger, request: Request, apiError: ApiError): void {
  const common = {
    method: request.method,
    path: request.path,
    statusCode: apiError.status,
    errorCode: apiError.code,
  };

  if (apiError.status >= 500) {
    logger.error({ ...common, err: apiError.cause ?? apiError }, 'Request failed');
    return;
  }

  logger.warn({ ...common, detail: describeCause(apiError) }, 'Request rejected');
}

export function createErrorHandler(logger: Logger): ErrorRequestHandler {
  return (error: unknown, request: Request, response: Response, next): void => {
    const apiError = translateError(error);

    logError(logger, request, apiError);

    if (response.headersSent) {
      next(error);
      return;
    }

    response.status(apiError.status).json(buildErrorBody(apiError.code, apiError.publicMessage));
  };
}
