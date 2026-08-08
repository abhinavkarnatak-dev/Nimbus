import { z } from 'zod';

import { RequestIdSchema } from './ids.js';
import { LIMITS } from './limits.js';

export const ERROR_CODES = [
  'VALIDATION_FAILED',
  'UNAUTHENTICATED',
  'SESSION_EXPIRED',
  'FORBIDDEN',
  'CSRF_TOKEN_INVALID',
  'NOT_FOUND',
  'CONFLICT',
  'RATE_LIMITED',
  'PAYLOAD_TOO_LARGE',
  'UNSUPPORTED_MEDIA_TYPE',
  'ACCOUNT_DISABLED',
  'OTP_INVALID',
  'OTP_EXPIRED',
  'OTP_ATTEMPTS_EXCEEDED',
  'OAUTH_STATE_INVALID',
  'GITHUB_NOT_CONNECTED',
  'GITHUB_INSTALLATION_SUSPENDED',
  'REPOSITORY_NOT_AVAILABLE',
  'REPOSITORY_NOT_PUBLIC',
  'ACTIVE_SESSION_EXISTS',
  'SESSION_NOT_ACTIVE',
  'TASK_TOO_BROAD',
  'APPROVAL_NOT_FOUND',
  'APPROVAL_EXPIRED',
  'APPROVAL_MISMATCH',
  'ATTACHMENT_REJECTED',
  'BUDGET_EXHAUSTED',
  'SANDBOX_UNAVAILABLE',
  'PROVIDER_UNAVAILABLE',
  'AGENT_SESSIONS_DISABLED',
  'INTERNAL_ERROR',
] as const;

export const ErrorCodeSchema = z.enum(ERROR_CODES);

export const ApiErrorBodySchema = z.strictObject({
  error: z.strictObject({
    code: ErrorCodeSchema,
    message: z.string().min(1).max(LIMITS.errorMessageMaxChars),
    requestId: RequestIdSchema,
  }),
});

export type ErrorCode = z.infer<typeof ErrorCodeSchema>;
export type ApiErrorBody = z.infer<typeof ApiErrorBodySchema>;
