export const LLM_ERROR_CODES = [
  'LLM_NOT_CONFIGURED',
  'LLM_MODEL_UNKNOWN',
  'LLM_REQUEST_INVALID',
  'LLM_UNAUTHENTICATED',
  'LLM_RATE_LIMITED',
  'LLM_UNAVAILABLE',
  'LLM_TIMED_OUT',
  'LLM_CANCELLED',
  'LLM_RESPONSE_MALFORMED',
  'LLM_SCHEMA_REFUSED',
  'LLM_CONTENT_REFUSED',
  'LLM_TRUNCATED',
  'LLM_BUDGET_EXCEEDED',
  'LLM_INPUT_TOO_LARGE',
  'LLM_FAILED',
] as const;

export type LlmErrorCode = (typeof LLM_ERROR_CODES)[number];

export const RETRYABLE_CODES: readonly LlmErrorCode[] = [
  'LLM_RATE_LIMITED',
  'LLM_UNAVAILABLE',
  'LLM_TIMED_OUT',
];

export interface LlmErrorOptions {
  cause?: unknown;
  status?: number;
  detail?: string;
  retryAfterMs?: number;
}

export class LlmError extends Error {
  readonly code: LlmErrorCode;

  readonly status: number | null;

  readonly detail: string | null;

  readonly retryAfterMs: number | null;

  constructor(code: LlmErrorCode, message: string, options: LlmErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'LlmError';
    this.code = code;
    this.status = options.status ?? null;
    this.detail = options.detail ?? null;
    this.retryAfterMs = options.retryAfterMs ?? null;
  }

  get retryable(): boolean {
    return RETRYABLE_CODES.includes(this.code);
  }
}

export function isLlmError(value: unknown): value is LlmError {
  return value instanceof LlmError;
}
