import { LIMITS, type ErrorCode } from '@nimbus/contracts';

export const ERROR_STATUS: Record<ErrorCode, number> = {
  VALIDATION_FAILED: 400,
  UNAUTHENTICATED: 401,
  SESSION_EXPIRED: 401,
  FORBIDDEN: 403,
  CSRF_TOKEN_INVALID: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  RATE_LIMITED: 429,
  PAYLOAD_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,
  ACCOUNT_DISABLED: 403,
  OTP_INVALID: 400,
  OTP_EXPIRED: 400,
  OTP_ATTEMPTS_EXCEEDED: 429,
  OAUTH_STATE_INVALID: 400,
  GITHUB_NOT_CONNECTED: 409,
  GITHUB_INSTALLATION_SUSPENDED: 409,
  REPOSITORY_NOT_AVAILABLE: 404,
  REPOSITORY_NOT_PUBLIC: 400,
  ACTIVE_SESSION_EXISTS: 409,
  SESSION_NOT_ACTIVE: 409,
  TASK_TOO_BROAD: 400,
  APPROVAL_NOT_FOUND: 404,
  APPROVAL_EXPIRED: 409,
  APPROVAL_MISMATCH: 409,
  ATTACHMENT_REJECTED: 400,
  BUDGET_EXHAUSTED: 429,
  SANDBOX_UNAVAILABLE: 503,
  PROVIDER_UNAVAILABLE: 503,
  AGENT_SESSIONS_DISABLED: 503,
  INTERNAL_ERROR: 500,
};

export const GENERIC_ERROR_MESSAGE = 'Something went wrong. Please try again.';

function safeMessage(message: string): string {
  const trimmed = message.trim();
  if (trimmed === '') {
    return GENERIC_ERROR_MESSAGE;
  }
  return trimmed.length > LIMITS.errorMessageMaxChars
    ? trimmed.slice(0, LIMITS.errorMessageMaxChars)
    : trimmed;
}

export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly publicMessage: string;
  readonly details: Readonly<Record<string, unknown>> | undefined;

  constructor(
    code: ErrorCode,
    message: string,
    options: { cause?: unknown; details?: Record<string, unknown> } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ApiError';
    this.code = code;
    this.status = ERROR_STATUS[code];
    this.publicMessage = safeMessage(message);
    this.details = options.details;
  }
}

export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError;
}

export const badRequest = (message: string, details?: Record<string, unknown>): ApiError =>
  new ApiError('VALIDATION_FAILED', message, details === undefined ? {} : { details });

export const unauthenticated = (message = 'You need to sign in to do that.'): ApiError =>
  new ApiError('UNAUTHENTICATED', message);

export const forbidden = (message = 'You do not have access to that.'): ApiError =>
  new ApiError('FORBIDDEN', message);

export const notFound = (message = 'We could not find what you asked for.'): ApiError =>
  new ApiError('NOT_FOUND', message);

export const conflict = (code: ErrorCode, message: string): ApiError => new ApiError(code, message);

export const internalError = (cause?: unknown): ApiError =>
  new ApiError('INTERNAL_ERROR', GENERIC_ERROR_MESSAGE, cause === undefined ? {} : { cause });
