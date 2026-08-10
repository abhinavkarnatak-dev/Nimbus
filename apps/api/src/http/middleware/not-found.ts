import type { RequestHandler } from 'express';

import { ApiError } from '../api-error.js';

export function createNotFoundHandler(): RequestHandler {
  return (_request, _response, next): void => {
    next(new ApiError('NOT_FOUND', 'That endpoint does not exist.'));
  };
}
