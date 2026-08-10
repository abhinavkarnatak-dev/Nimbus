import { RequestIdSchema, type RequestId } from '@nimbus/contracts';
import type { RequestHandler } from 'express';

import { newRequestId, runWithRequestContext } from '../../logging/request-context.js';

export const REQUEST_ID_HEADER = 'x-request-id';

function inboundRequestId(value: unknown): RequestId | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const parsed = RequestIdSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

export function createRequestContextMiddleware(trustInboundId: boolean): RequestHandler {
  return (request, response, next): void => {
    const supplied = trustInboundId
      ? inboundRequestId(request.headers[REQUEST_ID_HEADER])
      : undefined;
    const requestId = supplied ?? newRequestId();

    response.setHeader('X-Request-Id', requestId);

    runWithRequestContext({ requestId }, next);
  };
}
