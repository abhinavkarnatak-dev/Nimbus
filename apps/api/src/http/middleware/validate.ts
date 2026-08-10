import type { Request, RequestHandler } from 'express';
import type { z } from 'zod';

import { ApiError } from '../api-error.js';

const VALIDATED = Symbol('nimbus.validatedBody');

interface RequestWithValidatedBody extends Request {
  [VALIDATED]?: unknown;
}

export function validateBody(schema: z.ZodType): RequestHandler {
  return (request, _response, next): void => {
    const parsed = schema.safeParse(request.body);

    if (!parsed.success) {
      next(new ApiError('VALIDATION_FAILED', 'Some of what you sent is not valid.'));
      return;
    }

    (request as RequestWithValidatedBody)[VALIDATED] = parsed.data;
    next();
  };
}

export function validatedBody<TSchema extends z.ZodType>(
  request: Request,
  schema: TSchema,
): z.infer<TSchema> {
  const value = (request as RequestWithValidatedBody)[VALIDATED];

  if (value === undefined) {
    throw new ApiError('INTERNAL_ERROR', 'Something went wrong. Please try again.');
  }
  return schema.parse(value);
}
