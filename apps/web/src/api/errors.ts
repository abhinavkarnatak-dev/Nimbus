import { ApiErrorBodySchema, type ErrorCode } from '@nimbus/contracts';

export const SIGNED_OUT_CODES: readonly ErrorCode[] = [
  'UNAUTHENTICATED',
  'SESSION_EXPIRED',
  'ACCOUNT_DISABLED',
];

export class ApiError extends Error {
  readonly code: ErrorCode;

  readonly status: number;

  readonly requestId: string | null;

  constructor(options: {
    code: ErrorCode;
    message: string;
    status: number;
    requestId?: string | null;
  }) {
    super(options.message);
    this.name = 'ApiError';
    this.code = options.code;
    this.status = options.status;
    this.requestId = options.requestId ?? null;
  }

  get signedOut(): boolean {
    return SIGNED_OUT_CODES.includes(this.code);
  }
}

export class NetworkError extends Error {
  constructor(cause: unknown) {
    super('Nimbus could not be reached.');
    this.name = 'NetworkError';
    this.cause = cause;
  }
}

export function isApiError(error: unknown, code?: ErrorCode): error is ApiError {
  if (!(error instanceof ApiError)) {
    return false;
  }
  return code === undefined || error.code === code;
}

export function readErrorBody(status: number, body: unknown): ApiError {
  const parsed = ApiErrorBodySchema.safeParse(body);

  if (!parsed.success) {
    return new ApiError({
      code: 'INTERNAL_ERROR',
      message: 'Something went wrong.',
      status,
    });
  }

  return new ApiError({
    code: parsed.data.error.code,
    message: parsed.data.error.message,
    status,
    requestId: parsed.data.error.requestId,
  });
}
